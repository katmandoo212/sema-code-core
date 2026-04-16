# 任务更新工具 TaskUpdate

更新任务的状态、内容和依赖关系。

## 参数

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `taskId` | `string` | ✓ | 要更新的任务 ID |
| `subject` | `string` | — | 新的任务标题 |
| `description` | `string` | — | 新的任务描述 |
| `activeForm` | `string` | — | 进行中状态时 spinner 显示的文本 |
| `status` | `string` | — | 新状态：`pending` / `in_progress` / `completed` / `deleted` |
| `addBlocks` | `string[]` | — | 添加被本任务阻塞的任务 ID 列表 |
| `addBlockedBy` | `string[]` | — | 添加阻塞本任务的任务 ID 列表 |
| `owner` | `string` | — | 任务负责人 |
| `metadata` | `object` | — | 要合并的元数据（值设为 null 可删除对应 key） |

## 基本属性

- **isReadOnly**：`false`
- **canRunConcurrently**：`true`（多个更新可并发）
- **权限**：无需权限


## 状态流转

```
pending → in_progress → completed
                ↘ deleted（永久删除）
```

- 开始工作前将任务设为 `in_progress`
- 工作完成后设为 `completed`（仅在任务完全完成时）
- 设为 `deleted` 会永久删除任务

> 遇到错误或阻塞时，保持 `in_progress` 状态，不要标记为 `completed`。


## 依赖管理

`addBlocks` 和 `addBlockedBy` 会建立双向阻塞关系：

```
TaskUpdate(taskId="2", addBlockedBy=["1"])
→ 任务 #2 被任务 #1 阻塞（#1 完成前 #2 不应开始）
→ 同时任务 #1 的 blocks 列表中会出现 #2
```


## 使用示例

```
# 开始工作
TaskUpdate(taskId="1", status="in_progress")

# 完成任务
TaskUpdate(taskId="1", status="completed")

# 删除任务
TaskUpdate(taskId="3", status="deleted")

# 建立依赖
TaskUpdate(taskId="2", addBlockedBy=["1"])

# 认领任务
TaskUpdate(taskId="1", owner="agent-1")
```
