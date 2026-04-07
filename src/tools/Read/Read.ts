import { relative, extname } from 'node:path'
import * as fs from 'node:fs'
import { readFile as readFileAsync } from 'node:fs/promises'
import { z } from 'zod'
import { Tool } from '../base/Tool'
import {
  addLineNumbers,
  findSimilarFile,
  normalizeFilePath,
  readTextContent,
} from '../../util/file'
import { getCwd } from '../../util/cwd'
import { TOOL_NAME_FOR_PROMPT, DESCRIPTION, MAX_LINES_TO_READ } from './prompt'
import { secureFileService } from '../../util/secureFile'
import { getStateManager } from '../../manager/StateManager'
import { readNotebook, formatNotebookCells } from '../../util/notebook'
import { NotebookCellData } from '../../types/notebook'
import { logDebug, logWarn, logInfo } from '../../util/log'
import { compressImage } from '../../util/imageCompress'
import {
  readPDF,
  extractPDFPages,
  getPDFPageCount,
  parsePDFPageRange,
  isPDFExtension,
  isPDFSupported,
  PDF_AT_MENTION_INLINE_THRESHOLD,
  PDF_MAX_PAGES_PER_READ,
  PDF_EXTRACT_SIZE_THRESHOLD,
} from '../../util/pdf'
import { formatSize as formatFileSize } from '../../util/format'

const MAX_LINES_TO_RENDER = 5
const MAX_OUTPUT_SIZE = 2 * 1024 * 1024 // 2MB in bytes
export const DOC_NOT_SUPPORTED_MESSAGE = `DOC/DOCX files are not supported for direct reading. Please use the Bash tool to extract text content:

For .docx files (recommended):
  python -c "import zipfile,xml.etree.ElementTree as ET; root=ET.parse(zipfile.ZipFile('your_file.docx').open('word/document.xml')).getroot(); ns='http://schemas.openxmlformats.org/wordprocessingml/2006/main'; [print(''.join(t.text for t in p.iter(f'{{{ns}}}t') if t.text)) for p in root.iter(f'{{{ns}}}p')]"

For .doc files on Windows:
  python -c "import win32com.client; w=win32com.client.Dispatch('Word.Application'); w.Visible=False; d=w.Documents.Open(r'C:\\\\full\\\\path\\\\to\\\\your_file.doc'); print(d.Content.Text); d.Close(); w.Quit()"
  Note: Requires pywin32 (install with: pip install pywin32)

For .doc files on Linux/Mac:
  soffice --headless --convert-to txt your_file.doc
  Note: Requires LibreOffice`

const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp'])
const IMAGE_MEDIA_TYPES: Record<string, 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp'> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
}

const inputSchema = z.strictObject({
  file_path: z.string({
    required_error: 'Error: The Read tool requires a \'file_path\' parameter to specify which file to read. Please provide the absolute path to the file you want to view. For example: {"file_path": "/path/to/file.txt"}',
  }).describe('The absolute path to the file to read'),
  offset: z
    .number()
    .optional()
    .describe(
      'The line number to start reading from. Only provide if the file is too large to read at once',
    ),
  limit: z
    .number()
    .optional()
    .describe(
      'The number of lines to read. Only provide if the file is too large to read at once.',
    ),
  pages: z
    .string()
    .optional()
    .describe(
      'Page range for PDF files (e.g., "1-5", "3", "10-20"). Only applicable to PDF files. Maximum 20 pages per request.',
    ),
})

export const FileReadTool = {
  name: TOOL_NAME_FOR_PROMPT,
  description() {
    return DESCRIPTION
  },
  inputSchema,
  isReadOnly() {
    return true
  },
  genToolResultMessage(data) {
    // 处理图片文件
    if (data.type === 'image') {
      const relativePath = relative(getCwd(), data.image.filePath)
      return {
        title: relativePath,
        summary: `Read image ${relativePath}`,
        content: '',
      }
    }

    // 处理 notebook 文件
    if (data.type === 'notebook') {
      const { filePath, cellCount } = data.notebook
      const cellText = cellCount === 1 ? 'cell' : 'cells'
      return {
        title: relative(getCwd(), filePath),
        summary: `Read ${relative(getCwd(), filePath)} with ${cellCount} ${cellText}`,
        content: ''
      }
    }

    // 处理 PDF 文件
    if (data.type === 'pdf') {
      const relativePath = relative(getCwd(), data.pdf.filePath)
      return {
        title: relativePath,
        summary: `Read PDF ${relativePath} (${formatFileSize(data.pdf.originalSize)})`,
        content: '',
      }
    }

    // 处理 PDF 提取页面
    if (data.type === 'pdf_parts') {
      const relativePath = relative(getCwd(), data.pdfParts.filePath)
      const contentPreview = data.pdfParts.textContent
        ? data.pdfParts.textContent.split('\n').slice(0, 3).join('\n')
        : ''
      return {
        title: relativePath,
        summary: `Read ${data.pdfParts.count} pages from PDF ${relativePath}`,
        content: contentPreview ? contentPreview + '\n...' : '',
      }
    }

    // 处理普通文本文件
    const { filePath, content, numLines, startLine, totalLines } = data.file
    const contentWithFallback = content || '(No content)'
    const lines = contentWithFallback.split('\n')
    const previewLines = lines.slice(0, MAX_LINES_TO_RENDER)
    let preview = previewLines.join('\n')

    if (numLines > MAX_LINES_TO_RENDER) {
      preview += `\n... (+${numLines - MAX_LINES_TO_RENDER} more lines)`
    }

    const lineText = numLines === 1 ? 'line' : 'lines'
    const relativePath = relative(getCwd(), filePath)

    // 部分读取时，标题显示行号范围
    const isPartialRead = startLine > 1 || numLines < totalLines
    const endLine = startLine + numLines - 1
    const title = isPartialRead
      ? `${relativePath}:${startLine}-${endLine}`
      : relativePath

    return {
      title,
      summary: `Read ${relativePath} with ${numLines} ${lineText}`,
      content: preview
    }
  },
  async validateInput({ file_path, offset, limit, pages }, agentContext: any) {
    // 验证 pages 参数 (纯字符串解析,无 I/O)
    if (pages !== undefined) {
      const parsed = parsePDFPageRange(pages)
      if (!parsed) {
        return {
          result: false,
          message: `Invalid pages parameter: "${pages}". Use formats like "1-5", "3", or "10-20". Pages are 1-indexed.`,
        }
      }
      const rangeSize =
        parsed.lastPage === Infinity
          ? PDF_MAX_PAGES_PER_READ + 1
          : parsed.lastPage - parsed.firstPage + 1
      if (rangeSize > PDF_MAX_PAGES_PER_READ) {
        return {
          result: false,
          message: `Page range "${pages}" exceeds maximum of ${PDF_MAX_PAGES_PER_READ} pages per request. Please use a smaller range.`,
        }
      }
    }

    const fullFilePath = normalizeFilePath(file_path)

    // Use secure file service to check if file exists and get file info
    const fileCheck = secureFileService.safeGetFileInfo(fullFilePath)
    if (!fileCheck.success) {
      // Use the actual error from secureFileService instead of generic message
      let message = fileCheck.error || 'File access failed.'

      // If it's a path restriction error, provide helpful information
      if (message.includes('outside allowed directories')) {
        // Get current allowed paths for debuggingS
        const allowedPaths = [
          `Current working directory: ${getCwd()}`,
          `User home directory: ${require('os').homedir()}`,
          `Temporary directories: /tmp, /var/tmp`
        ]

        logWarn('ReadTool: File access denied')
        logDebug(`Requested path: ${fullFilePath}`)
        logDebug('Currently allowed base paths:')
        allowedPaths.forEach(path => logDebug(`  - ${path}`))

        message += '\n\nCurrently allowed base paths:\n' + allowedPaths.map(p => `  - ${p}`).join('\n')
      } else {
        // For other errors (like actual file not found), try to find similar files
        const similarFilename = findSimilarFile(fullFilePath)
        if (similarFilename) {
          message += ` Did you mean ${similarFilename}?`
        }
      }

      return {
        result: false,
        message,
      }
    }

    const stats = fileCheck.stats!
    const fileSize = stats.size

    // DOC/DOCX files should be read via Bash tool
    const lowerExtForDoc = extname(fullFilePath).toLowerCase()
    if (lowerExtForDoc === '.doc' || lowerExtForDoc === '.docx') {
      return {
        result: false,
        message: DOC_NOT_SUPPORTED_MESSAGE,
      }
    }

    // If file is too large and no offset/limit provided (skip check for images and PDFs)
    const isImageFile = IMAGE_EXTENSIONS.has(extname(fullFilePath).toLowerCase())
    const isPDFFile = isPDFExtension(extname(fullFilePath))
    if (!isImageFile && !isPDFFile && fileSize > MAX_OUTPUT_SIZE && !offset && !limit) {
      return {
        result: false,
        message: formatFileSizeError(fileSize),
        meta: { fileSize },
      }
    }

    return { result: true }
  },
  async *call(
    { file_path, offset = 1, limit = MAX_LINES_TO_READ, pages },
    agentContext: any,
  ) {
    const fullFilePath = normalizeFilePath(file_path)
    const stateManager = getStateManager()
    const agentState = stateManager.forAgent(agentContext.agentId)

    // Update read timestamp, to invalidate stale writes
    agentState.setReadFileTimestamp(fullFilePath, Date.now())

    // 检测是否为 notebook 文件
    const fileExtension = extname(fullFilePath)

    // DOC/DOCX files are not supported for direct reading
    if (fileExtension.toLowerCase() === '.doc' || fileExtension.toLowerCase() === '.docx') {
      throw new Error(DOC_NOT_SUPPORTED_MESSAGE)
    }

    // --- PDF ---
    if (isPDFExtension(fileExtension)) {
      if (pages) {
        const parsedRange = parsePDFPageRange(pages)
        const extractResult = await extractPDFPages(
          fullFilePath,
          parsedRange ?? undefined,
        )
        if (!extractResult.success) {
          throw new Error(extractResult.error.message)
        }

        // 读取提取的图像文件
        const path = require('path')
        const fs = require('fs/promises')
        const entries = await fs.readdir(extractResult.data.file.outputDir)
        const imageFiles = entries.filter((f: string) => f.endsWith('.jpg')).sort()

        // 检查是否有文本文件 (Python 提取方案)
        const textFile = path.join(extractResult.data.file.outputDir, 'content.txt')
        let textContent: string | undefined
        try {
          textContent = await fs.readFile(textFile, 'utf-8')
        } catch {
          // 没有文本文件,说明是图像提取方案
        }

        const data = {
          type: 'pdf_parts' as const,
          pdfParts: {
            filePath: file_path,
            originalSize: extractResult.data.file.originalSize,
            count: extractResult.data.file.count,
            outputDir: extractResult.data.file.outputDir,
            imageFiles,
            textContent,
          },
        }

        yield {
          type: 'result',
          data,
          resultForAssistant: this.genResultForAssistant(data),
        }
        return
      }

      const pageCount = await getPDFPageCount(fullFilePath)
      if (pageCount !== null && pageCount > PDF_AT_MENTION_INLINE_THRESHOLD) {
        throw new Error(
          `This PDF has ${pageCount} pages, which is too many to read at once. ` +
            `Use the pages parameter to read specific page ranges (e.g., pages: "1-5"). ` +
            `Maximum ${PDF_MAX_PAGES_PER_READ} pages per request.`,
        )
      }

      const stats = fs.statSync(fullFilePath)
      const shouldExtractPages =
        !isPDFSupported() || stats.size > PDF_EXTRACT_SIZE_THRESHOLD

      if (shouldExtractPages) {
        const extractResult = await extractPDFPages(fullFilePath)
        if (extractResult.success) {
          logInfo(`PDF page extraction succeeded: ${extractResult.data.file.count} pages`)
        } else {
          logWarn(`PDF page extraction failed: ${extractResult.error.message}`)
        }
      }

      if (!isPDFSupported()) {
        throw new Error(
          'Reading full PDFs is not supported with this model. Use a newer model (Sonnet 3.5 v2 or later), ' +
            `or use the pages parameter to read specific page ranges (e.g., pages: "1-5", maximum ${PDF_MAX_PAGES_PER_READ} pages per request). ` +
            'Page extraction requires poppler-utils: install with `brew install poppler` on macOS or `apt-get install poppler-utils` on Debian/Ubuntu.',
        )
      }

      const readResult = await readPDF(fullFilePath)
      if (!readResult.success) {
        throw new Error(readResult.error.message)
      }

      const pdfData = readResult.data
      const data = {
        type: 'pdf' as const,
        pdf: pdfData.file,
      }

      yield {
        type: 'result',
        data,
        resultForAssistant: this.genResultForAssistant(data),
      }
      return
    }

    // 检测是否为图片文件
    const lowerExt = fileExtension.toLowerCase()
    if (IMAGE_EXTENSIONS.has(lowerExt)) {
      const imageBuffer = fs.readFileSync(fullFilePath)
      const mediaType = IMAGE_MEDIA_TYPES[lowerExt]

      let imageData: string
      let finalMediaType: typeof mediaType

      if (imageBuffer.length > MAX_OUTPUT_SIZE) {
        if (mediaType === 'image/gif') {
          throw new Error(formatFileSizeError(imageBuffer.length))
        }
        logWarn(`ReadTool: image size ${Math.round(imageBuffer.length / 1024)}KB exceeds limit ${Math.round(MAX_OUTPUT_SIZE / 1024)}KB, compressing...`)
        let compressed: Awaited<ReturnType<typeof compressImage>>
        try {
          compressed = await compressImage(imageBuffer, mediaType, MAX_OUTPUT_SIZE)
        } catch (e: any) {
          throw new Error(formatFileSizeError(imageBuffer.length))
        }
        const compressedBytes = Math.ceil(compressed.data.length * 3 / 4)
        if (compressedBytes > MAX_OUTPUT_SIZE) {
          throw new Error(formatFileSizeError(compressedBytes))
        }
        imageData = compressed.data
        finalMediaType = compressed.media_type
      } else {
        imageData = imageBuffer.toString('base64')
        finalMediaType = mediaType
      }

      const data = {
        type: 'image' as const,
        image: {
          filePath: file_path,
          data: imageData,
          media_type: finalMediaType,
        },
      }

      yield {
        type: 'result',
        data,
        resultForAssistant: this.genResultForAssistant(data),
      }
      return
    }

    if (fileExtension === '.ipynb') {
      // 读取并解析 notebook 文件
      const { cells, cellCount } = readNotebook(fullFilePath)

      const data = {
        type: 'notebook' as const,
        notebook: {
          filePath: file_path,
          cells,
          cellCount,
        },
      }

      yield {
        type: 'result',
        data,
        resultForAssistant: this.genResultForAssistant(data),
      }
      return
    }

    // 处理普通文本文件
    // Handle offset properly - if offset is 0, don't subtract 1
    const lineOffset = offset === 0 ? 0 : offset - 1
    const { content, lineCount, totalLines } = readTextContent(
      fullFilePath,
      lineOffset,
      limit,
    )

    // Add size validation after reading
    if (content.length > MAX_OUTPUT_SIZE) {
      throw new Error(formatFileSizeError(content.length))
    }

    const data = {
      type: 'text' as const,
      file: {
        filePath: file_path,
        content: content,
        numLines: lineCount,
        startLine: offset,
        totalLines,
      },
    }

    yield {
      type: 'result',
      data,
      resultForAssistant: this.genResultForAssistant(data),
    }
  },
  genResultForAssistant(data) {
    // 处理图片文件
    if (data.type === 'image') {
      return [
        {
          type: 'image' as const,
          source: {
            type: 'base64' as const,
            data: data.image.data,
            media_type: data.image.media_type,
          },
        },
      ]
    }

    // 处理 notebook 文件
    if (data.type === 'notebook') {
      return formatNotebookCells(data.notebook.cells)
    }

    // 处理 PDF 文件 (完整 PDF)
    // 注意:由于类型限制,这里返回 PDF 元数据作为文本
    if (data.type === 'pdf') {
      return `PDF file read: ${data.pdf.filePath} (${formatFileSize(data.pdf.originalSize)})\nBase64 data: ${data.pdf.base64.substring(0, 100)}...`
    }

    // 处理 PDF 提取页面 (图像或文本)
    if (data.type === 'pdf_parts') {
      // 如果有文本内容,返回文本
      if (data.pdfParts.textContent) {
        return data.pdfParts.textContent
      }

      // 否则返回图像
      const path = require('path')
      const fs = require('fs')
      return data.pdfParts.imageFiles.map(f => {
        const imgPath = path.join(data.pdfParts.outputDir, f)
        const imgBuffer = fs.readFileSync(imgPath)
        return {
          type: 'image' as const,
          source: {
            type: 'base64' as const,
            media_type: 'image/jpeg' as const,
            data: imgBuffer.toString('base64'),
          },
        }
      })
    }

    // 处理普通文本文件
    return addLineNumbers(data.file)
  },
} satisfies Tool<
  typeof inputSchema,
  | {
      type: 'text'
      file: {
        filePath: string
        content: string
        numLines: number
        startLine: number
        totalLines: number
      }
    }
  | {
      type: 'notebook'
      notebook: {
        filePath: string
        cells: NotebookCellData[]
        cellCount: number
      }
    }
  | {
      type: 'image'
      image: {
        filePath: string
        data: string
        media_type: 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp'
      }
    }
  | {
      type: 'pdf'
      pdf: {
        filePath: string
        base64: string
        originalSize: number
      }
    }
  | {
      type: 'pdf_parts'
      pdfParts: {
        filePath: string
        originalSize: number
        count: number
        outputDir: string
        imageFiles: string[]
        textContent?: string
      }
    }
>

const formatSize = (bytes: number) =>
  bytes > 1024 * 1024
    ? `${(bytes / (1024 * 1024)).toFixed(1)}M`
    : `${Math.round(bytes / 1024)}KB`

const formatFileSizeError = (sizeInBytes: number) =>
  `File content (${formatSize(sizeInBytes)}) exceeds maximum allowed size (${formatSize(MAX_OUTPUT_SIZE)}). Please use offset and limit parameters to read specific portions of the file, or use the GrepTool to search for specific content.`
