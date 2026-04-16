# 任务列表工具 TaskList

列出当前会话中的所有任务摘要，包括状态和阻塞关系。

## 参数

无参数。

## 基本属性

- **isReadOnly**：`true`（可并发执行）
- **canRunConcurrently**：`true`
- **权限**：无需权限


## 返回结构

```javascript
{
  tasks: [{
    id: string          // 任务 ID
    subject: string     // 任务标题
    status: string      // pending | in_progress | completed
    blockedBy: string[] // 未完成的阻塞任务 ID（已完成的自动过滤）
  }]
}
```

> 已完成任务的阻塞关系会被自动过滤：如果 blockedBy 中的任务已 completed，则不再显示在阻塞列表中。


## 使用场景

- 查看当前可执行的任务（状态为 pending、无阻塞）
- 检查整体工作进度
- 完成一个任务后寻找下一个可执行的任务
- 建议按 ID 升序执行任务（早期任务往往为后续任务提供上下文）


## 使用示例

```
TaskList()
→ #1 [completed] 修复用户认证模块
  #2 [in_progress] 添加单元测试
  #3 [pending] 更新 API 文档 (blocked by #2)
```
