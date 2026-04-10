# 后台任务停止工具 TaskStop

停止由 [Bash](wiki/core-concepts/tool-system/built-in-tools/bashtool) 或 [Agent](wiki/core-concepts/tool-system/built-in-tools/tasktool) 工具以 `run_in_background: true` 启动的后台任务。

## 参数

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `task_id` | `string` | ✓ | 要停止的后台任务 ID |

## 基本属性

- **isReadOnly**：`false`（影响外部状态）
- **权限**：默认需要确认（与其它非只读工具一致）


## 返回结构

```javascript
{
  taskId: string    // 任务 ID
  message: string   // 人类可读的结果说明
  taskType: string  // 'Bash' | 'Agent' | ''
  command: string   // 任务对应的 command（Bash 是命令，Agent 是 description）
  stopped: boolean  // 是否成功停止
}
```

行为：

| 情况 | 返回 |
|------|------|
| 任务不存在 | `stopped=false`，`message: Task <id> not found.` |
| 任务已结束 | `stopped=false`，`message: Task is not running (status: ...).` |
| 成功停止 | `stopped=true`，`message: Successfully stopped task: <id> (<command>)` |
| 进程已退出 | `stopped=false`，`message: Failed to stop task ... process may have already exited.` |

底层实现：

- Bash 任务：向子进程发送终止信号
- Agent 任务：触发独立 `AbortController.abort()`，子代理循环退出


## 使用示例

```
# 启动一个长跑的后台命令
Bash(command="npm run dev", run_in_background=true)
→ taskId = "ab12cd34"

# 之后停止它
TaskStop(task_id="ab12cd34")
```

详细的后台任务生命周期见 [Bash 后台任务](wiki/core-concepts/task-management/bash-task) 与 [Agent 后台任务](wiki/core-concepts/task-management/agent-task)。
