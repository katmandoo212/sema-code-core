# Bash 后台任务

Bash 后台任务由 `Bash` 工具与 `TaskManager` 协作实现，分两条入口路径：

1. **主动后台**：LLM 调用 `Bash` 工具时显式传入 `run_in_background: true`
2. **超时接管**：同步执行的 Bash 命令超过 `timeout` 时，自动接管底层持久 shell 进程并转为后台任务

两种路径最终都会在 `TaskManager.tasks` 中创建一条 `type: 'Bash'` 的记录。

## 触发约束

- 仅主代理（`agentId === MAIN_AGENT_ID`）允许后台任务，子代理强制前台
- 核心配置 `disableBackgroundTasks: true` 时：
  - `buildTools` 会从 `Bash` 的 schema 中过滤 `run_in_background` 字段
  - 即便 LLM 强行传入也会被忽略
  - 超时处理 `onTimeout` 回调不再注册，超时直接 kill
- `MAX_RUNNING_TASKS = 5` 限流：超出时 `spawnBashTask` / `takeoverTask` 抛错

## 路径一：主动后台 spawnBashTask

调用链：

```
Bash 工具 (run_in_background: true)
   │
   ▼
TaskManager.spawnBashTask(command, toolUseId, agentContext)
   │
   ├─ 检查 MAX_RUNNING_TASKS
   ├─ ensureTaskDir() + 生成 taskId（4 字节 hex）
   ├─ 初始化输出文件 <tmpdir>/sema-tasks/<taskId>.output
   ├─ 创建 TaskRecord（type: 'Bash', status: 'running'）
   ├─ spawn 子进程（getShellForSpawn 返回的 shell + 命令字符串）
   │     stdio: ['ignore', 'pipe', 'pipe']
   │     Windows: windowsHide: true
   ├─ emit task:start
   │
   ├─ stdout/stderr 'data' 监听 → appendChunk
   │     ├─ 累加到 record.output（受 MAX_OUTPUT_SIZE 滚动限制）
   │     ├─ fs.appendFileSync 落盘
   │     └─ _notifyWatchers 推送增量给所有 watchers
   │
   ├─ 'exit' 事件 → _finishTask(record, exitCode ?? 1)
   └─ 'error' 事件 → 追加 [Process error: ...] + _finishTask(record, 1)
```

工具的返回值：

```
"Command running in background. Task ID: <taskId>. Output: <filepath>"
```

LLM 在下一轮可以通过 `TaskOutput` 工具或 `<task-notification>` 通知拿到结果。

## 路径二：超时接管 takeoverTask

主代理在前台执行 Bash 命令时，`PersistentShell.exec` 接受 `onTimeout` 回调。当命令运行超出 `timeout` 时（默认 `DEFAULT_TIMEOUT_MS`，最大 `MAX_TIMEOUT_MS`），`onTimeout` 被触发：

```javascript
const onTimeout = (ctx: TimeoutTransferContext) => {
  const result = getTaskManager().takeoverTask(
    ctx, command, currentToolUseID, agentContext,
  )
  bgTaskId = result.taskId
  bgFilepath = result.filepath
}
```

`TimeoutTransferContext` 包含：

| 字段 | 含义 |
|------|------|
| `shellProcess` | 仍在运行的持久 shell 进程对象 |
| `partialOutput` | 已收集的输出（拼接好的 stdout+stderr） |
| `stdoutFile` / `stderrFile` | shell 写入的临时文件路径 |
| `statusFile` | 命令完成后写入退出码的文件路径 |

`takeoverTask` 的执行流程：

```
1. 检查 MAX_RUNNING_TASKS（超出 → killProcess(shellProcess) 后抛错）
2. 生成 taskId / filepath，把 partialOutput 写入新输出文件
3. 创建 TaskRecord（type: 'Bash', _shellProcess: ctx.shellProcess）
4. emit task:start
5. setInterval 200ms 轮询：
   ├─ 增量读取 stdoutFile / stderrFile（按 stdoutOffset / stderrOffset 偏移）
   │     → 追加到 record.output + 输出文件 + 通知 watchers
   ├─ 检测 statusFile 非空 → 命令正常完成
   │     → 读完最后一段输出（防止 shell exit handler 删文件）
   │     → killProcess(shellProcess)
   │     → _finishTask(record, exitCode)
   └─ 检测 shellProcess.exitCode 非 null（异常退出且无 statusFile）
         → _finishTask(record, exitCode ?? 1)
```

主代理工具调用的返回值：

```
"Command timed out after <duration>, moved to background.
Task ID: <bgTaskId>.
Output: <bgFilepath>"
```

> 这条路径的优势是用户/LLM 不会因为某条同步命令"卡住"主对话——它会自动变成后台任务，主代理可以继续做别的事。

## 完成与清理

`_finishTask(record, exitCode)`：

1. 状态从 `running` 切到 `completed`（exit=0）或 `failed`（其它）
2. 记录 `exitCode` / `endTime`
3. 删除该任务的 watchers（避免后续无用回调）
4. emit `task:end { taskId, status, summary }`
5. 调用 `_notify(record)`（前台任务不会走到这里，故无需判断）
6. `_pruneFinishedTasks` 把已结束任务裁剪到 `MAX_FINISHED_TASKS`

`stopTask(taskId)`：

1. 清理 `_pollTimer`（如果是接管任务）
2. `killProcess(_process)` 或 `killProcess(_shellProcess)`
3. 状态置为 `killed`，emit `task:end`
4. **Bash 任务不在 stopTask 中调用 `_notify`**（只有 Agent 的 stopTask 会发通知）

## 通知格式

Bash 任务的通知文本：

```
<task-notification>
<task-id>{taskId}</task-id>
<tool-use-id>{toolUseId}</tool-use-id>
<output-file>{filepath}</output-file>
<status>{status}</status>
<summary>Background bash command {status} (exit code {exitCode ?? 'N/A'})</summary>
</task-notification>
Read the output file to retrieve the result: {filepath}
```

LLM 看到通知后，通常会主动调用 `Read` 或 `TaskOutput` 工具去读 `filepath`，从而获得完整命令输出。

## 用户操作 API

```javascript
// 列表（仅含非前台 Bash/Agent 任务）
sema.getTaskList()

// 流式订阅输出（UI 打开任务详情面板时）
const unwatch = sema.watchTask(taskId, delta => panel.append(delta))
// 关闭面板时
unwatch()

// 停止
sema.stopTask(taskId)
sema.stopAllTasks()
```

## 与 TaskOutput / TaskStop 内置工具的关系

LLM 自身可以通过两个工具与后台任务交互：

- **TaskOutput**：读取指定任务的 `filepath` 获取完整输出
- **TaskStop**：调用 `stopTask(taskId)` 主动停止后台任务

它们封装的就是 `TaskManager` 的同名能力，因此 LLM 不需要直接 `Read` 输出文件。
