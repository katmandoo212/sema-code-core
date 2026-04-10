# 后台任务输出工具 TaskOutput

读取由 [Bash](wiki/core-concepts/tool-system/built-in-tools/bashtool) 或 [Agent](wiki/core-concepts/tool-system/built-in-tools/tasktool) 工具以 `run_in_background: true` 启动的后台任务输出。可阻塞等待完成，也可立即拿快照。

## 参数

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `task_id` | `string` | ✓ | 后台任务 ID（由启动它的工具返回） |
| `block` | `boolean` | — | 是否阻塞等待任务完成，默认 `true` |
| `timeout` | `number` | — | `block=true` 时最大等待毫秒数，默认 `30000` |

## 基本属性

- **isReadOnly**：`true`（不修改任何状态）
- **supportsInterrupt**：`true`（阻塞等待时可被中断，返回当前快照与 `not_ready` 标记）
- **权限**：无需权限


## 返回结构

```javascript
{
  taskId: string          // 任务 ID
  retrievalStatus: string // completed | timeout | not_ready | running | completed | failed | not_found
  taskStatus: string      // 实际任务状态
  taskType: string        // 'Bash' | 'Agent' | ''
  output: string          // 任务输出（截断后）
}
```

`retrievalStatus` 的几种典型语义：

| 值 | 含义 |
|----|------|
| `completed` | 阻塞期间任务正常结束，`output` 为完整输出 |
| `timeout` | 等待超时但任务仍在跑，`output` 为已采集的部分 |
| `not_ready` | `block=true` 期间被中断（用户 abort），`output` 为已采集的部分 |
| `not_found` | 无此 `task_id` |
| 其它 | 直接对应任务的当前 `status`（`running` / `completed` / `failed`）|


## 行为细节

- `block=false` 或任务已结束：立即返回当前快照
- `block=true` 且任务运行中：等待任务结束或超时
- 主代理监听到 Bash 类后台任务的增量输出时，会通过 `tool:execution:chunk` 事件实时推送，UI 可在结果面板中流式渲染。Agent 类后台任务无增量推送
- 输出会经过 `formatOutput` 截断（保留头尾）后再返回


## 使用示例

```
# 启动后台命令
Bash(command="npm run build", run_in_background=true)
→ 返回 task id，例如 "ab12cd34"

# 阻塞最多 60 秒等待结果
TaskOutput(task_id="ab12cd34", timeout=60000)

# 立刻拿快照（不等待）
TaskOutput(task_id="ab12cd34", block=false)
```

详细的后台任务生命周期见 [Bash 后台任务](wiki/core-concepts/task-management/bash-task) 与 [Agent 后台任务](wiki/core-concepts/task-management/agent-task)。
