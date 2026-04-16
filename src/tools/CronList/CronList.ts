import { z } from 'zod'
import { Tool } from '../base/Tool'
import { TOOL_NAME_FOR_PROMPT, DESCRIPTION } from './prompt'
import { getCronManager } from '../../manager/CronManager'

const inputSchema = z.strictObject({})

type JobInfo = {
  id: string
  cron: string
  humanSchedule: string
  prompt: string
  recurring: boolean
  durable: boolean
  enabled: boolean
}
type Out = { jobs: JobInfo[] }

export const CronListTool = {
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
    if (data.jobs.length === 0) return 'No active cron jobs.'
    const lines = data.jobs.map(
      j => `${j.id} — ${j.humanSchedule} (${j.recurring ? 'recurring' : 'one-shot'})${j.enabled ? '' : ' [DISABLED]'}: ${j.prompt}`
    )
    return `Active cron jobs (${data.jobs.length}):\n${lines.join('\n')}`
  },
  genToolResultMessage(output: Out) {
    return {
      title: '',
      summary: `${output.jobs.length} active job(s)`,
      content: output.jobs.map(j => `${j.id} ${j.humanSchedule}`).join('\n'),
    }
  },
  getDisplayTitle() {
    return 'CronList'
  },

  async *call() {
    const cronManager = getCronManager()
    const tasks = cronManager.listTasks()
    const jobs: JobInfo[] = tasks.map(t => ({
      id: t.id,
      cron: t.cron,
      humanSchedule: t.cronToHuman,
      prompt: t.prompt,
      recurring: t.recurring,
      durable: t.durable,
      enabled: cronManager.isTaskEnabled(t.id),
    }))

    const data: Out = { jobs }
    yield {
      type: 'result' as const,
      data,
    }
  },
} satisfies Tool<typeof inputSchema, Out>
