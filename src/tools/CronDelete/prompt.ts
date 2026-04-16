export const TOOL_NAME_FOR_PROMPT = 'CronDelete'

export const DESCRIPTION = `Cancel a cron job previously scheduled with CronCreate. Removes it from .sema/scheduled_tasks.json (durable jobs) or the in-memory session store (session-only jobs).`
