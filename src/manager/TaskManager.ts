import * as fs from 'fs'
import * as path from 'path'
import * as crypto from 'crypto'
import { spawn } from 'child_process'
import { IS_WIN } from '../util/platform'
import { logInfo, logError, logWarn } from '../util/log'
import { getEventBus } from '../events/EventSystem'
import { TaskRecord, TaskListItem, TimeoutTransferContext } from '../types/task'
import { MAX_OUTPUT_SIZE, TASK_OUTPUT_DIR, ensureTaskDir, getShellForSpawn, killProcess } from '../util/process'

export class TaskManager {
  private static MAX_FINISHED_TASKS = 10
  private tasks = new Map<string, TaskRecord>()
  private watchers = new Map<string, Set<(delta: string) => void>>()
  private notifyCallback: ((msg: string) => void) | null = null

  setNotifyCallback(cb: (msg: string) => void) {
    this.notifyCallback = cb
  }

  getTask(taskId: string): TaskRecord | undefined {
    return this.tasks.get(taskId)
  }

  getTasks(): TaskRecord[] {
    return Array.from(this.tasks.values())
  }

  getTaskList(): TaskListItem[] {
    return Array.from(this.tasks.values()).map(t => ({
      taskId: t.taskId,
      pid: t.pid,
      filepath: t.filepath,
      status: t.status,
      type: t.type,
      command: t.command,
    }))
  }

  getRunningTasks(): TaskRecord[] {
    return Array.from(this.tasks.values()).filter(t => t.status === 'running')
  }

  /**
   * 订阅任务的流式输出（UI 打开任务详情面板时调用）
   * 立即补发已有输出，后续增量实时推送
   * @returns unwatch 函数，UI 关闭面板时调用
   */
  watchTask(taskId: string, onDelta: (delta: string) => void): () => void {
    if (!this.watchers.has(taskId)) {
      this.watchers.set(taskId, new Set())
    }
    this.watchers.get(taskId)!.add(onDelta)

    // 补发已有输出
    const record = this.tasks.get(taskId)
    if (record?.output) {
      onDelta(record.output)
    }

    return () => {
      this.watchers.get(taskId)?.delete(onDelta)
    }
  }

  /**
   * 为 run_in_background=true 的命令 spawn 独立进程
   */
  spawnBashTask(
    command: string,
    toolUseId: string,
    agentContext: any,
  ): { taskId: string; filepath: string } {
    ensureTaskDir()
    const taskId = crypto.randomBytes(4).toString('hex')
    const filepath = path.join(TASK_OUTPUT_DIR, `${taskId}.output`)

    // 初始化输出文件
    fs.writeFileSync(filepath, '')

    const record: TaskRecord = {
      taskId,
      type: 'Bash',
      command,
      toolUseId,
      filepath,
      status: 'running',
      output: '',
    }
    this.tasks.set(taskId, record)

    const { bin, args } = getShellForSpawn()
    const childProcess = spawn(bin, [...args, command], {
      cwd: process.cwd(),
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      ...(IS_WIN ? { windowsHide: true } : {}),
    })
    record._process = childProcess
    record.pid = childProcess.pid

    logInfo(`[TaskManager] spawnBashTask taskId=${taskId} pid=${childProcess.pid} command=${command}`)

    // emit task:start
    getEventBus().emit('task:start', { taskId, pid: childProcess.pid, command, filepath, status: record.status, type: 'Bash' })

    const appendChunk = (chunk: string) => {
      record.output += chunk
      // 限制内存上限
      if (record.output.length > MAX_OUTPUT_SIZE) {
        record.output = record.output.slice(-MAX_OUTPUT_SIZE)
      }
      try {
        fs.appendFileSync(filepath, chunk)
      } catch (e) {
        logWarn(`[TaskManager] appendFileSync 失败: ${e}`)
      }
      this._notifyWatchers(taskId, chunk)
    }

    childProcess.stdout?.on('data', (data: Buffer) => appendChunk(data.toString()))
    childProcess.stderr?.on('data', (data: Buffer) => appendChunk(data.toString()))

    childProcess.on('exit', (code) => {
      const exitCode = code ?? 1
      logInfo(`[TaskManager] task ${taskId} exited with code ${exitCode}`)
      this._finishTask(record, exitCode)
    })

    childProcess.on('error', (error) => {
      logError(`[TaskManager] task ${taskId} process error: ${error}`)
      appendChunk(`\n[Process error: ${error.message}]`)
      this._finishTask(record, 1)
    })

    return { taskId, filepath }
  }

  /**
   * 接管超时的持久 shell 进程
   */
  takeoverTask(
    ctx: TimeoutTransferContext,
    command: string,
    toolUseId: string,
    agentContext: any,
  ): { taskId: string; filepath: string } {
    ensureTaskDir()
    const taskId = crypto.randomBytes(4).toString('hex')
    const filepath = path.join(TASK_OUTPUT_DIR, `${taskId}.output`)

    // 将超时前的部分输出写入文件
    fs.writeFileSync(filepath, ctx.partialOutput)

    const record: TaskRecord = {
      taskId,
      type: 'Bash',
      command,
      toolUseId,
      filepath,
      status: 'running',
      output: ctx.partialOutput,
      _shellProcess: ctx.shellProcess,
    }
    this.tasks.set(taskId, record)

    const takeoverPid = ctx.shellProcess.pid
    record.pid = takeoverPid

    logInfo(`[TaskManager] takeoverTask taskId=${taskId} pid=${takeoverPid} command=${command}`)
    getEventBus().emit('task:start', { taskId, pid: takeoverPid, command, filepath, status: record.status, type: 'Bash' })

    // 记录已读取的文件偏移量
    let stdoutOffset = ctx.partialOutput.length
    let stderrOffset = 0

    const pollTimer = setInterval(() => {
      try {
        // 检查 shell 进程是否已退出（异常退出）
        const shellExited = ctx.shellProcess.exitCode !== null

        // 读取 stdout 增量
        if (fs.existsSync(ctx.stdoutFile)) {
          const content = fs.readFileSync(ctx.stdoutFile).toString('utf8')
          if (content.length > stdoutOffset) {
            const chunk = content.slice(stdoutOffset)
            stdoutOffset = content.length
            record.output += chunk
            if (record.output.length > MAX_OUTPUT_SIZE) {
              record.output = record.output.slice(-MAX_OUTPUT_SIZE)
            }
            try {
              fs.appendFileSync(filepath, chunk)
            } catch {}
            this._notifyWatchers(taskId, chunk)
          }
        }

        // 读取 stderr 增量
        if (fs.existsSync(ctx.stderrFile)) {
          const content = fs.readFileSync(ctx.stderrFile).toString('utf8')
          if (content.length > stderrOffset) {
            const chunk = content.slice(stderrOffset)
            stderrOffset = content.length
            record.output += chunk
            if (record.output.length > MAX_OUTPUT_SIZE) {
              record.output = record.output.slice(-MAX_OUTPUT_SIZE)
            }
            try {
              fs.appendFileSync(filepath, chunk)
            } catch {}
            this._notifyWatchers(taskId, chunk)
          }
        }

        // 检查 statusFile：命令正常完成
        if (fs.existsSync(ctx.statusFile) && fs.statSync(ctx.statusFile).size > 0) {
          const exitCodeStr = fs.readFileSync(ctx.statusFile, 'utf8').trim()
          const exitCode = Number(exitCodeStr) || 0

          // 先读完最终输出（防止 shell exit handler 删文件后读到空）
          if (fs.existsSync(ctx.stdoutFile)) {
            const content = fs.readFileSync(ctx.stdoutFile).toString('utf8')
            if (content.length > stdoutOffset) {
              const chunk = content.slice(stdoutOffset)
              record.output += chunk
              try {
                fs.appendFileSync(filepath, chunk)
              } catch {}
            }
          }
          if (fs.existsSync(ctx.stderrFile)) {
            const content = fs.readFileSync(ctx.stderrFile).toString('utf8')
            if (content.length > stderrOffset) {
              const chunk = content.slice(stderrOffset)
              record.output += chunk
              try {
                fs.appendFileSync(filepath, chunk)
              } catch {}
            }
          }

          clearInterval(pollTimer)
          record._pollTimer = undefined

          // kill 旧 shell
          killProcess(ctx.shellProcess)

          this._finishTask(record, exitCode)
          return
        }

        // shell 异常退出且没有 statusFile → 失败
        if (shellExited) {
          clearInterval(pollTimer)
          record._pollTimer = undefined
          this._finishTask(record, ctx.shellProcess.exitCode ?? 1)
          return
        }
      } catch (error) {
        logWarn(`[TaskManager] takeoverTask poll error: ${error}`)
      }
    }, 200)

    record._pollTimer = pollTimer

    return { taskId, filepath }
  }

  /**
   * 停止指定任务
   */
  stopTask(taskId: string): boolean {
    const record = this.tasks.get(taskId)
    if (!record) return false

    // 清理定时器
    if (record._pollTimer) {
      clearInterval(record._pollTimer)
      record._pollTimer = undefined
    }

    // kill 进程
    let killed = false
    if (record._process) {
      killed = killProcess(record._process)
    }
    if (record._shellProcess) {
      killed = killProcess(record._shellProcess) || killed
    }

    if (!killed) {
      logWarn(`[TaskManager] stopTask taskId=${taskId} kill failed`)
      return false
    }

    record.status = 'stopped'
    logInfo(`[TaskManager] stopTask taskId=${taskId} pid=${record.pid}`)
    getEventBus().emit('task:end', {
      taskId,
      status: 'stopped',
      summary: `Background bash command stopped`,
    })
    this._pruneFinishedTasks()
    return true
  }

  /**
   * 等待任务完成（Promise）
   * @param onChunk 每次有新增输出时回调，参数为 delta（增量内容）
   */
  waitForTask(taskId: string, timeout: number = 30000, onChunk?: (delta: string) => void, abortSignal?: AbortSignal): Promise<TaskRecord> {
    return new Promise((resolve) => {
      const record = this.tasks.get(taskId)
      if (!record) {
        resolve({ taskId, type: 'Bash', command: '', toolUseId: '', filepath: '', status: 'failed', output: '' })
        return
      }

      if (record.status !== 'running') {
        resolve(record)
        return
      }

      let unwatch: (() => void) | undefined

      if (onChunk) {
        unwatch = this.watchTask(taskId, onChunk)
      }

      const cleanup = () => {
        if (unwatch) unwatch()
        clearTimeout(timer)
        getEventBus().off('task:end', listener)
      }

      const timer = setTimeout(() => {
        cleanup()
        resolve(record)
      }, timeout)

      const listener = (data: any) => {
        if (data.taskId === taskId) {
          cleanup()
          resolve(record)
        }
      }

      getEventBus().on('task:end', listener)

      // 中断支持：停止等待，不影响后台任务本身
      if (abortSignal) {
        if (abortSignal.aborted) {
          cleanup()
          resolve(record)
          return
        }
        abortSignal.addEventListener('abort', () => {
          cleanup()
          resolve(record)
        }, { once: true })
      }
    })
  }

  /**
   * 清理所有资源
   */
  dispose(): void {
    for (const record of this.tasks.values()) {
      if (record.status !== 'running') continue
      try {
        if (record._pollTimer) {
          clearInterval(record._pollTimer)
          record._pollTimer = undefined
        }
        let killed = false
        if (record._process) {
          killed = killProcess(record._process)
        }
        if (record._shellProcess) {
          killed = killProcess(record._shellProcess) || killed
        }
        if (!killed) {
          logWarn(`[TaskManager] dispose: kill failed for taskId=${record.taskId} pid=${record.pid}`)
        }
        record.status = 'stopped'
        getEventBus().emit('task:end', {
          taskId: record.taskId,
          status: 'stopped',
          summary: 'Background bash command stopped',
        })
      } catch (error) {
        logError(`[TaskManager] dispose: error cleaning up taskId=${record.taskId}: ${error}`)
        record.status = 'stopped'
      }
    }
    this.watchers.clear()
  }

  private _notifyWatchers(taskId: string, delta: string) {
    const cbs = this.watchers.get(taskId)
    if (!cbs?.size) return
    cbs.forEach(cb => cb(delta))
  }

  private _finishTask(record: TaskRecord, exitCode: number) {
    if (record.status !== 'running') return

    record.status = exitCode === 0 ? 'completed' : 'failed'
    record.exitCode = exitCode

    // 清理 watchers
    this.watchers.delete(record.taskId)

    getEventBus().emit('task:end', {
      taskId: record.taskId,
      status: record.status,
      summary: `Background bash command ${record.status} (exit code ${exitCode})`,
    })

    this._notify(record)
    this._pruneFinishedTasks()
  }

  /**
   * 清理已结束的任务，只保留最新的 MAX_FINISHED_TASKS 个
   */
  private _pruneFinishedTasks() {
    const finished = Array.from(this.tasks.values())
      .filter(t => t.status !== 'running')
    if (finished.length <= TaskManager.MAX_FINISHED_TASKS) return
    const toRemove = finished.slice(0, finished.length - TaskManager.MAX_FINISHED_TASKS)
    for (const t of toRemove) {
      this.tasks.delete(t.taskId)
      this.watchers.delete(t.taskId)
    }
  }

  private _notify(record: TaskRecord) {
    if (!this.notifyCallback) return
    const msg = `<task-notification>
<task-id>${record.taskId}</task-id>
<tool-use-id>${record.toolUseId}</tool-use-id>
<output-file>${record.filepath}</output-file>
<status>${record.status}</status>
<summary>Background bash command ${record.status} (exit code ${record.exitCode ?? 'N/A'})</summary>
</task-notification>
Read the output file to retrieve the result: ${record.filepath}`
    this.notifyCallback(msg)
  }
}

// 单例
let instance: TaskManager | null = null

export function getTaskManager(): TaskManager {
  if (!instance) {
    instance = new TaskManager()
  }
  return instance
}
