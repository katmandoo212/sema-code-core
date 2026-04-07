import { randomUUID } from 'crypto'
import { mkdir, readdir, readFile, writeFile } from 'fs/promises'
import { join } from 'path'
import { execFileNoThrow } from './exec'
import { formatSize } from './format'
import * as os from 'os'

// PDF 文件大小限制
export const PDF_MAX_EXTRACT_SIZE = 100 * 1024 * 1024 // 100MB
export const PDF_TARGET_RAW_SIZE = 20 * 1024 * 1024 // 20MB (考虑 base64 编码后约 26MB)
export const PDF_EXTRACT_SIZE_THRESHOLD = 5 * 1024 * 1024 // 5MB
export const PDF_AT_MENTION_INLINE_THRESHOLD = 10 // 超过 10 页需要指定页码范围
export const PDF_MAX_PAGES_PER_READ = 20 // 每次最多读取 20 页

export type PDFError = {
  reason:
    | 'empty'
    | 'too_large'
    | 'password_protected'
    | 'corrupted'
    | 'unknown'
    | 'unavailable'
    | 'python_unavailable'
  message: string
}

export type PDFResult<T> =
  | { success: true; data: T }
  | { success: false; error: PDFError }

/**
 * 读取 PDF 文件并返回 base64 编码的数据
 * @param filePath PDF 文件路径
 * @returns 包含 PDF 数据或结构化错误的结果
 */
export async function readPDF(filePath: string): Promise<
  PDFResult<{
    type: 'pdf'
    file: {
      filePath: string
      base64: string
      originalSize: number
    }
  }>
> {
  try {
    const stats = await import('fs/promises').then(fs => fs.stat(filePath))
    const originalSize = stats.size

    // 检查文件是否为空
    if (originalSize === 0) {
      return {
        success: false,
        error: { reason: 'empty', message: `PDF 文件为空: ${filePath}` },
      }
    }

    // 检查 PDF 是否超过最大大小
    // API 有 32MB 的总请求限制。base64 编码后增大约 33%,
    // 因此 PDF 原始大小必须小于约 20MB 才能留出对话上下文的空间。
    if (originalSize > PDF_TARGET_RAW_SIZE) {
      return {
        success: false,
        error: {
          reason: 'too_large',
          message: `PDF 文件超过允许的最大大小 ${formatSize(PDF_TARGET_RAW_SIZE)}。`,
        },
      }
    }

    const fileBuffer = await readFile(filePath)

    // 验证 PDF 魔术字节 — 拒绝不是真正 PDF 的文件
    // (例如重命名为 .pdf 的 HTML 文件)在它们进入对话上下文之前。
    // 一旦无效的 PDF 文档块进入消息历史,后续的每个
    // API 调用都会失败,返回 400 "The PDF specified was not valid",并且会话
    // 变得无法恢复,除非使用 /clear。
    const header = fileBuffer.subarray(0, 5).toString('ascii')
    if (!header.startsWith('%PDF-')) {
      return {
        success: false,
        error: {
          reason: 'corrupted',
          message: `文件不是有效的 PDF (缺少 %PDF- 头): ${filePath}`,
        },
      }
    }

    const base64 = fileBuffer.toString('base64')

    // 注意:我们无法在不解析 PDF 的情况下检查页数
    // API 会强制执行 100 页的限制,如果超过则返回错误

    return {
      success: true,
      data: {
        type: 'pdf',
        file: {
          filePath,
          base64,
          originalSize,
        },
      },
    }
  } catch (e: unknown) {
    return {
      success: false,
      error: {
        reason: 'unknown',
        message: e instanceof Error ? e.message : String(e),
      },
    }
  }
}

/**
 * 使用 `pdfinfo` (来自 poppler-utils) 获取 PDF 文件的页数。
 * 如果 pdfinfo 不可用或无法确定页数,则返回 `null`。
 */
export async function getPDFPageCount(
  filePath: string,
): Promise<number | null> {
  const { code, stdout } = await execFileNoThrow(
    'pdfinfo',
    [filePath],
    undefined,
    10_000,
  )
  if (code !== 0) {
    return null
  }
  const match = /^Pages:\s+(\d+)/m.exec(stdout)
  if (!match) {
    return null
  }
  const count = parseInt(match[1]!, 10)
  return isNaN(count) ? null : count
}

export type PDFExtractPagesResult = {
  type: 'parts'
  file: {
    filePath: string
    originalSize: number
    count: number
    outputDir: string
  }
}

let pdftoppmAvailable: boolean | undefined
let pythonPdfAvailable: boolean | undefined

/**
 * 重置 pdftoppm 可用性缓存。仅供测试使用。
 */
export function resetPdftoppmCache(): void {
  pdftoppmAvailable = undefined
}

/**
 * 检查是否为 Windows 系统
 */
function isWindows(): boolean {
  return os.platform() === 'win32'
}

/**
 * 检查 Python 和 PyPDF2/pypdf 是否可用
 */
async function isPythonPdfAvailable(): Promise<boolean> {
  if (pythonPdfAvailable !== undefined) return pythonPdfAvailable

  // 尝试导入 pypdf (优先) 或 PyPDF2
  const testScript = `
try:
    import pypdf
    print('pypdf')
except ImportError:
    try:
        import PyPDF2
        print('PyPDF2')
    except ImportError:
        exit(1)
`

  const { code } = await execFileNoThrow('python', ['-c', testScript], undefined, 5000)
  pythonPdfAvailable = code === 0
  return pythonPdfAvailable
}

/**
 * 检查 `pdftoppm` 二进制文件 (来自 poppler-utils) 是否可用。
 * 结果会在进程生命周期内缓存。
 */
export async function isPdftoppmAvailable(): Promise<boolean> {
  if (pdftoppmAvailable !== undefined) return pdftoppmAvailable
  const { code, stderr } = await execFileNoThrow('pdftoppm', ['-v'], undefined, 5000)
  // pdftoppm 将版本信息打印到 stderr 并退出 0 (或在旧版本上有时为 99)
  pdftoppmAvailable = code === 0 || stderr.length > 0
  return pdftoppmAvailable
}

/**
 * 使用 Python (pypdf/PyPDF2) 提取 PDF 文本内容
 */
async function extractPDFTextWithPython(
  filePath: string,
  options?: { firstPage?: number; lastPage?: number },
): Promise<PDFResult<{ text: string; pageCount: number }>> {
  try {
    const pythonScript = `
import sys
import json
import io

# 强制使用 UTF-8 编码输出，避免 Windows 下 GBK 编码问题
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')
sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding='utf-8')

try:
    import pypdf as pdf_lib
except ImportError:
    import PyPDF2 as pdf_lib

try:
    with open(r'${filePath.replace(/\\/g, '\\\\')}', 'rb') as f:
        reader = pdf_lib.PdfReader(f)
        total_pages = len(reader.pages)

        first_page = ${options?.firstPage ?? 1} - 1  # 转为 0 索引
        last_page = ${options?.lastPage ?? 'total_pages'}
        if last_page == float('inf'):
            last_page = total_pages

        # 限制范围
        first_page = max(0, min(first_page, total_pages - 1))
        last_page = min(last_page, total_pages)

        pages_text = []
        for i in range(first_page, last_page):
            try:
                text = reader.pages[i].extract_text()
                pages_text.append(f"--- 第 {i + 1} 页 ---\\n{text}")
            except Exception as e:
                pages_text.append(f"--- 第 {i + 1} 页 (提取失败: {str(e)}) ---")

        result = {
            'text': '\\n\\n'.join(pages_text),
            'pageCount': last_page - first_page,
            'totalPages': total_pages
        }
        print(json.dumps(result, ensure_ascii=False))
except Exception as e:
    print(json.dumps({'error': str(e)}, ensure_ascii=False), file=sys.stderr)
    sys.exit(1)
`

    const { code, stdout, stderr } = await execFileNoThrow(
      'python',
      ['-c', pythonScript],
      undefined,
      120_000,
    )

    if (code !== 0) {
      const errorMsg = stderr || stdout
      if (/password/i.test(errorMsg)) {
        return {
          success: false,
          error: {
            reason: 'password_protected',
            message: 'PDF 受密码保护。请提供未受保护的版本。',
          },
        }
      }
      return {
        success: false,
        error: { reason: 'unknown', message: `Python PDF 提取失败: ${errorMsg}` },
      }
    }

    const result = JSON.parse(stdout)
    if (result.error) {
      return {
        success: false,
        error: { reason: 'unknown', message: result.error },
      }
    }

    return {
      success: true,
      data: {
        text: result.text,
        pageCount: result.pageCount,
      },
    }
  } catch (e: unknown) {
    return {
      success: false,
      error: {
        reason: 'unknown',
        message: e instanceof Error ? e.message : String(e),
      },
    }
  }
}

/**
 * 使用 pdftoppm 提取 PDF 页面为 JPEG 图像。
 * 在输出目录中生成 page-01.jpg, page-02.jpg 等。
 * 这使得可以读取大型 PDF 并适用于所有 API 提供商。
 *
 * @param filePath PDF 文件路径
 * @param options 可选的页面范围 (从 1 开始,包含首尾)
 */
export async function extractPDFPages(
  filePath: string,
  options?: { firstPage?: number; lastPage?: number },
): Promise<PDFResult<PDFExtractPagesResult>> {
  try {
    const stats = await import('fs/promises').then(fs => fs.stat(filePath))
    const originalSize = stats.size

    if (originalSize === 0) {
      return {
        success: false,
        error: { reason: 'empty', message: `PDF 文件为空: ${filePath}` },
      }
    }

    if (originalSize > PDF_MAX_EXTRACT_SIZE) {
      return {
        success: false,
        error: {
          reason: 'too_large',
          message: `PDF 文件超过文本提取允许的最大大小 (${formatSize(PDF_MAX_EXTRACT_SIZE)})。`,
        },
      }
    }

    // Windows 环境优先使用 Python 方案
    if (isWindows()) {
      const pythonAvailable = await isPythonPdfAvailable()
      if (!pythonAvailable) {
        return {
          success: false,
          error: {
            reason: 'python_unavailable',
            message:
              'Windows 环境下需要安装 Python 和 pypdf 库来读取 PDF。请运行: pip install pypdf',
          },
        }
      }

      // 使用 Python 提取文本
      const textResult = await extractPDFTextWithPython(filePath, options)
      if (!textResult.success) {
        return textResult as any
      }

      // 将文本结果转换为文件形式
      const uuid = randomUUID()
      const outputDir = join(os.tmpdir(), `pdf-${uuid}`)
      await mkdir(outputDir, { recursive: true })

      const textFile = join(outputDir, 'content.txt')
      await writeFile(textFile, textResult.data.text, 'utf-8')

      return {
        success: true,
        data: {
          type: 'parts',
          file: {
            filePath,
            originalSize,
            outputDir,
            count: textResult.data.pageCount,
          },
        },
      }
    }

    // 非 Windows 环境使用 pdftoppm
    const available = await isPdftoppmAvailable()
    if (!available) {
      return {
        success: false,
        error: {
          reason: 'unavailable',
          message:
            'pdftoppm 未安装。请安装 poppler-utils (例如 `brew install poppler` 或 `apt-get install poppler-utils`) 以启用 PDF 页面渲染。',
        },
      }
    }

    const uuid = randomUUID()
    const outputDir = join(os.tmpdir(), `pdf-${uuid}`)
    await mkdir(outputDir, { recursive: true })

    // pdftoppm 生成类似 <prefix>-01.jpg, <prefix>-02.jpg 等文件
    const prefix = join(outputDir, 'page')
    const args = ['-jpeg', '-r', '100']
    if (options?.firstPage) {
      args.push('-f', String(options.firstPage))
    }
    if (options?.lastPage && options.lastPage !== Infinity) {
      args.push('-l', String(options.lastPage))
    }
    args.push(filePath, prefix)
    const { code, stderr } = await execFileNoThrow('pdftoppm', args, undefined, 120_000)

    if (code !== 0) {
      if (/password/i.test(stderr)) {
        return {
          success: false,
          error: {
            reason: 'password_protected',
            message: 'PDF 受密码保护。请提供未受保护的版本。',
          },
        }
      }
      if (/damaged|corrupt|invalid/i.test(stderr)) {
        return {
          success: false,
          error: {
            reason: 'corrupted',
            message: 'PDF 文件已损坏或无效。',
          },
        }
      }
      return {
        success: false,
        error: { reason: 'unknown', message: `pdftoppm 失败: ${stderr}` },
      }
    }

    // 读取生成的图像文件并自然排序
    const entries = await readdir(outputDir)
    const imageFiles = entries.filter(f => f.endsWith('.jpg')).sort()
    const pageCount = imageFiles.length

    if (pageCount === 0) {
      return {
        success: false,
        error: {
          reason: 'corrupted',
          message: 'pdftoppm 未生成输出页面。PDF 可能无效。',
        },
      }
    }

    const count = imageFiles.length

    return {
      success: true,
      data: {
        type: 'parts',
        file: {
          filePath,
          originalSize,
          outputDir,
          count,
        },
      },
    }
  } catch (e: unknown) {
    return {
      success: false,
      error: {
        reason: 'unknown',
        message: e instanceof Error ? e.message : String(e),
      },
    }
  }
}

/**
 * 解析 PDF 页面范围字符串 (例如 "1-5", "3", "10-20")
 * @param pages 页面范围字符串
 * @returns 解析后的页面范围或 null (如果无效)
 */
export function parsePDFPageRange(pages: string): {
  firstPage: number
  lastPage: number
} | null {
  const trimmed = pages.trim()

  // 单页: "3"
  if (/^\d+$/.test(trimmed)) {
    const page = parseInt(trimmed, 10)
    if (page < 1) return null
    return { firstPage: page, lastPage: page }
  }

  // 范围: "1-5"
  const rangeMatch = /^(\d+)-(\d+)$/.exec(trimmed)
  if (rangeMatch) {
    const first = parseInt(rangeMatch[1]!, 10)
    const last = parseInt(rangeMatch[2]!, 10)
    if (first < 1 || last < first) return null
    return { firstPage: first, lastPage: last }
  }

  return null
}

/**
 * 检查文件扩展名是否为 PDF
 */
export function isPDFExtension(ext: string): boolean {
  return ext.toLowerCase() === '.pdf'
}

/**
 * 检查当前 API 是否支持 PDF
 * 注意:这是一个简化版本,实际应该检查使用的模型是否支持 PDF
 */
export function isPDFSupported(): boolean {
  // 假设支持 PDF (Sonnet 3.5 v2 及更高版本)
  // 实际应该根据使用的模型来判断
  return true
}
