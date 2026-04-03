import { relative, extname } from 'node:path'
import * as fs from 'node:fs'
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

const MAX_LINES_TO_RENDER = 5
const MAX_OUTPUT_SIZE = 2 * 1024 * 1024 // 2MB in bytes
export const PDF_NOT_SUPPORTED_MESSAGE = 'PDF files are not supported for direct reading. Please use the Bash tool with pdftotext command to read content page by page.'
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
  async validateInput({ file_path, offset, limit }, agentContext: any) {
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

    // PDF files should be read via Bash tool with pdftotext
    if (extname(fullFilePath).toLowerCase() === '.pdf') {
      return {
        result: false,
        message: PDF_NOT_SUPPORTED_MESSAGE,
      }
    }

    // DOC/DOCX files should be read via Bash tool
    const lowerExtForDoc = extname(fullFilePath).toLowerCase()
    if (lowerExtForDoc === '.doc' || lowerExtForDoc === '.docx') {
      return {
        result: false,
        message: DOC_NOT_SUPPORTED_MESSAGE,
      }
    }

    // If file is too large and no offset/limit provided (skip check for images)
    const isImageFile = IMAGE_EXTENSIONS.has(extname(fullFilePath).toLowerCase())
    if (!isImageFile && fileSize > MAX_OUTPUT_SIZE && !offset && !limit) {
      return {
        result: false,
        message: formatFileSizeError(fileSize),
        meta: { fileSize },
      }
    }

    return { result: true }
  },
  async *call(
    { file_path, offset = 1, limit = MAX_LINES_TO_READ },
    agentContext: any,
  ) {
    const fullFilePath = normalizeFilePath(file_path)
    const stateManager = getStateManager()
    const agentState = stateManager.forAgent(agentContext.agentId)

    // Update read timestamp, to invalidate stale writes
    agentState.setReadFileTimestamp(fullFilePath, Date.now())

    // 检测是否为 notebook 文件
    const fileExtension = extname(fullFilePath)

    // PDF files are not supported for direct reading
    if (fileExtension.toLowerCase() === '.pdf') {
      throw new Error(PDF_NOT_SUPPORTED_MESSAGE)
    }

    // DOC/DOCX files are not supported for direct reading
    if (fileExtension.toLowerCase() === '.doc' || fileExtension.toLowerCase() === '.docx') {
      throw new Error(DOC_NOT_SUPPORTED_MESSAGE)
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
>

const formatSize = (bytes: number) =>
  bytes > 1024 * 1024
    ? `${(bytes / (1024 * 1024)).toFixed(1)}M`
    : `${Math.round(bytes / 1024)}KB`

const formatFileSizeError = (sizeInBytes: number) =>
  `File content (${formatSize(sizeInBytes)}) exceeds maximum allowed size (${formatSize(MAX_OUTPUT_SIZE)}). Please use offset and limit parameters to read specific portions of the file, or use the GrepTool to search for specific content.`
