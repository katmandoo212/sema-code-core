import { z } from 'zod'
import { Tool } from '../base/Tool'
import { getTaskManager } from '../../manager/TaskManager'

export const inputSchema = z.strictObject({
  task_id: z.string().describe('The background task ID to stop'),
})

type In = typeof inputSchema
type Out = {
  taskId: string
  message: string
  taskType: string
  command: string
  stopped: boolean
}

export const TaskStopTool = {
  name: 'TaskStop',
  description() {
    return 'Stop a running background task started by the Bash tool with run_in_background=true.'
  },
  isReadOnly() {
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
      title: output.taskId,
      summary: '',
      content: output.stopped ? `${output.command} · stopped` : output.message,
    }
  },
  getDisplayTitle(input: any) {
    return `TaskStop: ${input?.task_id}`
  },
  genResultForAssistant(data: Out): string {
    return `<message>${data.message}</message>
<task_id>${data.taskId}</task_id>
<task_type>${data.taskType}</task_type>
<command>${data.command}</command>`
  },
  async *call({ task_id }: { task_id: string }, _agentContext: any) {
    const manager = getTaskManager()
    const record = manager.getTask(task_id)

    if (!record) {
      const data: Out = { taskId: task_id, message: `Task ${task_id} not found.`, taskType: '', command: '', stopped: false }
      yield { type: 'result', data, resultForAssistant: this.genResultForAssistant(data) }
      return
    }

    if (record.status !== 'running') {
      const data: Out = { taskId: task_id, message: `Task is not running (status: ${record.status}).`, taskType: record.type, command: record.command, stopped: false }
      yield { type: 'result', data, resultForAssistant: this.genResultForAssistant(data) }
      return
    }

    const stopped = manager.stopTask(task_id)
    const data: Out = {
      taskId: task_id,
      message: stopped
        ? `Successfully stopped task: ${task_id} (${record.command})`
        : `Failed to stop task: ${task_id} (${record.command}), process may have already exited.`,
      taskType: record.type,
      command: record.command,
      stopped,
    }
    yield { type: 'result', data, resultForAssistant: this.genResultForAssistant(data) }
  },
} satisfies Tool<In, Out>
