export const STDOUT_HEAD_TAIL_LINES = 500
export const STDERR_HEAD_TAIL_LINES = 50
const MAX_LINE_LENGTH = 2000

/**
 * 处理 \r（回车符）：模拟终端行为，只保留每行最后一次 \r 后的内容。
 * 进度条等工具用 \r 覆盖同一行，原始内容会变成超长单行，
 * 这里将其还原为终端实际显示的最终状态。
 */
function resolveCarriageReturns(content: string): string {
  return content.split('\n').map(line => {
    if (!line.includes('\r')) return line
    const parts = line.split('\r')
    return parts[parts.length - 1]
  }).join('\n')
}

function truncateLines(lines: string[]): string[] {
  return lines.map(l =>
    l.length > MAX_LINE_LENGTH ? l.slice(0, MAX_LINE_LENGTH) + '...[line truncated]' : l,
  )
}

export function formatOutput(content: string, headTailLines = STDOUT_HEAD_TAIL_LINES, { resolveCR = true }: { resolveCR?: boolean } = {}): {
  totalLines: number
  truncatedContent: string
} {
  const text = resolveCR ? resolveCarriageReturns(content) : content
  const lines = truncateLines(text.split('\n'))
  const totalLines = lines.length

  if (totalLines <= headTailLines * 2) {
    return { totalLines, truncatedContent: lines.join('\n') }
  }

  const firstLines = lines.slice(0, headTailLines)
  const lastLines = lines.slice(-headTailLines)
  const skippedCount = totalLines - headTailLines * 2

  const truncatedContent = [
    ...firstLines,
    `\n... [${skippedCount} lines truncated] ...\n`,
    ...lastLines,
  ].join('\n')

  return { totalLines, truncatedContent }
}
