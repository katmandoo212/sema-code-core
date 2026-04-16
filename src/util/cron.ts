/**
 * Cron 辅助函数
 */
import { CronExpressionParser } from 'cron-parser'

/**
 * 校验 cron 表达式是否合法
 */
export function parseCronExpression(expr: string): boolean {
  try {
    CronExpressionParser.parse(expr)
    return true
  } catch {
    return false
  }
}

/**
 * 从指定时间点计算下次触发时间（ms），无匹配返回 null
 */
export function calcNextFireAt(expr: string, fromMs: number): number | null {
  try {
    const interval = CronExpressionParser.parse(expr, { currentDate: new Date(fromMs) })
    const next = interval.next()
    return next.getTime()
  } catch {
    return null
  }
}

/**
 * 从指定时间点计算接下来 count 次触发时间（ms），返回数组
 */
export function calcNextFireAts(expr: string, fromMs: number, count: number = 4): number[] {
  try {
    const interval = CronExpressionParser.parse(expr, { currentDate: new Date(fromMs) })
    const results: number[] = []
    for (let i = 0; i < count; i++) {
      const next = interval.next()
      results.push(next.getTime())
    }
    return results
  } catch {
    return []
  }
}

/**
 * 转人类可读描述
 */
export function cronToHuman(expr: string): string {
  const parts = expr.trim().split(/\s+/)
  if (parts.length !== 5) return expr

  const [minute, hour, dom, month, dow] = parts

  // 常见模式匹配
  if (minute === '*' && hour === '*' && dom === '*' && month === '*' && dow === '*') {
    return 'every minute'
  }
  if (hour === '*' && dom === '*' && month === '*' && dow === '*') {
    if (minute.startsWith('*/')) return `every ${minute.slice(2)} minutes`
    return `at minute ${minute} of every hour`
  }
  if (dom === '*' && month === '*' && dow === '*') {
    if (hour.startsWith('*/')) return `every ${hour.slice(2)} hours at minute ${minute}`
    return `daily at ${hour.padStart(2, '0')}:${minute.padStart(2, '0')}`
  }
  if (dom === '*' && month === '*' && dow !== '*') {
    const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
    const dayStr = dow.split(',').map(d => dayNames[parseInt(d)] || d).join(', ')
    return `${dayStr} at ${hour.padStart(2, '0')}:${minute.padStart(2, '0')}`
  }

  return expr
}
