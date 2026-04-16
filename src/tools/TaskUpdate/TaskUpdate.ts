import { z } from 'zod'
import { Tool } from '../base/Tool'
import { TOOL_NAME_FOR_PROMPT, DESCRIPTION } from './prompt'
import { getStateManager } from '../../manager/StateManager'

const TaskStatusEnum = z.enum(['pending', 'in_progress', 'completed', 'deleted'])

const inputSchema = z.strictObject({
  taskId: z.string().describe('The ID of the task to update'),
  subject: z.string().optional().describe('New subject for the task'),
  description: z.string().optional().describe('New description for the task'),
  activeForm: z.string().optional().describe("Present continuous form shown in spinner when in_progress (e.g., \"Running tests\")"),
  status: TaskStatusEnum.optional().describe('New status for the task'),
  addBlocks: z.array(z.string()).optional().describe('Task IDs that this task blocks'),
  addBlockedBy: z.array(z.string()).optional().describe('Task IDs that block this task'),
  owner: z.string().optional().describe('New owner for the task'),
  metadata: z.record(z.string(), z.unknown()).optional().describe('Metadata keys to merge into the task. Set a key to null to delete it.'),
})

type Out = {
  success: boolean
  taskId: string
  updatedFields: string[]
  statusChange?: { from: string; to: string }
  error?: string
}

function formatResult(data: Out): string {
  if (!data.success) return data.error || `Task #${data.taskId} not found`
  return `Updated task #${data.taskId} ${data.updatedFields.join(', ')}`
}

export const TaskUpdateTool = {
  name: TOOL_NAME_FOR_PROMPT,
  description() {
    return DESCRIPTION
  },
  inputSchema,
  isReadOnly() {
    return false
  },
  canRunConcurrently() {
    return true
  },
  genResultForAssistant(data: Out) {
    return formatResult(data)
  },
  getDisplayTitle(input: any) {
    return `TaskUpdate: ${input?.taskId ?? ''}`
  },
  async *call(
    { taskId, subject, description, activeForm, status, addBlocks, addBlockedBy, metadata }: z.infer<typeof inputSchema>,
    agentContext: any,
  ) {
    const stateManager = getStateManager()
    const agentState = stateManager.forAgent(agentContext.agentId)

    // 查找任务
    const existing = agentState.getTodoTask(taskId)
    if (!existing) {
      const data: Out = { success: false, taskId, updatedFields: [], error: 'Task not found' }
      yield { type: 'result' as const, data, resultForAssistant: formatResult(data) }
      return
    }

    // 删除
    if (status === 'deleted') {
      const deleted = agentState.deleteTodoTask(taskId)
      const data: Out = {
        success: deleted,
        taskId,
        updatedFields: deleted ? ['deleted'] : [],
        statusChange: deleted ? { from: existing.status, to: 'deleted' } : undefined,
        error: deleted ? undefined : 'Failed to delete task',
      }
      yield { type: 'result' as const, data, resultForAssistant: formatResult(data) }
      return
    }

    // 收集变更
    const updates: Record<string, any> = {}
    const updatedFields: string[] = []

    if (subject !== undefined && subject !== existing.subject) {
      updates.subject = subject
      updatedFields.push('subject')
    }
    if (description !== undefined && description !== existing.description) {
      updates.description = description
      updatedFields.push('description')
    }
    if (activeForm !== undefined && activeForm !== existing.activeForm) {
      updates.activeForm = activeForm
      updatedFields.push('activeForm')
    }
    if (status !== undefined && status !== existing.status) {
      updates.status = status
      updatedFields.push('status')
    }
    if (metadata !== undefined) {
      updates.metadata = metadata
      updatedFields.push('metadata')
    }

    if (Object.keys(updates).length > 0) {
      agentState.updateTodoTask(taskId, updates)
    }

    // 建立阻塞关系（双向写入）
    if (addBlocks && addBlocks.length > 0) {
      for (const blockId of addBlocks) {
        agentState.blockTask(taskId, blockId)
      }
      updatedFields.push('addBlocks')
    }
    if (addBlockedBy && addBlockedBy.length > 0) {
      for (const blockerId of addBlockedBy) {
        agentState.blockTask(blockerId, taskId)
      }
      updatedFields.push('addBlockedBy')
    }

    const data: Out = {
      success: true,
      taskId,
      updatedFields,
      statusChange: updates.status !== undefined
        ? { from: existing.status, to: updates.status }
        : undefined,
    }
    yield { type: 'result' as const, data, resultForAssistant: formatResult(data) }
  },
} satisfies Tool<typeof inputSchema, Out>
