import { z } from 'zod'
import { Tool } from '../base/Tool'
import { TOOL_NAME_FOR_PROMPT, DESCRIPTION } from './prompt'
import { getCronManager, CronManager } from '../../manager/CronManager'
import { parseCronExpression, calcNextFireAt, cronToHuman } from '../../util/cron'
import { MAIN_AGENT_ID } from '../../manager/StateManager'

const inputSchema = z.strictObject({
  cron: z.string().describe("Standard 5-field cron expression in local time: \"M H DoM Mon DoW\" (e.g. \"*/5 * * * *\" = every 5 minutes, \"30 14 28 2 *\" = Feb 28 at 2:30pm local once)."),
  prompt: z.string().describe("The prompt to enqueue at each fire time."),
  recurring: z.boolean().optional().describe("true (default) = fire on every cron match until deleted or auto-expired after 7 days. false = fire once at the next match, then auto-delete. Use false for \"remind me at X\" one-shot requests with pinned minute/hour/dom/month."),
  durable: z.boolean().optional().describe("true = persist to .sema/scheduled_tasks.json and survive restarts. false (default) = in-memory only, dies when this Claude session ends. Use true only when the user asks the task to survive across sessions."),
})

type Out = { id: string; cron: string; prompt: string; humanSchedule: string; recurring: boolean; durable: boolean }

export const CronCreateTool = {
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

  async validateInput(
    input: z.infer<typeof inputSchema>,
    agentContext: any,
  ) {
    if (agentContext.agentId !== MAIN_AGENT_ID) {
      return { result: false, message: 'CronCreate can only be used by the main agent' }
    }
    if (!parseCronExpression(input.cron)) {
      return { result: false, message: `Invalid cron expression: "${input.cron}". Use 5-field format: "M H DoM Mon DoW"` }
    }
    const next = calcNextFireAt(input.cron, Date.now())
    if (next === null || next - Date.now() > 31 * 24 * 60 * 60 * 1000) {
      return { result: false, message: 'Cron expression must have at least one match within 31 days' }
    }
    if (getCronManager().listTasks().length >= CronManager.MAX_TASKS) {
      return { result: false, message: `Maximum number of cron tasks (${CronManager.MAX_TASKS}) reached` }
    }
    return { result: true }
  },

  genResultForAssistant(data: Out) {
    const kind = data.recurring ? 'recurring' : 'one-shot'
    const parts = [`Scheduled ${kind} job ${data.id} (${data.humanSchedule}).`]
    if (data.durable) parts.push('Persisted to .sema/scheduled_tasks.json.')
    if (data.recurring) parts.push('Auto-expires after 7 days. Use CronDelete to cancel sooner.')
    return parts.join(' ')
  },
  genToolResultMessage(output: Out) {
    const raw = `${output.cron}: ${output.prompt}`
    const title = raw.length > 50 ? raw.slice(0, 49) + '…' : raw
    return {
      title,
      summary: `Scheduled ${output.id} (${output.humanSchedule})`,
      content: '',
    }
  },
  getDisplayTitle(input: any) {
    return `CronCreate: ${input?.cron ?? ''}`
  },

  async *call(
    { cron, prompt, recurring = true, durable = false }: z.infer<typeof inputSchema>,
    _agentContext: any,
  ) {
    const id = getCronManager().createTask(cron, prompt, recurring, durable)
    const humanSchedule = cronToHuman(cron)
    const data: Out = { id, cron, prompt, humanSchedule, recurring, durable }

    yield {
      type: 'result' as const,
      data,
      resultForAssistant: `Cron job ${id} created. Schedule: ${humanSchedule}. Recurring: ${recurring}. Durable: ${durable}.`,
    }
  },
} satisfies Tool<typeof inputSchema, Out>
