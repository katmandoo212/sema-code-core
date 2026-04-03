import { LRUCache } from 'lru-cache'
import { logError } from '../../util/log'
import { makeSecondaryModelPrompt } from './prompt'
import { queryQuick } from '../../services/api/queryLLM'

// ============================================================================
// 常量
// ============================================================================

const MAX_URL_LENGTH = 2000
const MAX_HTTP_CONTENT_LENGTH = 10 * 1024 * 1024 // 10MB
const FETCH_TIMEOUT_MS = 60_000
const MAX_REDIRECTS = 10

export const MAX_MARKDOWN_LENGTH = 100_000

// ============================================================================
// 缓存
// ============================================================================

type CacheEntry = {
  bytes: number
  code: number
  codeText: string
  content: string
  contentType: string
}

const CACHE_TTL_MS = 15 * 60 * 1000 // 15 分钟
const MAX_CACHE_SIZE_BYTES = 50 * 1024 * 1024 // 50MB

const URL_CACHE = new LRUCache<string, CacheEntry>({
  maxSize: MAX_CACHE_SIZE_BYTES,
  ttl: CACHE_TTL_MS,
  sizeCalculation: (entry) => Math.max(1, Buffer.byteLength(entry.content)),
})

export function clearWebFetchCache(): void {
  URL_CACHE.clear()
}

// ============================================================================
// 类型
// ============================================================================

export type FetchedContent = {
  content: string
  bytes: number
  code: number
  codeText: string
  contentType: string
}

export type RedirectInfo = {
  type: 'redirect'
  originalUrl: string
  redirectUrl: string
  statusCode: number
}

// ============================================================================
// URL 验证
// ============================================================================

export function validateURL(url: string): boolean {
  if (url.length > MAX_URL_LENGTH) {
    return false
  }

  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return false
  }

  if (parsed.username || parsed.password) {
    return false
  }

  const parts = parsed.hostname.split('.')
  if (parts.length < 2) {
    return false
  }

  return true
}

// ============================================================================
// 重定向检查
// ============================================================================

export function isPermittedRedirect(originalUrl: string, redirectUrl: string): boolean {
  try {
    const parsedOriginal = new URL(originalUrl)
    const parsedRedirect = new URL(redirectUrl)

    if (parsedRedirect.protocol !== parsedOriginal.protocol) return false
    if (parsedRedirect.port !== parsedOriginal.port) return false
    if (parsedRedirect.username || parsedRedirect.password) return false

    const stripWww = (h: string) => h.replace(/^www\./, '')
    return stripWww(parsedOriginal.hostname) === stripWww(parsedRedirect.hostname)
  } catch {
    return false
  }
}

// ============================================================================
// HTTP 请求（使用 undici）
// ============================================================================

async function fetchWithRedirects(
  url: string,
  signal: AbortSignal,
  depth = 0,
): Promise<{ response: globalThis.Response; finalUrl: string } | RedirectInfo> {
  if (depth > MAX_REDIRECTS) {
    throw new Error(`Too many redirects (exceeded ${MAX_REDIRECTS})`)
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
  const onAbort = () => controller.abort()
  signal.addEventListener('abort', onAbort, { once: true })

  let response: globalThis.Response
  try {
    response = await globalThis.fetch(url, {
      signal: controller.signal,
      redirect: 'manual',
      headers: {
        Accept: 'text/markdown, text/html, */*',
        'User-Agent': 'sema-code-core/1.0 WebFetch',
      },
    })
  } finally {
    clearTimeout(timer)
    signal.removeEventListener('abort', onAbort)
  }

  if ([301, 302, 307, 308].includes(response.status)) {
    const location = response.headers.get('location')
    if (!location) {
      throw new Error('Redirect missing Location header')
    }

    const redirectUrl = new URL(location, url).toString()

    if (isPermittedRedirect(url, redirectUrl)) {
      return fetchWithRedirects(redirectUrl, signal, depth + 1)
    } else {
      return {
        type: 'redirect',
        originalUrl: url,
        redirectUrl,
        statusCode: response.status,
      }
    }
  }

  return { response, finalUrl: url }
}

// ============================================================================
// HTML → Markdown（懒加载 turndown）
// ============================================================================

type TurndownService = { turndown(html: string): string }
let turndownPromise: Promise<TurndownService> | undefined

function getTurndownService(): Promise<TurndownService> {
  if (!turndownPromise) {
    turndownPromise = Promise.resolve().then(() => {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const mod = require('turndown') as any
      const Ctor = mod.default ?? mod
      return new Ctor() as TurndownService
    })
  }
  return turndownPromise
}

// ============================================================================
// 主获取函数
// ============================================================================

export async function getURLMarkdownContent(
  url: string,
  abortController: AbortController,
): Promise<FetchedContent | RedirectInfo> {
  if (!validateURL(url)) {
    throw new Error('Invalid URL')
  }

  const cached = URL_CACHE.get(url)
  if (cached) {
    return { ...cached }
  }

  // HTTP → HTTPS 升级
  let upgradedUrl = url
  try {
    const parsed = new URL(url)
    if (parsed.protocol === 'http:') {
      parsed.protocol = 'https:'
      upgradedUrl = parsed.toString()
    }
  } catch {
    // ignore
  }

  const result = await fetchWithRedirects(upgradedUrl, abortController.signal)

  if ('type' in result && result.type === 'redirect') {
    return result
  }

  const { response } = result as { response: globalThis.Response; finalUrl: string }
  const contentType = response.headers.get('content-type') ?? ''

  // 限制响应体大小
  const arrayBuffer = await response.arrayBuffer()
  const rawBuffer = Buffer.from(arrayBuffer)
  if (rawBuffer.length > MAX_HTTP_CONTENT_LENGTH) {
    throw new Error(`Response too large: ${rawBuffer.length} bytes`)
  }

  const bytes = rawBuffer.length
  const htmlContent = rawBuffer.toString('utf-8')

  let markdownContent: string
  if (contentType.includes('text/html')) {
    try {
      const td = await getTurndownService()
      markdownContent = td.turndown(htmlContent)
    } catch {
      markdownContent = htmlContent
    }
  } else {
    markdownContent = htmlContent
  }

  const entry: CacheEntry = {
    bytes,
    code: response.status,
    codeText: response.statusText,
    content: markdownContent,
    contentType,
  }

  URL_CACHE.set(url, entry)
  return entry
}

// ============================================================================
// 用 LLM 处理 Markdown 内容
// ============================================================================

export async function applyPromptToMarkdown(
  prompt: string,
  markdownContent: string,
  signal: AbortSignal,
): Promise<string> {
  const truncated =
    markdownContent.length > MAX_MARKDOWN_LENGTH
      ? markdownContent.slice(0, MAX_MARKDOWN_LENGTH) + '\n\n[Content truncated due to length...]'
      : markdownContent

  const modelPrompt = makeSecondaryModelPrompt(truncated, prompt)

  let result: Awaited<ReturnType<typeof queryQuick>>
  try {
    result = await queryQuick({
      userPrompt: modelPrompt,
      signal,
    })
  } catch (e) {
    logError(e)
    return 'Failed to process content with model'
  }

  if (signal.aborted) {
    throw new Error('AbortError')
  }

  const { content } = result.message
  if (content.length > 0) {
    const block = content[0]
    if (block && 'text' in block) {
      return block.text
    }
  }

  return 'No response from model'
}
