import { type ChildProcess } from 'child_process'

export type TaskStatus = 'running' | 'completed' | 'failed' | 'stopped'

/**
 * 后台任务记录
 *
 * 有两种来源：
 * 1. run_in_background=true：Bash 工具直接通过 spawnBashTask() 创建独立子进程
 * 2. 命令执行超时：PersistentShell 将旧 shell 移交给 takeoverTask()，继续轮询其临时文件
 * 3. 异步Agent
 */
export interface TaskRecord {
  /** 任务唯一 ID（随机 4 字节 hex） */
  taskId: string
  /** 进程 ID，用于确认进程是否已终止 */
  pid?: number
  /** 任务类型，Bash Agent */
  type: 'Bash' | 'Agent'
  /** bash命令字符串 或 agent标题 */
  command: string
  /** 触发该任务的 tool_use_id，用于通知回调关联原始请求 */
  toolUseId: string
  /** 任务输出写入的本地临时文件路径（供 TaskOutput 工具读取） */
  filepath: string
  /** 任务当前状态 */
  status: TaskStatus
  /** 内存中缓存的输出内容（上限 2MB，超出时截断保留末尾） */
  output: string
  /** 进程退出码（任务结束后赋值） */
  exitCode?: number
  /** spawnBashTask 创建的独立子进程（run_in_background 路径） */
  _process?: ChildProcess
  /** takeoverTask 接管的旧 PersistentShell 进程（超时路径） */
  _shellProcess?: ChildProcess
  /** takeoverTask 轮询旧 shell 临时文件的定时器 */
  _pollTimer?: ReturnType<typeof setInterval>
  /** Agent 任务专用：独立的 AbortController，用于停止后台 agent */
  _abortController?: AbortController
  /** Agent 任务专用：执行 Promise */
  _promise?: Promise<void>
}

/**
 * 超时接管上下文
 *
 * 当 PersistentShell 执行命令超时时，由 shell.ts 构造并传递给 TaskManager.takeoverTask()。
 * 包含旧 shell 的临时文件路径和进程引用，让 TaskManager 能继续轮询命令的后续输出，
 * 直到命令通过 statusFile 报告完成或 shell 进程异常退出。
 */
export interface TimeoutTransferContext {
  /** 旧 shell 写命令 stdout 的临时文件路径 */
  stdoutFile: string
  /** 旧 shell 写命令 stderr 的临时文件路径 */
  stderrFile: string
  /** 旧 shell 写命令退出码的临时文件路径（非空即代表命令完成） */
  statusFile: string
  /** 旧 PersistentShell 子进程引用（超时后由 TaskManager 负责 kill） */
  shellProcess: ChildProcess
  /** 超时前已读取到的部分输出，作为任务输出的初始内容 */
  partialOutput: string
}

/**
 * 任务列表项（对外暴露的简洁格式）
 */
export interface TaskListItem {
  taskId: string
  pid?: number
  filepath: string
  status: TaskStatus
  type: string
  command: string
}