# 定时任务列表工具 CronList

列出所有通过 [CronCreate](wiki/core-concepts/tool-system/built-in-tools/croncreatetool) 创建的定时任务，包括持久化任务和会话级任务。

## 参数

无参数。

## 基本属性

- **isReadOnly**：`true`（可并发执行）
- **canRunConcurrently**：`true`
- **权限**：无需权限


## 返回结构

```javascript
{
  jobs: [{
    id: string           // 任务 ID
    cron: string         // cron 表达式
    humanSchedule: string // 人类可读的调度描述
    prompt: string       // 触发时执行的 prompt
    recurring: boolean   // 是否周期性
    durable: boolean     // 是否持久化
    enabled: boolean     // 是否启用
  }]
}
```


## 使用示例

```
CronList()
→ Active cron jobs (2):
  abc123 — every hour at :07 (recurring): 检查 CI 状态
  def456 — Feb 28 at 2:30pm (one-shot): 提醒参加会议
```
