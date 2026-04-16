import { z } from 'zod'
import { Tool } from '../base/Tool'
import { TOOL_NAME_FOR_PROMPT, DESCRIPTION } from './prompt'
import { getStateManager } from '../../manager/StateManager'

const inputSchema = z.strictObject({})

type TaskSummary = { id: string; subject: string; status: string; blockedBy: string[] }
type Out = { tasks: TaskSummary[] }

function formatResult(data: Out): string {
  if (data.tasks.length === 0) return 'No tasks found'
  return data.tasks.map(t => {
    let line = `#${t.id} [${t.status}] ${t.subject}`
    if (t.blockedBy.length > 0) line += ` (blocked by ${t.blockedBy.map(id => `#${id}`).join(', ')})`
    return line
  }).join('\n')
}

export const TaskListTool = {
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
  getDisplayTitle() {
    return 'TaskList'
  },
  async *call(_input: z.infer<typeof inputSchema>, agentContext: any) {
    const stateManager = getStateManager()
    const agentState = stateManager.forAgent(agentContext.agentId)
    const allTasks = agentState.listTodoTasks()

    // 构建已完成任务 ID 集合，用于过滤已解除的阻塞
    const resolvedTaskIds = new Set(
      allTasks.filter(t => t.status === 'completed').map(t => t.id),
    )

    const tasks: TaskSummary[] = allTasks.map(t => ({
      id: t.id,
      subject: t.subject,
      status: t.status,
      blockedBy: t.blockedBy.filter(id => !resolvedTaskIds.has(id)),
    }))

    const data: Out = { tasks }
    yield {
      type: 'result' as const,
      data,
      resultForAssistant: formatResult(data),
    }
  },
} satisfies Tool<typeof inputSchema, Out>
