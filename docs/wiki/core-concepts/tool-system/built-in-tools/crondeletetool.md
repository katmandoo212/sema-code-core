# 定时任务删除工具 CronDelete

取消由 [CronCreate](wiki/core-concepts/tool-system/built-in-tools/croncreatetool) 创建的定时任务。持久化任务会从 `.sema/scheduled_tasks.json` 中移除，会话级任务从内存中移除。

## 参数

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `id` | `string` | ✓ | 任务 ID（由 CronCreate 返回） |

## 基本属性

- **isReadOnly**：`false`
- **canRunConcurrently**：`true`
- **权限**：需要用户确认


## 验证规则

- 任务 ID 必须存在，否则返回错误


## 使用示例

```
# 取消定时任务
CronDelete(id="abc123")
→ Cancelled job abc123
```
