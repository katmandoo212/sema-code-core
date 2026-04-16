import { z } from 'zod'
import { Tool } from '../base/Tool'
import { TOOL_NAME_FOR_PROMPT, DESCRIPTION } from './prompt'
import { getStateManager } from '../../manager/StateManager'
import { TodoTask } from '../../types/todoTask'

const inputSchema = z.strictObject({
  taskId: z.string().describe('The ID of the task to retrieve'),
})

type Out = { task: TodoTask | null }

function formatResult(data: Out): string {
  if (!data.task) return 'Task not found'
  const t = data.task
  const lines = [
    `Task #${t.id}: ${t.subject}`,
    `Status: ${t.status}`,
    `Description: ${t.description}`,
  ]
  if (t.activeForm) lines.push(`ActiveForm: ${t.activeForm}`)
  if (t.blockedBy.length > 0) lines.push(`Blocked by: ${t.blockedBy.map(id => `#${id}`).join(', ')}`)
  if (t.blocks.length > 0) lines.push(`Blocks: ${t.blocks.map(id => `#${id}`).join(', ')}`)
  return lines.join('\n')
}

export const TaskGetTool = {
  name: TOOL_NAME_FOR_PROMPT,
  description() {
    return DESCRIPTION
  },
  inputSchema,
  isReadOnly() {
    return true
  },
  canRunConcurrently() {
    return true
  },
  genResultForAssistant(data: Out) {
    return formatResult(data)
  },
  getDisplayTitle(input: any) {
    return `TaskGet: ${input?.taskId ?? ''}`
  },
  async *call({ taskId }: z.infer<typeof inputSchema>, agentContext: any) {
    const stateManager = getStateManager()
    const agentState = stateManager.forAgent(agentContext.agentId)
    const task = agentState.getTodoTask(taskId) ?? null

    const data: Out = { task }
    yield {
      type: 'result' as const,
      data,
      resultForAssistant: formatResult(data),
    }
  },
} satisfies Tool<typeof inputSchema, Out>
