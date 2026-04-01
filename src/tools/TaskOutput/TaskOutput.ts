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
type Out = {
  taskId: string
  retrievalStatus: string
  taskStatus: string
  output: string
}

export const TaskOutputTool = {
  name: 'TaskOutput',
  description() {
    return 'Retrieve the output of a background task started by the Bash tool with run_in_background=true. Use block=true (default) to wait for completion, or block=false to get the current snapshot immediately.'
  },
  isReadOnly() {
    return true
  },
  supportsInterrupt() {
    return true
  },
  inputSchema,
  genToolResultMessage(data: Out) {
    return {
      title: data.taskId,
      summary: '',
      content: data.output || '(no content)',
    }
  },
  getDisplayTitle(input: any) {
    return `${input?.task_id}`
  },
  genResultForAssistant(data: Out): string {
    return `<retrieval_status>${data.retrievalStatus}</retrieval_status>
<task_id>${data.taskId}</task_id>
<task_type>local_bash</task_type>
<status>${data.taskStatus}</status>
<output>
${data.output}
</output>`
  },
  async *call({ task_id, block = true, timeout = 30000 }: { task_id: string; block?: boolean; timeout?: number }, agentContext: any) {
    const manager = getTaskManager()
    const record = manager.getTask(task_id)

    if (!record) {
      const data: Out = { taskId: task_id, retrievalStatus: 'not_found', taskStatus: 'not_found', output: '' }
      yield { type: 'result', data, resultForAssistant: this.genResultForAssistant(data) }
      return
    }

    // block=false 或任务已完成，直接返回当前快照
    if (!block || record.status !== 'running') {
      const output = truncateOutput(record.output)
      const data: Out = { taskId: task_id, retrievalStatus: record.status, taskStatus: record.status, output }
      yield { type: 'result', data, resultForAssistant: this.genResultForAssistant(data) }
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

    const abortSignal = agentContext?.abortController?.signal
    const finalRecord = await manager.waitForTask(task_id, timeout, onChunk, abortSignal)
    const interrupted = abortSignal?.aborted ?? false
    const output = truncateOutput(finalRecord.output)
    const retrievalStatus = interrupted ? 'not_ready' : (finalRecord.status === 'running' ? 'timeout' : 'completed')
    const data: Out = { taskId: task_id, retrievalStatus, taskStatus: finalRecord.status, output }
    yield { type: 'result', data, resultForAssistant: this.genResultForAssistant(data) }
  },
} satisfies Tool<In, Out>

function truncateOutput(output: string): string {
  const { truncatedContent } = formatOutput(output)
  return truncatedContent
}
