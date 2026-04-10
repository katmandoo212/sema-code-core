# Agent 后台任务

Agent 后台任务由 `Agent` 工具与 `TaskManager` 协作实现。Agent 任务的特殊性在于：它不是一个独立的 OS 进程，而是一段在主进程中运行的 LLM 子代理逻辑（`query()` 异步生成器循环），通过独立的 `AbortController` 实现"软中断"。

## 三种执行模式

| 模式 | 触发 | TaskManager 调用 | 是否占用主对话 |
|------|------|------------------|--------------|
| 前台 Agent | `Agent` 工具 `run_in_background: false`（默认）| `registerForegroundAgent` | 主对话等待结果 |
| 后台 Agent | `Agent` 工具 `run_in_background: true` | `spawnAgentTask` | 主对话立即返回 |
| 转后台 Agent | 前台 Agent 运行中调用 `transferAgentToBackground(taskId)` | `transferToBackground` | 由前台变后台 |

> 子代理强制不允许嵌套后台 Agent；`disableBackgroundTasks: true` 时也会跳过 `spawnAgentTask` 与 `setTransferResolve`，从根本上禁用后台模式。

## 路径一：直接后台 spawnAgentTask

LLM 调用 `Agent` 工具时传 `run_in_background: true`：

```
Agent 工具
   │
   ├─ 构建 subagentTools / systemPrompt / userMessage
   ├─ emit task:agent:start { run_in_background: true }
   │
   ▼
TaskManager.spawnAgentTask(taskId, description, toolUseId, executeFn)
   │
   ├─ 检查 MAX_RUNNING_TASKS
   ├─ 创建独立 AbortController（与主代理 AC 完全无联动）
   ├─ ensureTaskDir() + 创建空输出文件
   ├─ 创建 TaskRecord（type: 'Agent', _abortController, agentType）
   ├─ emit task:start { type: 'Agent', agentType }
   │
   ├─ executeFn(bgAbortController) 异步执行
   │     for await (const message of query(...)) { 收集 }
   │     ├─ 成功：return { result, usage: { totalTokens, toolUses, durationMs } }
   │     ├─ 失败/中断：throw
   │     └─ 任意分支 finally：stateManager.forAgent(taskId).clearAllState()
   │
   └─ Promise.then / catch：
        ├─ 成功 → record.output = result + 写入 filepath + _finishTask(0)
        └─ 失败 → 写入 [Agent interrupted] 或 [Agent error: ...] + _finishTask(0/1)
```

工具立即返回（不等待 executeFn）：

```
"Async agent launched successfully.
agentId: <taskId> (internal ID - do not mention to user.)
The agent is working in the background. You will be notified automatically when it completes.
Do not duplicate this agent's work — avoid working with the same files or topics it is using..."
```

主代理可继续处理其它工作。后台 Agent 完成时通过 `_notify` 注入主对话。

## 路径二：前台 Agent + 可选转后台

前台 Agent 是 `Agent` 工具的默认行为，逻辑分布在 `Agent.ts`：

### 1. 共享 / 独立 AbortController 联动

```javascript
const sharedAC = stateManager.currentAbortController   // 主代理 AC
const subAC   = new AbortController()                  // 子代理独立 AC

// 主 AC abort → 子 AC abort
sharedAC.signal.addEventListener('abort', () => subAC.abort())
const unlinkAbort = () => sharedAC.signal.removeEventListener('abort', ...)
```

`unlinkAbort` 是后续转后台的关键 —— 解除联动后，主 AC 再 abort 也不会影响子代理。

### 2. 注册前台占位

```javascript
taskManager.registerForegroundAgent(
  taskId, description, toolUseId, subAC, unlinkAbort, agentConfig.name,
)
```

前台 Agent 在 `tasks` Map 中创建一条 `foreground: true` 的记录，**不出现在 `getTaskList()` 中**（避免 UI 误以为有"游离"任务），但会占用一个 `MAX_RUNNING_TASKS` 名额。

### 3. Promise.race：等结果 vs 等转后台

```javascript
const transferSignal = new Promise<void>(resolve => {
  transferResolve = resolve
})
taskManager.setTransferResolve(taskId, transferResolve)

const raceResult = await Promise.race([
  completionPromise,                                    // 子代理执行完成
  transferSignal.then(() => ({ type: 'transferred' })) // 被转后台
])
```

三种 race 结果：

| 结果 | 处理 |
|------|------|
| `completed` | `taskManager.finalizeTask(taskId, 0, result, usage)`，工具 yield 结果给主对话 |
| `error` | 中断 → `finalizeTask(taskId, 0)`，否则 `finalizeTask(taskId, 1)`，工具 yield 摘要/错误信息 |
| `transferred` | executionPromise 继续在后台跑，工具立即返回。完成回调挂在 `record._promise` 上：成功写入 `filepath` 并 `finalizeTask(0)`；失败 `finalizeTask(0/1)` |

### 4. 转后台 transferToBackground

`SemaCore.transferAgentToBackground(taskId)` → `TaskManager.transferToBackground(taskId)`：

```
1. 校验：record 存在 + foreground === true + status === 'running'
2. 调用 record._unlinkAbort()  // 解除主/子 AC 联动
3. record.foreground = false
4. record._transferResolve()    // 唤醒 Agent.ts 中的 Promise.race
5. emit task:transfer { from: 'foreground', to: 'background' }
```

`transferAllForeground()` 是批量版本，遍历所有 `foreground && running` 的 record 依次调用 `transferToBackground`。

### 5. finalizeTask：统一收尾

`Agent.ts` 在三种 race 结果中都会调用 `taskManager.finalizeTask(taskId, exitCode, output?, usage?)`：

```javascript
finalizeTask(taskId, exitCode, output?, usage?) {
  if (record.status !== 'running') return       // 重入保护
  if (output) record.output = output
  if (usage)  record.usage  = usage
  this._finishTask(record, exitCode)            // → emit task:end + 通知（仅非前台）
}
```

`_finishTask` 内部判断：**前台任务不发通知**（结果由 `Agent.ts` 直接 yield 回主对话）；只有"转后台后完成"或"直接 spawnAgentTask"的任务才会触发 `_notify`。

## 中断行为

| 入口 | 实际效果 |
|------|---------|
| `interruptSession()` | 主 AC abort → 联动到前台子 AC → 子代理在最近的检查点中止；后台 Agent **不受影响** |
| `stopTask(taskId)` | 直接 `record._abortController.abort()`，无论前/后台都会中止；同时 emit `task:end` 与（后台任务的）通知 |
| `dispose()` | 杀掉所有 running 任务（含 abort 所有 Agent），清空 `tasks` 与 `watchers` |

## 通知格式

Agent 任务的通知文本（仅"非前台"任务发出）：

```
<task-notification>
<task-id>{taskId}</task-id>
<tool-use-id>{toolUseId}</tool-use-id>
<status>{status}</status>
<summary>Agent "{description}" {status}</summary>
<result>{full output}</result>
<usage><total_tokens>{N}</total_tokens><tool_uses>{N}</tool_uses><duration_ms>{N}</duration_ms></usage>
</task-notification>
```

> 与 Bash 不同，Agent 通知直接携带完整 `<result>`，主代理无需再读输出文件。

## 与 task:agent:* 事件的区别

`Agent` 工具自身在子代理生命周期内会发出：

- `task:agent:start { taskId, subagent_type, description, prompt, run_in_background }`
- `task:agent:end { taskId, status, content }`

而 `TaskManager` 发出的是：

- `task:start { taskId, command, filepath, status, type: 'Agent', agentType }`
- `task:end { taskId, status, summary }`
- `task:transfer { taskId, from, to }`

两组事件**同源但不同视角**：

- `task:agent:*` 关注的是"LLM 子代理的对话生命周期"，由 `Agent.ts` 主动发出，无论前台/后台都触发，包含完整 prompt/description
- `task:*` 关注的是"被 TaskManager 调度的任务生命周期"，包含进程/输出/转后台等基础设施信息

UI 通常订阅 `task:agent:*` 显示"子代理执行中"卡片，订阅 `task:*` 维护"后台任务面板"。

## 用户操作 API

```javascript
sema.getTaskList()                       // 不含前台 Agent
sema.watchTask(taskId, onDelta)          // Agent 任务的 output 一般在结束时一次性写入
sema.stopTask(taskId)                    // 中止任意运行中的 Agent
sema.transferAgentToBackground(taskId)   // 把单个前台 Agent 转后台
sema.transferAllForegroundAgents()       // 把所有前台 Agent 批量转后台
```

典型场景：用户在 UI 上看到主代理调起了一个耗时较长的子代理，决定让它"在后台跑"，主对话立刻回到 idle —— 这就是 `transferAgentToBackground` 的目标用法。
