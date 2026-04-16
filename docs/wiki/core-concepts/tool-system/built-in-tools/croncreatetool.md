# 定时任务创建工具 CronCreate

创建定时任务，按 cron 表达式调度 prompt 的执行。支持周期性任务和一次性提醒。

## 参数

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `cron` | `string` | ✓ | 标准 5 字段 cron 表达式（本地时区）：`分 时 日 月 周` |
| `prompt` | `string` | ✓ | 每次触发时要执行的 prompt |
| `recurring` | `boolean` | — | `true`（默认）= 周期性执行直到删除或 7 天后自动过期；`false` = 仅执行一次后自动删除 |
| `durable` | `boolean` | — | `true` = 持久化到 `.sema/scheduled_tasks.json`，重启后恢复；`false`（默认）= 仅内存，会话结束即销毁 |

## 基本属性

- **isReadOnly**：`false`
- **canRunConcurrently**：`true`
- **权限**：需要用户确认
- **限制**：仅主代理可用，子代理调用会被拒绝


## 验证规则

- cron 表达式必须为合法的 5 字段格式
- 至少在 31 天内有一次匹配
- 任务总数不能超过上限（`MAX_TASKS`）


## 一次性任务 vs 周期性任务

### 一次性（`recurring: false`）

适用于 "X 点提醒我做 Y" 的场景，触发一次后自动删除：

```
# 今天下午 2:30 提醒检查部署
CronCreate(cron="30 14 16 4 *", prompt="检查部署状态", recurring=false)
```

### 周期性（`recurring: true`，默认）

适用于 "每隔 N 分钟" / "每天早上 9 点" 的场景：

```
# 每 5 分钟检查一次
CronCreate(cron="*/5 * * * *", prompt="检查构建状态")

# 工作日早上 9 点（避开整点，分散负载）
CronCreate(cron="57 8 * * 1-5", prompt="运行日常检查")
```

> 周期性任务 7 天后自动过期。


## 持久化

| `durable` | 存储方式 | 生命周期 |
|-----------|---------|---------|
| `false`（默认） | 内存 | 会话结束即销毁 |
| `true` | `.sema/scheduled_tasks.json` | 重启后自动恢复 |

仅在用户明确要求持久化时使用 `durable: true`。


## 使用示例

```
# 每小时检查（避开整点）
CronCreate(cron="7 * * * *", prompt="检查 CI 状态并汇报")
→ Scheduled recurring job abc123 (every hour at :07)

# 一次性提醒
CronCreate(cron="30 14 16 4 *", prompt="提醒用户参加会议", recurring=false)
→ Scheduled one-shot job def456

# 持久化的每日任务
CronCreate(cron="3 9 * * 1-5", prompt="运行日报生成", durable=true)
→ Scheduled recurring job ghi789. Persisted to .sema/scheduled_tasks.json.
```

使用 [CronDelete](wiki/core-concepts/tool-system/built-in-tools/crondeletetool) 取消任务，使用 [CronList](wiki/core-concepts/tool-system/built-in-tools/cronlisttool) 查看所有任务。
