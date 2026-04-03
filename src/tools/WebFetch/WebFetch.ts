import { z } from 'zod'
import { Tool } from '../base/Tool'
import { TOOL_NAME_FOR_PROMPT, DESCRIPTION } from './prompt'
import {
  applyPromptToMarkdown,
  type FetchedContent,
  getURLMarkdownContent,
  MAX_MARKDOWN_LENGTH,
} from './utils'

const inputSchema = z.strictObject({
  url: z.string().url().describe('The URL to fetch content from'),
  prompt: z.string().describe('The prompt to run on the fetched content'),
})

type Output = {
  bytes: number
  code: number
  codeText: string
  result: string
  durationMs: number
  url: string
}

export const WebFetchTool = {
  name: TOOL_NAME_FOR_PROMPT,
  description() {
    return DESCRIPTION
  },
  inputSchema,
  isReadOnly() {
    return false
  },
  async validateInput({ url }) {
    try {
      new URL(url)
    } catch {
      return {
        result: false,
        message: `Error: Invalid URL "${url}". The URL provided could not be parsed.`,
        errorCode: 1,
      }
    }
    return { result: true }
  },
  genToolResultMessage(data: Output) {
    const sizeKB = (data.bytes / 1024).toFixed(1)
    return {
      title: data.url,
      summary: `Fetched ${data.url} (${sizeKB}KB, HTTP ${data.code})`,
      content: data.result.slice(0, 200) + (data.result.length > 200 ? '...' : ''),
    }
  },
  genToolPermission(input: { url: string; prompt: string }) {
    return {
      title: 'WebFetch',
      content: input.url,
    }
  },
  getDisplayTitle(input?: { url?: string }) {
    if (!input?.url) return 'WebFetch'
    try {
      return new URL(input.url).hostname
    } catch {
      return 'WebFetch'
    }
  },
  async *call({ url, prompt }: { url: string; prompt: string }, agentContext: any) {
    const start = Date.now()
    const { abortController } = agentContext

    const response = await getURLMarkdownContent(url, abortController)

    // 跨域重定向：通知 LLM 重新请求
    if ('type' in response && response.type === 'redirect') {
      const statusText =
        response.statusCode === 301 ? 'Moved Permanently'
        : response.statusCode === 308 ? 'Permanent Redirect'
        : response.statusCode === 307 ? 'Temporary Redirect'
        : 'Found'

      const message = `REDIRECT DETECTED: The URL redirects to a different host.

Original URL: ${response.originalUrl}
Redirect URL: ${response.redirectUrl}
Status: ${response.statusCode} ${statusText}

To complete your request, I need to fetch content from the redirected URL. Please use WebFetch again with these parameters:
- url: "${response.redirectUrl}"
- prompt: "${prompt}"`

      const output: Output = {
        bytes: Buffer.byteLength(message),
        code: response.statusCode,
        codeText: statusText,
        result: message,
        durationMs: Date.now() - start,
        url,
      }

      yield {
        type: 'result' as const,
        data: output,
        resultForAssistant: this.genResultForAssistant(output),
      }
      return
    }

    const { content, bytes, code, codeText, contentType } = response as FetchedContent

    let result: string
    // 对于小型 markdown 内容直接返回，无需 LLM 处理
    if (contentType.includes('text/markdown') && content.length < MAX_MARKDOWN_LENGTH) {
      result = content
    } else {
      result = await applyPromptToMarkdown(prompt, content, abortController.signal)
    }

    const output: Output = {
      bytes,
      code,
      codeText,
      result,
      durationMs: Date.now() - start,
      url,
    }

    yield {
      type: 'result' as const,
      data: output,
      resultForAssistant: this.genResultForAssistant(output),
    }
  },
  genResultForAssistant(output: Output) {
    return output.result
  },
} satisfies Tool<typeof inputSchema, Output>
