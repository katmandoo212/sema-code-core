import { queryLLM } from '../services/api/queryLLM'
import { normalizeMessagesForAPI, createUserMessage } from './message'
import { getStateManager, MAIN_AGENT_ID } from '../manager/StateManager'
import { getEventBus } from '../events/EventSystem'
import { logInfo, logDebug } from './log'
import { isInterruptedException } from '../types/errors'
import { NULL_TOOL } from './compact'

const BTW_SYSTEM_REMINDER = `<system-reminder>
This is a side question from the user. You must answer this question directly in a single response.

IMPORTANT CONTEXT:
- You are a separate, lightweight agent spawned to answer this one question
- The main agent is NOT interrupted - it continues working independently in the background
- You share the conversation context but are a completely separate instance
- Do NOT reference being interrupted or what you were "previously doing" - that framing is incorrect

CRITICAL CONSTRAINTS:
- You have NO tools available - you cannot read files, run commands, search, or take any actions
- This is a one-off response - there will be no follow-up turns
- You can ONLY provide information based on what you already know from the conversation context
- NEVER say things like "Let me try...", "I'll now...", "Let me check...", or promise to take any action
- If you don't know the answer, say so - do not offer to look it up or investigate

Simply answer the question with the information you have.
</system-reminder>`

/**
 * 处理 btw 旁路问题
 * 读取现有消息历史，使用快速模型回答，不影响主流程状态
 */
export async function handleBtw(question: string): Promise<void> {
  const stateManager = getStateManager()
  const mainAgentState = stateManager.forAgent(MAIN_AGENT_ID)

  // 读取现有消息历史
  const history = mainAgentState.getMessageHistory()

  // 构建带 system-reminder 的用户消息
  const btwMessage = createUserMessage([{
    type: 'text',
    text: `${BTW_SYSTEM_REMINDER}\n\n${question}`,
  }])

  // 拼接消息：先规范化历史（清洗空消息、合并连续user等），再追加 btw 问题
  const messages = [...normalizeMessagesForAPI(history), btwMessage]

  // 创建独立的 AbortController，联动主会话中断
  const abortController = new AbortController()
  const mainAbort = stateManager.currentAbortController
  let abortListener: (() => void) | null = null
  if (mainAbort) {
    abortListener = () => abortController.abort()
    mainAbort.signal.addEventListener('abort', abortListener, { once: true })
  }

  logInfo(`[btw] 开始处理旁路问题: ${question.slice(0, 50)}...`)

  try {
    const response = await queryLLM(
      messages,
      [],     // 无独立系统提示（靠 system-reminder 注入在消息中）
      abortController.signal,
      [NULL_TOOL], // 占位工具，避免历史含 tool 块时部分 provider 报错
      'quick', // 快速模型
      true,   // 禁用 chunk 事件
      true,   // 禁用错误事件
      true    // 禁用 thinking
    )

    const content = response.message.content
      .filter(b => b.type === 'text')
      .map(b => (b as { type: 'text'; text: string }).text)
      .join('\n')

    logDebug(`[btw] 回答完成，长度: ${content.length}`)
    getEventBus().emit('btw:response', { question, content })
  } catch (error) {
    if (!isInterruptedException(error)) {
      logDebug(`[btw] 处理失败: ${error}`)
    }
  } finally {
    if (abortListener && mainAbort) {
      mainAbort.signal.removeEventListener('abort', abortListener)
    }
  }
}
