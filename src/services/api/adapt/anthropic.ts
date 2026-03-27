import Anthropic from '@anthropic-ai/sdk'
import { randomUUID } from 'crypto'
import { UserMessage, AssistantMessage } from '../../../types/message'
import { ModelProfile } from '../../../types/model'
import { Tool } from '../../../tools/base/Tool'
import { buildTools } from '../../../tools/base/tools'
import { logLLMRequest } from '../../../util/logLLM'
import { logDebug, logError } from '../../../util/log'
import { MAIN_QUERY_TEMPERATURE, emitChunkEvent, getChunkEventBus, withStreamTimeout } from './util'

export { MAIN_QUERY_TEMPERATURE }

// --- Types ---

interface StreamParams {
  url: string; // baseURL, e.g. "https://api.anthropic.com"
  headers?: Record<string, string>; // 额外 headers（apiKey 单独传或放 headers 里）
  body: Anthropic.MessageCreateParamsStreaming
}

// --- Core ---

async function streamChat(
  params: StreamParams,
  signal?: AbortSignal,
  emitChunkEvents: boolean = false,
): Promise<Anthropic.Message> {
  const { url, headers = {}, body } = params;

  // 从 headers 里提取 apiKey
  const apiKey =
    headers["x-api-key"] || headers["Authorization"]?.replace("Bearer ", "") || "sk-placeholder";

  const client = new Anthropic({
    apiKey,
    baseURL: url,
    defaultHeaders: headers,
  });

  // --- 累积 stream chunks ---
  let accumulatedText = '';
  let accumulatedThinking = '';
  let thinkingSignature = '';
  const contentBlocks: Anthropic.ContentBlock[] = [];
  let messageId = '';
  let stopReason: Anthropic.Message['stop_reason'] = null;
  let usage: Anthropic.Message['usage'] = {
    input_tokens: 0,
    output_tokens: 0,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
  };

  const eventBus = getChunkEventBus(emitChunkEvents);

  // 使用 stream 方法
  const stream = client.messages.stream({
    ...body,
    stream: true,
  });

  // 监听中断信号，主动终止 stream
  let isAborted = false;
  const abortListener = () => {
    isAborted = true;
    try {
      // 主动中止 stream 的底层控制器
      stream.controller?.abort();
    } catch (e) {
      // 忽略中止时的错误
    }
  };
  signal?.addEventListener('abort', abortListener, { once: true });

  try {
    for await (const event of stream) {
      // 提前检查中断状态，避免处理无用数据
      if (signal?.aborted || isAborted) {
        logDebug('[Anthropic] Stream interrupted, stopping event processing');
        break; // 返回已累积的部分内容，而非抛出异常
      }

      switch (event.type) {
        case 'message_start':
          messageId = event.message.id;
          break;
        case 'content_block_start':
          if (event.content_block.type === 'tool_use') {
            contentBlocks[event.index] = { ...event.content_block, input: '' } as Anthropic.ContentBlock;
          }
          break;
        case 'content_block_delta': {
          const delta = event.delta;
          if (delta.type === 'thinking_delta') {
            accumulatedThinking += delta.thinking;
            if (eventBus) {
              emitChunkEvent(eventBus, 'thinking', messageId, accumulatedThinking, delta.thinking);
            }
          } else if (delta.type === 'text_delta') {
            accumulatedText += delta.text;
            if (eventBus) {
              emitChunkEvent(eventBus, 'text', messageId, accumulatedText, delta.text);
            }
          } else if (delta.type === 'input_json_delta') {
            const block = contentBlocks[event.index] as any;
            if (block && block.type === 'tool_use') {
              block.input = (block.input || '') + delta.partial_json;
            }
          } else if (delta.type === 'signature_delta') {
            thinkingSignature = delta.signature;
          }
          break;
        }
        case 'message_delta':
          stopReason = event.delta.stop_reason;
          if (event.usage) {
            const deltaUsage = event.usage as any;
            usage = {
              input_tokens: deltaUsage.input_tokens || 0,
              output_tokens: deltaUsage.output_tokens || 0,
              cache_creation_input_tokens: deltaUsage.cache_creation_input_tokens || 0,
              cache_read_input_tokens: deltaUsage.cache_read_input_tokens || 0,
            };
          }
          break;
      }
    }
  } catch (error) {
    if (signal?.aborted || isAborted) {
      logDebug('[Anthropic] Stream error during abort, ignoring');
      // 中断时不抛出，返回已累积的部分内容
    } else {
      throw error;
    }
  } finally {
    // 清理监听器
    signal?.removeEventListener('abort', abortListener);
  }

  // --- 构建结果 ---
  const finalContentBlocks: Anthropic.ContentBlock[] = [];

  // 添加 thinking block（如果有）
  if (accumulatedThinking) {
    finalContentBlocks.push({
      type: 'thinking',
      thinking: accumulatedThinking,
      signature: thinkingSignature,
    } as Anthropic.ContentBlock);
  }

  // 添加 text block（如果有）
  if (accumulatedText) {
    finalContentBlocks.push({
      type: 'text',
      text: accumulatedText,
    } as Anthropic.ContentBlock);
  }

  // 添加 tool_use blocks（解析 JSON input）
  // 中断时跳过：流式中断导致参数不完整，无法与合法无参工具调用区分
  if (!signal?.aborted && !isAborted) {
    for (const block of contentBlocks) {
      if (block && block.type === 'tool_use') {
        const toolBlock = block as any;
        let parsedInput: any = {}
        if (typeof toolBlock.input === 'string') {
          try {
            parsedInput = JSON.parse(toolBlock.input || '{}')
          } catch (e) {
            logError(`[Anthropic] 工具调用 JSON 解析失败: ${toolBlock.name}, input: ${toolBlock.input}`)
          }
        } else {
          parsedInput = toolBlock.input
        }
        finalContentBlocks.push({
          type: 'tool_use',
          id: toolBlock.id,
          name: toolBlock.name,
          input: parsedInput,
        } as Anthropic.ContentBlock);
      }
    }
  }

  return {
    id: messageId,
    type: 'message',
    role: 'assistant',
    model: body.model,
    content: finalContentBlocks,
    stop_reason: stopReason,
    stop_sequence: null,
    usage,
  };
}

// ============================================================================
// Anthropic 实现
// ============================================================================

export async function queryAnthropic(
  messages: (UserMessage | AssistantMessage)[],
  systemPromptContent: Array<{ type: 'text', text: string }>,
  tools: Tool[],
  signal: AbortSignal,
  modelProfile: ModelProfile,
  enableThinking: boolean,
  emitChunkEvents: boolean,
): Promise<AssistantMessage> {
  const start = Date.now()
  const baseURL = modelProfile.baseURL || 'https://api.anthropic.com'

  // 构建 header
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  }
  const apiKey = modelProfile.apiKey
  if (apiKey) {
    headers['x-api-key'] = apiKey
  }

  // 构建消息列表
  const anthropicMessages = buildAnthropicMessages(messages, enableThinking)

  // 转换工具定义
  const anthropicTools = tools.length > 0 ? buildTools(tools) : undefined

  // 构建请求参数
  const requestBody: StreamParams['body'] = {
    model: modelProfile.modelName,
    messages: anthropicMessages,
    system: systemPromptContent,
    max_tokens: modelProfile.maxTokens,
    temperature: MAIN_QUERY_TEMPERATURE,
    stream: true,
    ...(anthropicTools && { tools: anthropicTools }),
  }

  // 如果启用了 thinking，添加相关参数
  if (enableThinking) {
    requestBody.thinking = {
      type: 'enabled',
      budget_tokens: Math.min(Math.floor(modelProfile.maxTokens / 2) || 8000, 4000)
    }
  }

  logLLMRequest(requestBody)

  // 统一使用 streamChat 处理请求（合并超时信号，最长等待 5 分钟）
  const { signal: streamSignal, cleanup } = withStreamTimeout(signal)
  let parsedMessage: Anthropic.Message
  try {
    parsedMessage = await streamChat({
      url: baseURL,
      headers,
      body: requestBody,
    }, streamSignal, emitChunkEvents)
  } finally {
    cleanup()
  }

  const durationMs = Date.now() - start

  // 转换为 AssistantMessage
  return convertToAssistantMessage(parsedMessage, durationMs)
}

function buildAnthropicMessages(
  messages: (UserMessage | AssistantMessage)[],
  enableThinking: boolean = false,
): Anthropic.MessageParam[] {
  const result: Anthropic.MessageParam[] = []

  messages.forEach(message => {
    const role = message.message.role as 'user' | 'assistant'
    const content = message.message.content

    if (Array.isArray(content)) {
      // 启用 thinking 时，必须保留 assistant 消息中的 thinking block，否则 API 会报错
      // 未启用 thinking 时，需要过滤掉 thinking block
      const filteredContent = enableThinking
        ? content
        : content.filter((block: any) => block.type !== 'thinking')
      if (filteredContent.length > 0) {
        result.push({
          role,
          content: filteredContent,
        })
      }
    } else {
      result.push({
        role,
        content: content,
      })
    }
  })

  logDebug(`转换后的 Anthropic Messages: ${JSON.stringify(result, null, 2)}`)
  return result
}

/**
 * 将 Anthropic.Message 转换为 AssistantMessage
 */
function convertToAssistantMessage(
  message: Anthropic.Message,
  durationMs: number
): AssistantMessage {
  return {
    type: 'assistant',
    uuid: randomUUID(),
    durationMs,
    message,
  }
}
