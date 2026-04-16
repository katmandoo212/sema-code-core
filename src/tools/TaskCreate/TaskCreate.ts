import { z } from 'zod'
import { Tool } from '../base/Tool'
import { TOOL_NAME_FOR_PROMPT, DESCRIPTION } from './prompt'
import { getStateManager } from '../../manager/StateManager'

const inputSchema = z.strictObject({
  subject: z.string().min(1).describe('A brief title for the task'),
  description: z.string().min(1).describe('A detailed description of what needs to be done'),
  activeForm: z.string().optional().describe("Present continuous form shown in spinner when in_progress (e.g., \"Running tests\")"),
  metadata: z.record(z.string(), z.unknown()).optional().describe('Arbitrary metadata to attach to the task'),
})

type Out = { task: { id: string; subject: string } }

export const TaskCreateTool = {
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
    return `Task #${data.task.id} created successfully: ${data.task.subject}`
  },
  getDisplayTitle(input: any) {
    return `TaskCreate: ${input?.subject ?? ''}`
  },
  async *call(
    { subject, description, activeForm, metadata }: z.infer<typeof inputSchema>,
    agentContext: any,
  ) {
    const stateManager = getStateManager()
    const agentState = stateManager.forAgent(agentContext.agentId)

    const id = agentState.createTodoTask({
      subject,
      description,
      status: 'pending',
      activeForm,
      blocks: [],
      blockedBy: [],
      metadata,
    })

    const data: Out = { task: { id, subject } }
    yield {
      type: 'result' as const,
      data,
      resultForAssistant: `Task #${id} created successfully: ${subject}`,
    }
  },
} satisfies Tool<typeof inputSchema, Out>
