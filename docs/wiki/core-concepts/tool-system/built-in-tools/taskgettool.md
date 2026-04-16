# 任务查询工具 TaskGet

根据任务 ID 获取任务的完整详情，包括描述、状态和依赖关系。

## 参数

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `taskId` | `string` | ✓ | 要查询的任务 ID |

## 基本属性

- **isReadOnly**：`true`（可并发执行）
- **canRunConcurrently**：`true`
- **权限**：无需权限


## 返回结构

```javascript
{
  task: {
    id: string
    subject: string       // 任务标题
    status: string        // pending | in_progress | completed
    description: string   // 详细描述
    activeForm?: string   // spinner 显示文本
    blockedBy: string[]   // 阻塞本任务的任务 ID 列表
    blocks: string[]      // 被本任务阻塞的任务 ID 列表
  } | null                // 任务不存在时为 null
}
```


## 使用场景

- 开始工作前获取任务的完整需求和上下文
- 检查任务的依赖关系（blockedBy 是否已清空）
- 被分配任务后获取完整信息


## 使用示例

```
# 查看任务详情
TaskGet(taskId="1")
→ Task #1: 修复用户认证模块
  Status: in_progress
  Description: LoginService 中 token 校验逻辑有误...
  Blocked by: (无)
```
