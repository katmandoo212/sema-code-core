import { z } from 'zod'
import { Tool } from '../base/Tool'
import { TOOL_NAME_FOR_PROMPT, DESCRIPTION } from './prompt'
import { getCronManager } from '../../manager/CronManager'

const inputSchema = z.strictObject({
  id: z.string().describe('Job ID returned by CronCreate'),
})

type Out = { id: string }

export const CronDeleteTool = {
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

  async validateInput(input: z.infer<typeof inputSchema>) {
    if (!getCronManager().findTask(input.id)) {
      return { result: false, message: `Cron job not found: ${input.id}` }
    }
    return { result: true }
  },

  genResultForAssistant(data: Out) {
    return `Cancelled job ${data.id}.`
  },
  genToolResultMessage(output: Out) {
    return {
      title: output.id,
      summary: `Cancelled: ${output.id}`,
      content: '',
    }
  },
  getDisplayTitle(input: any) {
    return `CronDelete: ${input?.id ?? ''}`
  },

  async *call({ id }: z.infer<typeof inputSchema>) {
    getCronManager().deleteTask(id)
    const data: Out = { id }

    yield {
      type: 'result' as const,
      data,
      resultForAssistant: `Cron job ${id} has been cancelled.`,
    }
  },
} satisfies Tool<typeof inputSchema, Out>
