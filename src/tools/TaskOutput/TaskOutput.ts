import { z } from 'zod'
import { Tool } from '../base/Tool'
import { getTaskManager } from '../../manager/TaskManager'
import { getEventBus } from '../../events/EventSystem'
import type { ToolExecutionChunkData } from '../../events/types'
import { MAIN_AGENT_ID } from '../../manager/StateManager'
import { formatOutput } from '../Bash/utils'

export const inputSchema = z.strictObject({
  task_id: z.string().describe('The background task ID to retrieve output for'),
  block: z
    .boolean()
    .optional()
    .default(true)
    .describe('Whether to wait for the task to complete (default: true)'),
  timeout: z
    .number()
    .optional()
    .default(30000)
    .describe('Maximum milliseconds to wait when block=true (default: 30000)'),
})

type In = typeof inputSchema
type Out = string

export const TaskOutputTool = {
  name: 'TaskOutput',
  description() {
    return 'Retrieve the output of a background task started by the Bash tool with run_in_background=true. Use block=true (default) to wait for completion, or block=false to get the current snapshot immediately.'
  },
  isReadOnly() {
    return true
  },
  supportsInterrupt() {
    return false
  },
  inputSchema,
  async validateInput() {
    return { result: true }
  },
  genToolPermission(input: any) {
    return {
      title: `TaskOutput: ${input?.task_id}`,
      content: `Retrieve output for task ${input?.task_id}`,
    }
  },
  genToolResultMessage(output: Out) {
    return {
      title: 'TaskOutput',
      summary: '',
      content: output,
    }
  },
  getDisplayTitle(input: any) {
    return `TaskOutput: ${input?.task_id}`
  },
  genResultForAssistant(data: Out): string {
    return data
  },
  async *call({ task_id, block = true, timeout = 30000 }: { task_id: string; block?: boolean; timeout?: number }, agentContext: any) {
    const manager = getTaskManager()
    const record = manager.getTask(task_id)

    if (!record) {
      const result = `<retrieval_status>not_found</retrieval_status>\n<task_id>${task_id}</task_id>`
      yield { type: 'result', data: result, resultForAssistant: result }
      return
    }

    // block=false 或任务已完成，直接返回当前快照
    if (!block || record.status !== 'running') {
      const output = truncateOutput(record.output)
      const result = buildResult(task_id, record.status === 'running' ? 'running' : record.status, record.status, output)
      yield { type: 'result', data: result, resultForAssistant: result }
      return
    }

    // block=true，等待任务完成，主代理通过 onChunk 接收增量输出
    const isMainAgent = agentContext?.agentId === MAIN_AGENT_ID
    const onChunk = isMainAgent ? (delta: string) => {
      const chunkData: ToolExecutionChunkData = {
        agentId: agentContext.agentId,
        toolId: agentContext.currentToolUseID || '',
        toolName: 'TaskOutput',
        title: `${task_id}`,
        summary: '',
        content: delta,
      }
      getEventBus().emit('tool:execution:chunk', chunkData)
    } : undefined

    const finalRecord = await manager.waitForTask(task_id, timeout, onChunk)
    const isTimeout = finalRecord.status === 'running'
    const output = truncateOutput(finalRecord.output)
    const retrievalStatus = isTimeout ? 'timeout' : 'completed'
    const result = buildResult(task_id, retrievalStatus, finalRecord.status, output)
    yield { type: 'result', data: result, resultForAssistant: result }
  },
} satisfies Tool<In, Out>

function truncateOutput(output: string): string {
  const { truncatedContent } = formatOutput(output)
  return truncatedContent
}

function buildResult(taskId: string, retrievalStatus: string, taskStatus: string, output: string): string {
  return `<retrieval_status>${retrievalStatus}</retrieval_status>
<task_id>${taskId}</task_id>
<task_type>local_bash</task_type>
<status>${taskStatus}</status>
<output>
${output}
</output>`
}
