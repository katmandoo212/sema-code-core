# 子代理工具 Agent

创建隔离的子代理（SubAgent）执行专项任务，结果返回给主 Agent 继续处理。LLM 侧的工具名为 **`Agent`**。

## 参数

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `description` | `string` | ✓ | 3-5 字的任务简短描述 |
| `prompt` | `string` | ✓ | 详细的任务说明（传给 SubAgent 的完整上下文）|
| `subagent_type` | `string` | — | SubAgent 类型名称（对应 AgentConfig.name），默认 `general-purpose` |
| `run_in_background` | `boolean` | — | 设为 `true` 时直接以后台任务形式运行，主对话立即返回 task id |

> 当核心配置 `disableBackgroundTasks: true` 时，`run_in_background` 字段会被 `buildTools` 从 schema 中剔除，LLM 看不到该参数。

## 基本属性

- **isReadOnly**：`false`（子代理可能执行写操作）
- **canRunConcurrently**：`true`（多个 Agent 实例间状态完全隔离，可与其他可并发工具一起并发）
- **权限**：无需权限
- **递归限制**：SubAgent 不能再创建 SubAgent；后台 Agent 也不能嵌套后台 Agent


## 内置 SubAgent 类型

| 类型名 | 专长 |
|--------|------|
| `Bash` | 命令执行、git 操作、脚本运行 |
| `general-purpose` | 通用多步骤研究和执行任务 |
| `Explore` | 代码库快速探索和搜索 |
| `Plan` | 架构设计和实现方案规划 |

自定义类型通过 Agent 配置文件定义，详见 [Agent 子代理](wiki/core-concepts/advanced-topics/subagents)。


## 状态隔离

每个 SubAgent 拥有完全独立的状态：

- 独立的 `agentId`（随机生成的 nanoid）
- 独立的消息历史（不包含主 Agent 的对话历史）
- 独立的文件读取时间戳
- 独立的 Todo 列表

SubAgent 的工具执行完成后，**只有最终结果**返回给主 Agent。


## 三种执行模式

| 模式 | 触发 | 主对话行为 |
|------|------|-----------|
| 前台 Agent | `run_in_background: false`（默认）| 主对话等待结果 |
| 直接后台 Agent | `run_in_background: true` | 主对话立即拿到 `taskId` 继续 |
| 转后台 Agent | 前台 Agent 运行中由用户/外部调用 `transferAgentToBackground(taskId)` | 由前台变为后台 |

后台 Agent 通过 `TaskOutput` 工具获取结果、`TaskStop` 工具停止，详见 [Agent 后台任务](wiki/core-concepts/task-management/agent-task)。


## 事件

```javascript
// SubAgent 启动
sema.on('task:agent:start', ({ taskId, subagent_type, description, prompt, run_in_background }) => {
  console.log(`[${subagent_type}] 启动: ${description}`)
})

// SubAgent 完成
sema.on('task:agent:end', ({ taskId, status, content }) => {
  // status: 'completed' | 'failed' | 'interrupted'
  console.log(`SubAgent ${status}: ${content.slice(0, 100)}`)
})

// SubAgent 的工具执行（通过 agentId 区分）
sema.on('tool:execution:complete', ({ agentId, toolName, title, summary, content }) => {
  if (agentId !== 'main') {
    console.log(`  [SubAgent ${agentId}] ${toolName}: ${summary}`)
  }
})
```

SubAgent **不触发**以下主 Agent 专用事件：
`state:update`、`conversation:usage`、`todos:update`、`topic:update`


## 使用示例

```
# 让 Explore 代理分析认证系统
subagent_type: "Explore"
description: "分析认证系统"
prompt: "请找到所有与用户认证相关的文件，理解认证流程（登录、token验证、权限检查），
总结关键数据结构和接口，以及使用的第三方库。"

# 让 Plan 代理设计重构方案
subagent_type: "Plan"
description: "设计重构方案"
prompt: "基于现有代码，为认证系统从 session-based 迁移到 JWT 设计详细的实施方案，
包括：影响范围分析、分步迁移计划、风险评估。"

# 直接以后台模式跑长任务
subagent_type: "general-purpose"
description: "全量回归"
prompt: "对 src/ 下所有模块跑一次单元测试并汇总结果"
run_in_background: true
```
