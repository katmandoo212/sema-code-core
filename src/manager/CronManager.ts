/**
 * Cron 定时任务管理器
 */
import * as fs from 'fs'
import * as path from 'path'
import * as crypto from 'crypto'
import { CronTask, CronTaskFile } from '../types/cron'
import { calcNextFireAt, calcNextFireAts, cronToHuman } from '../util/cron'
import { findJsonObjectLineRange } from '../util/file'
import { getConfManager } from './ConfManager'
import { getStateManager, MAIN_AGENT_ID } from './StateManager'
import { getEventBus } from '../events/EventSystem'
import { logInfo, logWarn } from '../util/log'

export class CronManager {
  private tasks = new Map<string, CronTask>()
  private timer: ReturnType<typeof setInterval> | null = null
  private notifyCallback: ((msg: string) => void) | null = null
  private loadingPromise: Promise<void> | null = null
  private loaded = false

  private tasksFilePath: string      // .sema/scheduled_tasks.json
  private settingsFilePath: string   // .sema/settings.json

  static MAX_TASKS = 20
  static TICK_INTERVAL = 60_000 // 60秒，与 cron 最小粒度一致
  static RECURRING_EXPIRE_MS = 7 * 24 * 60 * 60 * 1000 // 循环任务7天过期

  constructor() {
    const workingDir = getConfManager().getCoreConfig()?.workingDir || process.cwd()
    const semaDir = path.join(workingDir, '.sema')
    this.tasksFilePath = path.join(semaDir, 'scheduled_tasks.json')
    this.settingsFilePath = path.join(semaDir, 'settings.json')

    // 后台静默加载持久化的定时任务
    this.loadingPromise = this.loadDurableTasks()
      .catch(err => {
        logWarn(`[CronManager] 后台加载持久化定时任务失败: ${err instanceof Error ? err.message : String(err)}`)
      })
      .finally(() => { this.loadingPromise = null })
  }

  // ============ 回调 ============

  setNotifyCallback(cb: (msg: string) => void): void {
    this.notifyCallback = cb
  }

  // ============ CRUD ============

  createTask(cron: string, prompt: string, recurring: boolean, durable: boolean): string {
    if (this.tasks.size >= CronManager.MAX_TASKS) {
      throw new Error(`Maximum number of cron tasks (${CronManager.MAX_TASKS}) reached`)
    }

    const id = crypto.randomBytes(4).toString('hex')
    const now = Date.now()
    const nextFireAt = calcNextFireAts(cron, now, 4)
    if (nextFireAt.length === 0) {
      throw new Error(`Cannot calculate next fire time for cron expression: ${cron}`)
    }

    const task: CronTask = {
      id,
      cron,
      prompt,
      recurring,
      durable,
      status: true,
      filePath: durable ? this.tasksFilePath : undefined,
      createdAt: now,
      cronToHuman: cronToHuman(cron),
      activatedAt: now,
      nextFireAt,
    }

    this.tasks.set(id, task)

    if (durable) {
      this.persist()
    }

    this.ensureRunning()
    this.emitUpdate()
    logInfo(`[CronManager] Task created: ${id}, cron: ${cron}, recurring: ${recurring}, durable: ${durable}`)
    return id
  }

  deleteTask(id: string): boolean {
    const task = this.tasks.get(id)
    if (!task) return false

    this.tasks.delete(id)
    if (task.durable) {
      this.persist()
    }

    // 清理 settings.json 中的 disabled 记录
    const settings = this.readSemaSettings()
    if (settings.disabledCronTasks?.includes(id)) {
      settings.disabledCronTasks = settings.disabledCronTasks.filter((tid: string) => tid !== id)
      this.writeSemaSettings(settings)
    }

    if (this.tasks.size === 0) {
      this.stop()
    }

    this.emitUpdate()
    logInfo(`[CronManager] Task deleted: ${id}`)
    return true
  }

  enableTask(id: string): boolean {
    const task = this.tasks.get(id)
    if (!task) return false

    task.status = true
    const settings = this.readSemaSettings()
    if (settings.disabledCronTasks) {
      settings.disabledCronTasks = settings.disabledCronTasks.filter((tid: string) => tid !== id)
    }
    this.writeSemaSettings(settings)

    this.ensureRunning()
    this.emitUpdate()
    logInfo(`[CronManager] Task ${id} enabled`)
    return true
  }

  disableTask(id: string): boolean {
    const task = this.tasks.get(id)
    if (!task) return false

    task.status = false
    const settings = this.readSemaSettings()
    if (!settings.disabledCronTasks) settings.disabledCronTasks = []
    if (!settings.disabledCronTasks.includes(id)) {
      settings.disabledCronTasks.push(id)
    }
    this.writeSemaSettings(settings)

    if (!this.hasActiveTasks()) {
      this.stop()
    }

    this.emitUpdate()
    logInfo(`[CronManager] Task ${id} disabled`)
    return true
  }

  isTaskEnabled(id: string): boolean {
    const task = this.tasks.get(id)
    return task?.status ?? false
  }

  findTask(id: string): CronTask | undefined {
    return this.tasks.get(id)
  }

  getTask(id: string): CronTask | undefined {
    return this.tasks.get(id)
  }

  listTasks(): CronTask[] {
    return Array.from(this.tasks.values())
  }

  /**
   * 获取任务列表（有缓存则直接返回，否则等待后台加载完成）
   */
  async getTaskList(): Promise<CronTask[]> {
    if (this.loaded) {
      return this.listTasks()
    }
    if (this.loadingPromise) {
      await this.loadingPromise
    }
    return this.listTasks()
  }

  // ============ settings.json 读写 ============

  private readSemaSettings(): Record<string, any> {
    try {
      if (!fs.existsSync(this.settingsFilePath)) return {}
      return JSON.parse(fs.readFileSync(this.settingsFilePath, 'utf-8'))
    } catch {
      return {}
    }
  }

  private writeSemaSettings(data: Record<string, any>): void {
    try {
      const dir = path.dirname(this.settingsFilePath)
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(this.settingsFilePath, JSON.stringify(data, null, 2), 'utf-8')
    } catch (err) {
      logWarn(`[CronManager] Failed to write settings: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  // ============ 持久化 ============

  private persist(): void {
    try {
      const dir = path.dirname(this.tasksFilePath)
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true })
      }

      const durableTasks = Array.from(this.tasks.values()).filter(t => t.durable)
      const data: CronTaskFile = {
        tasks: durableTasks.map(t => ({
          id: t.id,
          cron: t.cron,
          prompt: t.prompt,
          recurring: t.recurring,
          createdAt: t.createdAt,
          lastFiredAt: t.lastFiredAt,
        })),
      }

      const json = JSON.stringify(data, null, 2)
      fs.writeFileSync(this.tasksFilePath, json, 'utf-8')

      // 回填每个 durable 任务的 filePath（文件名:起始行-结束行）
      for (const task of durableTasks) {
        const range = findJsonObjectLineRange(json, `"id": "${task.id}"`)
        task.filePath = range ? `${this.tasksFilePath}:${range[0]}-${range[1]}` : this.tasksFilePath
      }
    } catch (err) {
      logWarn(`[CronManager] Failed to persist tasks: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  private loadFromFile(): number {
    if (!fs.existsSync(this.tasksFilePath)) return 0

    const raw = fs.readFileSync(this.tasksFilePath, 'utf-8')
    const data: CronTaskFile = JSON.parse(raw)
    if (!data.tasks || !Array.isArray(data.tasks)) return 0

    const now = Date.now()
    let loaded = 0
    const disabledSet = new Set<string>(this.readSemaSettings().disabledCronTasks ?? [])

    for (const t of data.tasks) {
      if (this.tasks.has(t.id)) continue

      const baseTime = t.lastFiredAt ?? t.createdAt
      let nextFireAt = calcNextFireAts(t.cron, baseTime, 4)

      if (nextFireAt.length > 0 && nextFireAt[0] < now) {
        if (!t.recurring) {
          nextFireAt = [now]
        } else {
          nextFireAt = calcNextFireAts(t.cron, now, 4)
        }
      }

      if (nextFireAt.length === 0) continue

      const range = findJsonObjectLineRange(raw, `"id": "${t.id}"`)
      const filePath = range ? `${this.tasksFilePath}:${range[0]}-${range[1]}` : this.tasksFilePath
      const task: CronTask = { ...t, durable: true, filePath, status: !disabledSet.has(t.id), cronToHuman: cronToHuman(t.cron), activatedAt: now, nextFireAt }

      this.tasks.set(task.id, task)
      loaded++
    }

    return loaded
  }

  /**
   * 后台加载持久化任务（仅在构造时调用一次）
   */
  private async loadDurableTasks(): Promise<void> {
    try {
      const loaded = this.loadFromFile()
      if (this.tasks.size > 0) {
        this.ensureRunning()
      }
      logInfo(`[CronManager] Loaded durable tasks: ${loaded}`)
    } catch (err) {
      logWarn(`[CronManager] Failed to load tasks: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      this.loaded = true
    }
  }

  /**
   * 清空非持久化任务（createSession 时调用）
   */
  clearNonDurableTasks(): void {
    for (const [id, task] of this.tasks) {
      if (!task.durable) {
        this.tasks.delete(id)
      }
    }

    if (this.tasks.size === 0) {
      this.stop()
    }

    this.emitUpdate()
    logInfo(`[CronManager] Cleared non-durable tasks`)
  }

  /**
   * 强制重新加载持久化任务（清空所有任务后从文件重新读取）
   */
  refresh(): CronTask[] {
    this.stop()
    this.tasks.clear()
    try {
      const loaded = this.loadFromFile()
      if (this.tasks.size > 0) {
        this.ensureRunning()
      }
      logInfo(`[CronManager] Refreshed durable tasks: ${loaded}`)
    } catch (err) {
      logWarn(`[CronManager] Failed to refresh tasks: ${err instanceof Error ? err.message : String(err)}`)
    }
    this.emitUpdate()
    return this.listTasks()
  }

  // ============ 调度 ============

  private ensureRunning(): void {
    if (this.timer) return
    this.timer = setInterval(() => this.tick(), CronManager.TICK_INTERVAL)
    if (this.timer.unref) {
      this.timer.unref()
    }
  }

  private stop(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  private tick(): void {
    const mainState = getStateManager().forAgent(MAIN_AGENT_ID)
    if (mainState.getCurrentState() !== 'idle') return

    const now = Date.now()
    const toDelete: string[] = []

    for (const task of this.tasks.values()) {
      // 循环任务本轮调度超过7天，停止调度（不删持久化文件，下次启动重新计）
      if (task.recurring && now - task.activatedAt >= CronManager.RECURRING_EXPIRE_MS) {
        task.status = false
        logInfo(`[CronManager] Recurring task ${task.id} expired after 7 days in this session`)
        continue
      }

      if (!task.status) continue
      if (task.nextFireAt.length === 0 || task.nextFireAt[0] > now) continue
      if (task.lastFiredAt != null && task.lastFiredAt >= task.nextFireAt[0]) continue

      this.fire(task)
      task.lastFiredAt = now

      if (task.recurring) {
        const next = calcNextFireAts(task.cron, now, 4)
        if (next.length > 0) {
          task.nextFireAt = next
        }
        if (task.durable) {
          this.persist()
        }
      } else {
        toDelete.push(task.id)
      }
    }

    for (const id of toDelete) {
      this.tasks.delete(id)
    }
    if (toDelete.length > 0) {
      this.persist()
      this.emitUpdate()
    }

    if (this.tasks.size === 0 || !this.hasActiveTasks()) {
      this.stop()
    }
  }

  private emitUpdate(): void {
    getEventBus().emit('cron:update', {})
  }

  private hasActiveTasks(): boolean {
    for (const task of this.tasks.values()) {
      if (task.status) return true
    }
    return false
  }

  private fire(task: CronTask): void {
    if (!this.notifyCallback) {
      logWarn(`[CronManager] No notify callback set, cannot fire task ${task.id}`)
      return
    }

    const msg = `<cron-notification>
<task-id>${task.id}</task-id>
<cron>${task.cron}</cron>
<schedule>${task.cronToHuman}</schedule>
<recurring>${task.recurring}</recurring>
<prompt>${task.prompt}</prompt>
</cron-notification>
The above scheduled task has been triggered. Please execute the prompt.`

    logInfo(`[CronManager] Firing task ${task.id}: ${task.prompt.slice(0, 100)}`)
    this.notifyCallback(msg)
  }

  // ============ 生命周期 ============

  dispose(): void {
    this.stop()
    this.tasks.clear()
  }
}

// 单例
let instance: CronManager | null = null

export function getCronManager(): CronManager {
  if (!instance) {
    instance = new CronManager()
  }
  return instance
}
