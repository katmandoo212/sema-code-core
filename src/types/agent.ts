import type { Tool } from '../tools/base/Tool'

export type AgentScope = 'user' | 'project' | 'builtin'

export interface AgentConfig {
  name: string
  description: string
  tools: string[] | '*'  // 默认 '*' 
  model: string  // haiku quick 对应 quick ，其他值均对应 main
  prompt: string
  locate?: AgentScope
  from?: string
  filePath?: string
}

/**
 * 代理上下文
 * 包含代理执行所需的所有上下文信息
 */
export interface AgentContext {
  /** 代理 ID（主代理为 MAIN_AGENT_ID，子代理为 taskId） */
  agentId: string
  abortController: AbortController
  tools: Tool[]
  /** 模型类型 */
  model?: 'main' | 'quick'
}