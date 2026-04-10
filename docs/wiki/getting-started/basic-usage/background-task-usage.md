# 后台任务使用

Sema Code Core 支持把长耗时操作放到后台运行：长时间的 Bash 命令、复杂的 SubAgent 任务都可以脱离主对话循环独立执行，主代理不被阻塞。

## 两类后台任务

| 类型 | 触发方式 | 完成通知 |
|------|---------|---------|
| **Bash 后台** | `Bash` 工具的 `run_in_background: true`，或同步命令超时被自动接管 | `<task-notification>` 含输出文件路径，AI 用 `TaskOutput` 工具读取 |
| **Agent 后台** | `Agent` 工具的 `run_in_background: true`，或前台 Agent 被 `transferAgentToBackground` 转后台 | `<task-notification>` 直接含完整结果与 token/tool_uses 统计 |

> 任务结束（含 killed）后，TaskManager 会把通知作为 silent 输入注入主对话队列，主代理在下一轮看到结果。

## 限流与配置

| 参数 | 默认值 | 含义 |
|------|--------|------|
| `MAX_RUNNING_TASKS` | 5 | 同时运行的任务上限 |
| `MAX_FINISHED_TASKS` | 10 | 已结束任务的归档上限 |
| `MAX_OUTPUT_SIZE` | 2 MB | 单任务在内存中的滚动输出上限 |
| 输出目录 | `os.tmpdir()/sema-tasks/` | 每个任务一个 `<taskId>.output` 文件 |

### 关闭后台任务

```javascript
const sema = new SemaCore({
  workingDir: '/path/to/project',
  disableBackgroundTasks: true,   // Bash/Agent 工具的 run_in_background 字段会从 schema 中过滤
})
```

LLM 看不到 `run_in_background` 字段，超时也不会接管，等同于禁用后台能力。

## 让 LLM 触发后台任务

后台任务由 LLM 自主决定何时开启，调用方无需介入。当 LLM 调用工具时传入 `run_in_background: true`，工具会立即返回一段说明：

```
Bash:
"Command running in background. Task ID: <id>. Output: <filepath>"

Agent:
"Async agent launched successfully. agentId: <taskId> ..."
```

主代理可继续处理其它请求；任务完成后下一轮自动看到通知。

> 想引导 LLM 多用后台任务，可以在 `customRules` 或 `AGENTS.md` 中加一句："对于预计超过 30 秒的命令优先放到后台运行"。

## 用户操作 API

```javascript
// 列出所有后台任务（不含前台 Agent）
const list = sema.getTaskList()
list.forEach(t => {
  console.log(`[${t.taskId}] ${t.type} ${t.status} ${t.command}`)
})

// 流式订阅某个任务的输出（UI 打开任务面板时）
const unwatch = sema.watchTask(taskId, (delta) => {
  process.stdout.write(delta)
})
// 关闭面板时
unwatch()

// 停止任务
sema.stopTask(taskId)
sema.stopAllTasks()

// 把运行中的前台 Agent 转为后台
sema.transferAgentToBackground(taskId)
sema.transferAllForegroundAgents()  // 批量
```

## 事件

```javascript
sema.on('task:start', ({ taskId, type, command, filepath, status, agentType }) => {
  console.log(`后台任务启动: ${taskId} (${type})`)
})

sema.on('task:end', ({ taskId, status, summary }) => {
  console.log(`后台任务结束: ${taskId} → ${status}: ${summary}`)
})

sema.on('task:transfer', ({ taskId, from, to }) => {
  console.log(`任务转移: ${taskId} ${from} → ${to}`)
})
```

## 典型场景

### 1. 用户在 UI 上把"耗时较长的探索"转后台

```javascript
// 用户点击 UI 上的"转后台"按钮
sema.transferAgentToBackground(currentForegroundTaskId)
// → 主对话立刻回到 idle，可继续接收用户输入
// → 子代理在后台继续执行，完成后自动注入通知
```

### 2. 后台任务面板

```javascript
function renderTaskPanel() {
  const tasks = sema.getTaskList()
  return tasks.map(t => ({
    id: t.taskId,
    type: t.type,
    cmd: t.command,
    status: t.status,
    duration: (t.endTime ?? Date.now()) - t.startTime,
  }))
}

sema.on('task:start', renderTaskPanel)
sema.on('task:end',   renderTaskPanel)
```

### 3. 流式查看长跑命令

```javascript
const taskId = 'xxxx'   // 来自 task:start 事件
const unwatch = sema.watchTask(taskId, delta => panel.append(delta))

// 任务结束时取消订阅
sema.once('task:end', (e) => {
  if (e.taskId === taskId) unwatch()
})
```

## 主要限制

- **子代理不允许嵌套后台任务**：SubAgent 内部调用 `Bash` / `Agent` 时即使传 `run_in_background: true` 也会被强制前台
- **会话切换会清空所有后台任务**：`createSession` 会调用 `TaskManager.dispose()`，包括会话切换流程内的隐式调用
- **前台 Agent 不在 `getTaskList()` 中**：前台 Agent 仍占用一个 `MAX_RUNNING_TASKS` 名额，但不在列表中（避免 UI 误以为有"游离"任务）

## 进一步了解

后台任务的完整调度模型、`TaskRecord` 数据结构、超时接管机制、前后台 Agent 的 `Promise.race` 协作流程：

- [概述](wiki/core-concepts/task-management/overview)
- [Bash 后台任务](wiki/core-concepts/task-management/bash-task)
- [Agent 后台任务](wiki/core-concepts/task-management/agent-task)
