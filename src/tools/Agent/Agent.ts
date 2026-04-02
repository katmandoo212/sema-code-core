import Anthropic from '@anthropic-ai/sdk'
import { z } from 'zod'
import { nanoid } from 'nanoid'
import { Tool } from '../base/Tool'
import { TOOL_NAME_FOR_PROMPT, getDescription } from './prompt'
import { defaultBuiltInAgentsConfs } from '../../services/agents/defaultBuiltInAgentsConfs'
import { getTools } from '../base/tools'
import { query } from '../../core/Conversation'
import type { AgentContext } from '../../types/agent'

import { createUserMessage } from '../../util/message'
import { getAgentsManager } from '../../services/agents/agentsManager'
import { getStateManager } from '../../manager/StateManager'
import { getEventBus } from '../../events/EventSystem'
import { TaskAgentStartData, TaskAgentEndData } from '../../events/types'
import { logDebug, logError } from '../../util/log'
import { isInterruptedException } from '../../types/errors'
import { calculateStats, formatSummary, extractResultText } from '../../util/agentStats'
import { buildAgentSystemPrompt } from '../../services/agents/genSystemPrompt'
import { generateRulesReminders, generateSkillsReminder } from '../../services/agents/systemReminder'
import { getTaskManager } from '../../manager/TaskManager'

const inputSchema = z.strictObject({
  description: z.string().describe('A short (3-5 word) description of the task'),
  prompt: z.string().describe('The task for the agent to perform'),
  subagent_type: z.string().describe('The type of specialized agent to use for this task'),
  run_in_background: z.boolean().optional().describe(`Set to true to run this agent in the background. You will be notified when it completes.`),
})

type Output = {
  agentType: string
  result: string
  durationMs: number
}

export const TaskTool = {
  name: TOOL_NAME_FOR_PROMPT,
  description() {
    return getDescription()
  },
  inputSchema,
  isReadOnly() {
    // 子代理可能会执行写操作，所以标记为非只读
    return false
  },
  genToolResultMessage({ agentType, result }) {
    return {
      title: `${agentType}`,
      summary: '',
      content: ''
    }
  },
  getDisplayTitle(input) {
    return input?.description || TOOL_NAME_FOR_PROMPT
  },
  async *call({ description, prompt, subagent_type, run_in_background }: z.infer<typeof inputSchema>, agentContext: any) {
    const start = Date.now()
    const taskId = nanoid()
    const eventBus = getEventBus()
    const stateManager = getStateManager()

    try {
      // 1. 查找对应的 AgentConfig
      const AgentsConfs = await getAgentsManager().getAgentsInfo()
      const agentConfig = AgentsConfs.find(
        agent => agent.name.toLowerCase() === subagent_type.toLowerCase()
      )

      if (!agentConfig) {
        const errorMsg = `Unknown agent type: ${subagent_type}. Available types: ${defaultBuiltInAgentsConfs.map(a => a.name).join(', ')}`
        yield {
          type: 'result',
          data: { agentType: subagent_type, result: errorMsg, durationMs: Date.now() - start },
          resultForAssistant: errorMsg,
        }
        return
      }

      logDebug(`Starting ${agentConfig.name} agent with prompt: ${prompt}`)

      // 3. 准备子代理的系统提示（包含 agentConfig.prompt + notes + env + gitStatus）
      const systemPromptContent = await buildAgentSystemPrompt(agentConfig.prompt)

      // 4. 获取子代理允许使用的工具（排除 任务与代理 工具，防止嵌套）
      const excludedTools = [TOOL_NAME_FOR_PROMPT, 'TaskOutput', 'TaskStop']
      let subagentTools: Tool[]
      if (!agentConfig.tools || agentConfig.tools === '*') {
        subagentTools = getTools().filter(t => !excludedTools.includes(t.name))
      } else {
        subagentTools = getTools(agentConfig.tools).filter(t => !excludedTools.includes(t.name))
      }

      logDebug(`Subagent ${agentConfig.name} has ${subagentTools.length} tools available`)

      // 5. 创建用户消息（包含 rules 信息）
      const additionalReminders: Anthropic.ContentBlockParam[] = []

      // 添加 rules 信息
      const rulesReminders = generateRulesReminders()
      additionalReminders.push(...rulesReminders)

      const userMessage = createUserMessage([
        ...additionalReminders,
        { type: 'text' as const, text: prompt }
      ])

      // 6. 后台模式：独立 AbortController，立即返回
      if (run_in_background) {
        const taskManager = getTaskManager()
        const toolUseId = agentContext?.currentToolUseID || ''
        const agentModel: 'quick' | 'main' = (agentConfig.model === 'quick' || agentConfig.model === 'haiku') ? 'quick' : 'main'

        eventBus.emit('task:agent:start', { taskId, subagent_type: agentConfig.name, description, prompt, run_in_background: true } satisfies TaskAgentStartData)

        taskManager.spawnAgentTask(taskId, description, toolUseId, async (bgAbortController) => {
          const bgContext: AgentContext = {
            agentId: taskId,
            abortController: bgAbortController,
            tools: subagentTools,
            model: agentModel,
          }
          const bgResultMessages: any[] = []
          try {
            for await (const message of query([userMessage], systemPromptContent, bgContext)) {
              bgResultMessages.push(message)
            }
            const isInterrupted = bgAbortController.signal.aborted
            const stats = calculateStats(bgResultMessages, start)
            const summary = formatSummary(stats, isInterrupted ? 'interrupted' : 'completed')
            eventBus.emit('task:agent:end', {
              taskId,
              status: isInterrupted ? 'interrupted' : 'completed',
              content: summary,
            } satisfies TaskAgentEndData)
            return extractResultText(bgResultMessages)
          } catch (error) {
            const isInterrupted = isInterruptedException(error) || bgAbortController.signal.aborted
            const stats = calculateStats(bgResultMessages, start)
            const summary = isInterrupted
              ? formatSummary(stats, 'interrupted')
              : `Error: ${error instanceof Error ? error.message : String(error)}`
            eventBus.emit('task:agent:end', {
              taskId,
              status: isInterrupted ? 'interrupted' : 'failed',
              content: summary,
            } satisfies TaskAgentEndData)
            throw error
          } finally {
            stateManager.forAgent(taskId).clearAllState()
          }
        })

        const launchMsg = `Async agent launched successfully.\nagentId: ${taskId} (internal ID - do not mention to user.)\nThe agent is working in the background. You will be notified automatically when it completes.\nDo not duplicate this agent's work — avoid working with the same files or topics it is using. Work on non-overlapping tasks, or briefly tell the user what you launched and end your response.`
        yield {
          type: 'result',
          data: { agentType: agentConfig.name, result: launchMsg, durationMs: Date.now() - start },
          resultForAssistant: launchMsg,
        }
        return
      }

      // 7. 前台模式：获取共享的 AbortController（子代理与主代理共用，中断时一起中断）
      const sharedAbortController = stateManager.currentAbortController

      if (!sharedAbortController) {
        const errorMsg = 'No active AbortController found. Cannot start subagent.'
        yield {
          type: 'result',
          data: { agentType: subagent_type, result: errorMsg, durationMs: Date.now() - start },
          resultForAssistant: errorMsg,
        }
        return
      }

      // 8. 构建子代理上下文
      const subagentContext: AgentContext = {
        agentId: taskId,
        abortController: sharedAbortController,
        tools: subagentTools,
        model: (agentConfig.model === 'quick' || agentConfig.model === 'haiku') ? 'quick' : 'main'
      }

      // 9. 发送 task:agent:start 事件
      eventBus.emit('task:agent:start', { taskId, subagent_type: agentConfig.name, description, prompt, run_in_background: false } satisfies TaskAgentStartData)

      // 10. 执行子代理查询
      const messages = [userMessage]
      let resultText = ''
      const resultMessages = []

      try {
        for await (const message of query(
          messages,
          systemPromptContent,
          subagentContext,
        )) {
          // 将每个消息添加到结果列表中
          resultMessages.push(message)
        }

        // 从收集的消息中提取最后一次 assistant 响应的文本内容
        resultText = extractResultText(resultMessages)
        logDebug(`${agentConfig.name} agent completed. Result length: ${resultText.length}`)

        // 统计 tokens 和工具使用（检查是否被中断，query() 在中断时通过 return 正常结束）
        const isInterrupted = sharedAbortController.signal.aborted
        const stats = calculateStats(resultMessages, start)
        const summary = formatSummary(stats, isInterrupted ? 'interrupted' : 'completed')

        // 清理子代理所有隔离状态
        const subagentState = stateManager.forAgent(taskId)
        subagentState.clearAllState()

        // 发送 task:agent:end 事件
        const endEventData: TaskAgentEndData = {
          taskId,
          status: isInterrupted ? 'interrupted' : 'completed',
          content: summary,
        }
        eventBus.emit('task:agent:end', endEventData)

        const output: Output = {
          agentType: agentConfig.name,
          result: resultText,
          durationMs: Date.now() - start
        }

        yield {
          type: 'result',
          data: output,
          resultForAssistant: resultText,
        }
      } catch (error) {
        // 统计 tokens 和工具使用
        const stats = calculateStats(resultMessages, start)

        // 清理子代理所有隔离状态（失败/中断时也要清理）
        const subagentState = stateManager.forAgent(taskId)
        subagentState.clearAllState()

        // 发送 task:agent:end 失败事件
        const isInterrupted = isInterruptedException(error)
        const summary = isInterrupted
          ? formatSummary(stats, 'interrupted')
          : `Error: ${error instanceof Error ? error.message : String(error)}`

        const endEventData: TaskAgentEndData = {
          taskId,
          status: 'failed',
          content: summary,
        }
        eventBus.emit('task:agent:end', endEventData)

        if (isInterrupted) {
          logDebug(`Subagent ${agentConfig.name} was interrupted`)
          yield {
            type: 'result',
            data: { agentType: agentConfig.name, result: summary, durationMs: Date.now() - start },
            resultForAssistant: summary,
          }
        } else {
          const errorMsg = `Subagent execution failed: ${error instanceof Error ? error.message : String(error)}`
          logError(errorMsg)
          yield {
            type: 'result',
            data: { agentType: agentConfig.name, result: errorMsg, durationMs: Date.now() - start },
            resultForAssistant: errorMsg,
          }
        }
      }
    } catch (error) {
      // 外层错误（配置错误等）
      const errorMsg = `TaskTool error: ${error instanceof Error ? error.message : String(error)}`
      logError(errorMsg)

      // 清理子代理状态（防止内存泄漏）
      const subagentState = stateManager.forAgent(taskId)
      subagentState.clearAllState()

      // 发送失败事件
      const endEventData: TaskAgentEndData = {
        taskId,
        status: 'failed',
        content: errorMsg,
      }
      eventBus.emit('task:agent:end', endEventData)

      yield {
        type: 'result',
        data: { agentType: subagent_type, result: errorMsg, durationMs: Date.now() - start },
        resultForAssistant: errorMsg,
      }
    }
  },
  genResultForAssistant(output: Output) {
    return output.result
  },
} satisfies Tool<typeof inputSchema, Output>
