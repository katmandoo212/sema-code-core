import { z } from 'zod'
import { Tool } from '../base/Tool'
import { getTaskManager } from '../../manager/TaskManager'

export const inputSchema = z.strictObject({
  task_id: z.string().describe('The background task ID to stop'),
})

type In = typeof inputSchema
type Out = string

export const TaskStopTool = {
  name: 'TaskStop',
  description() {
    return 'Stop a running background task started by the Bash tool with run_in_background=true.'
  },
  isReadOnly() {
    return false
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
      title: `TaskStop: ${input?.task_id}`,
      content: `Stop background task ${input?.task_id}`,
    }
  },
  genToolResultMessage(output: Out) {
    return {
      title: 'TaskStop',
      summary: '',
      content: output,
    }
  },
  getDisplayTitle(input: any) {
    return `TaskStop: ${input?.task_id}`
  },
  genResultForAssistant(data: Out): string {
    return data
  },
  async *call({ task_id }: { task_id: string }, _agentContext: any) {
    const manager = getTaskManager()
    const record = manager.getTask(task_id)

    if (!record) {
      const result = `Task ${task_id} not found.`
      yield { type: 'result', data: result, resultForAssistant: result }
      return
    }

    if (record.status !== 'running') {
      const result = `Task is not running (status: ${record.status}).`
      yield { type: 'result', data: result, resultForAssistant: result }
      return
    }

    manager.stopTask(task_id)
    const result = `Task ${task_id} stopped successfully.`
    yield { type: 'result', data: result, resultForAssistant: result }
  },
} satisfies Tool<In, Out>
