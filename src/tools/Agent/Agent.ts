import * as fs from 'fs'
import Anthropic from '@anthropic-ai/sdk'
import { z } from 'zod'
import { nanoid } from 'nanoid'
import { Tool } from '../base/Tool'
import { TOOL_NAME_FOR_PROMPT, getDescription } from './prompt'
import { defaultBuiltInAgentsConfs } from '../../services/agents/defaultBuiltInAgentsConfs'
import { getTools } from '../base/tools'
import { getMCPManager } from '../../services/mcp/MCPManager'
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
import { getConfManager } from '../../manager/ConfManager'

const inputSchema = z.strictObject({
  description: z.string().describe('A short (3-5 word) description of the task'),
  prompt: z.string().describe('The task for the agent to perform'),
  subagent_type: z.string().optional().default('general-purpose').describe('The type of specialized agent to use for this task'),
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
  canRunConcurrently() {
    // 多个 Agent 实例之间互相独立，可并发执行
    return true
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
  async *call({ description, prompt, subagent_type = 'general-purpose', run_in_background }: z.infer<typeof inputSchema>, agentContext: any) {
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
      const excludedTools = [TOOL_NAME_FOR_PROMPT, 'TaskOutput', 'TaskStop', 'AskUserQuestion', 'ExitPlanMode']
      let subagentTools: Tool[]
      if (!agentConfig.tools || agentConfig.tools === '*') {
        subagentTools = getTools().filter(t => !excludedTools.includes(t.name))
      } else {
        subagentTools = getTools(agentConfig.tools).filter(t => !excludedTools.includes(t.name))
      }

      // 子代理的 Bash 工具不支持后台执行：omit run_in_background，模型不可见此字段
      subagentTools = subagentTools.map(t => {
        if (t.name === 'Bash') {
          return { ...t, inputSchema: (t.inputSchema as any).omit({ run_in_background: true }) }
        }
        return t
      })

      // 加入 MCP 工具
      const mcpTools = getMCPManager().getMCPTools()
      if (mcpTools.length > 0) {
        subagentTools = [...subagentTools, ...mcpTools]
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

      const disableBackground = getConfManager().getCoreConfig()?.disableBackgroundTasks ?? false

      // 6. 后台模式：独立 AbortController，立即返回（禁用后台任务时跳过）
      if (run_in_background && !disableBackground) {
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
            return {
              result: extractResultText(bgResultMessages),
              usage: {
                totalTokens: stats.totalTokens,
                toolUses: stats.toolUseCount,
                durationMs: stats.durationMs,
              },
            }
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
        }, agentConfig.name)

        const launchMsg = `Async agent launched successfully.\nagentId: ${taskId} (internal ID - do not mention to user.)\nThe agent is working in the background. You will be notified automatically when it completes.\nDo not duplicate this agent's work — avoid working with the same files or topics it is using. Work on non-overlapping tasks, or briefly tell the user what you launched and end your response.`
        yield {
          type: 'result',
          data: { agentType: agentConfig.name, result: launchMsg, durationMs: Date.now() - start },
          resultForAssistant: launchMsg,
        }
        return
      }

      // 7. 创建独立 AbortController，联动主 AC
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

      const subAbortController = new AbortController()

      // 联动：主AC abort → 子AC abort
      const onMainAbort = () => subAbortController.abort()
      sharedAbortController.signal.addEventListener('abort', onMainAbort)
      const unlinkAbort = () => {
        sharedAbortController.signal.removeEventListener('abort', onMainAbort)
      }

      // 如果主AC已经abort了，立刻abort子AC
      if (sharedAbortController.signal.aborted) {
        subAbortController.abort()
      }

      // 8. 构建子代理上下文（使用独立AC）
      const subagentContext: AgentContext = {
        agentId: taskId,
        abortController: subAbortController,
        tools: subagentTools,
        model: (agentConfig.model === 'quick' || agentConfig.model === 'haiku') ? 'quick' : 'main'
      }

      // 9. 注册前台任务到 TaskManager 和 StateManager
      const taskManager = getTaskManager()
      const toolUseId = agentContext?.currentToolUseID || ''
      taskManager.registerForegroundAgent(taskId, description, toolUseId, subAbortController, unlinkAbort, agentConfig.name)
      stateManager.addForegroundAgent(taskId)

      // 10. 发送 task:agent:start 事件
      eventBus.emit('task:agent:start', { taskId, subagent_type: agentConfig.name, description, prompt, run_in_background: false } satisfies TaskAgentStartData)

      // 11. 将 generator 消费放入独立 async 函数
      const resultMessages: any[] = []

      const executionPromise = (async () => {
        try {
          for await (const message of query([userMessage], systemPromptContent, subagentContext)) {
            resultMessages.push(message)
          }

          const isInterrupted = subAbortController.signal.aborted
          const stats = calculateStats(resultMessages, start)
          const summary = formatSummary(stats, isInterrupted ? 'interrupted' : 'completed')

          eventBus.emit('task:agent:end', {
            taskId,
            status: isInterrupted ? 'interrupted' : 'completed',
            content: summary,
          } satisfies TaskAgentEndData)

          return {
            result: extractResultText(resultMessages),
            usage: {
              totalTokens: stats.totalTokens,
              toolUses: stats.toolUseCount,
              durationMs: stats.durationMs,
            },
          }
        } catch (error) {
          const isInterrupted = isInterruptedException(error) || subAbortController.signal.aborted
          const stats = calculateStats(resultMessages, start)
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
          stateManager.removeForegroundAgent(taskId)
        }
      })()

      // 12. Promise.race：等执行完成 or 等转后台信号（禁用后台任务时不注册转后台）
      let transferResolve: (() => void) | null = null
      const transferSignal = new Promise<void>(resolve => {
        transferResolve = resolve
      })
      if (!disableBackground) {
        taskManager.setTransferResolve(taskId, transferResolve!)
      }

      // 创建统一处理 resolve/reject 的派生 Promise
      const completionPromise = executionPromise.then(
        res => ({ type: 'completed' as const, res }),
        err => ({ type: 'error' as const, err })
      )

      const raceResult = await Promise.race([
        completionPromise,
        transferSignal.then(() => ({ type: 'transferred' as const })),
      ])

      // 13. 根据 race 结果处理
      if (raceResult.type === 'completed') {
        const { res } = raceResult
        taskManager.finalizeTask(taskId, 0, res.result, res.usage)

        const output: Output = {
          agentType: agentConfig.name,
          result: res.result,
          durationMs: Date.now() - start,
        }
        yield {
          type: 'result',
          data: output,
          resultForAssistant: res.result,
        }
      } else if (raceResult.type === 'error') {
        const { err } = raceResult
        const isInterrupted = isInterruptedException(err) || subAbortController.signal.aborted
        const stats = calculateStats(resultMessages, start)

        taskManager.finalizeTask(taskId, isInterrupted ? 0 : 1)

        if (isInterrupted) {
          const summary = formatSummary(stats, 'interrupted')
          logDebug(`Subagent ${agentConfig.name} was interrupted`)
          yield {
            type: 'result',
            data: { agentType: agentConfig.name, result: summary, durationMs: Date.now() - start },
            resultForAssistant: summary,
          }
        } else {
          const errorMsg = `Subagent execution failed: ${err instanceof Error ? err.message : String(err)}`
          logError(errorMsg)
          yield {
            type: 'result',
            data: { agentType: agentConfig.name, result: errorMsg, durationMs: Date.now() - start },
            resultForAssistant: errorMsg,
          }
        }
      } else {
        // 转后台：executionPromise 仍在运行，只是前台不再等待
        const record = taskManager.getTask(taskId)
        if (record) {
          record._promise = completionPromise.then((result) => {
            if (result.type === 'completed') {
              try { fs.writeFileSync(record.filepath, result.res.result) } catch {}
              taskManager.finalizeTask(taskId, 0, result.res.result, result.res.usage)
            } else {
              const isAborted = subAbortController.signal.aborted
              const msg = isAborted
                ? '[Agent interrupted]'
                : `[Agent error: ${result.err instanceof Error ? result.err.message : String(result.err)}]`
              if (!record.output) record.output = msg
              try { fs.appendFileSync(record.filepath, msg) } catch {}
              taskManager.finalizeTask(taskId, isAborted ? 0 : 1)
            }
          })
        }

        const transferMsg = `Agent has been transferred to background.\nagentId: ${taskId}\nThe agent continues working in the background. You will be notified when it completes.`
        yield {
          type: 'result',
          data: { agentType: agentConfig.name, result: transferMsg, durationMs: Date.now() - start },
          resultForAssistant: transferMsg,
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
