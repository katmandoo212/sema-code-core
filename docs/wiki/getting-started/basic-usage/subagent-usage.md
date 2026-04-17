# SubAgent 使用

SubAgent 是在隔离上下文中运行的专用子代理。每个 SubAgent 拥有独立的消息历史和状态，专注于特定类型的任务（如代码探索、架构设计、批量分析等），通过 `Agent` 工具由主代理调起。

## AgentConfig 接口

```typescript
interface AgentConfig {
  name: string                       // Agent 唯一名称（subagent_type 调用时使用）
  description: string                // 功能描述（AI 据此选择合适的 Agent）
  prompt: string                     // 系统提示词（Markdown 正文）
  tools: string[] | '*'              // 可用工具列表，'*' 表示所有工具
  model: string                      // 'quick' / 'haiku' → quick 模型；其它值 → main 模型
  locate?: 'user' | 'project' | 'builtin' | 'plugin'
  from?: string                      // 'sema' / 'claude' / 'plugin'
  filePath?: string
}
```


## 存放位置与优先级

按从高到低的顺序：

| 优先级 | 来源 | 路径 |
|-------|------|------|
| 1（最高） | Sema 项目级 | `<project>/.sema/agents/[name].md` |
| 2 | Sema 用户级 | `~/.sema/agents/[name].md` |
| 3 | 插件级 | 已安装且启用的插件提供的 agents |
| 4 | 内置 | `defaultBuiltInAgentsConfs`（代码内置） |
| 5 | Claude 项目级 | `<project>/.claude/agents/[name].md` |
| 6（最低） | Claude 用户级 | `~/.claude/agents/[name].md` |

> Claude 来源由 `enableClaudeCodeCompat` 控制。同名 Agent，**后加载（更高优先级）的覆盖先加载的**。


## Agent 文件格式

```markdown
---
name: database-expert
description: 专精数据库设计与优化的代理
tools:
  - Bash
  - Read
  - Glob
  - Grep
model: main
---

你是一位数据库专家，专精于：
- SQL 查询优化和索引设计
- 数据库 Schema 设计
- PostgreSQL / MySQL / SQLite 的最佳实践

分析数据库相关问题时，请给出具体的优化建议和 SQL 示例。
```

`tools` 字段也支持逗号分隔字符串：`tools: Bash, Read, Glob`，或单字符串 `tools: '*'`。


## 内置 Agent

系统内置以下 Agent，可在 `Agent` 工具中通过 `subagent_type` 指定：

| 名称 | 模型 | 工具 | 用途 |
|------|------|------|------|
| `general-purpose` | main | `*` | 通用研究、复杂搜索、多步任务 |
| `Explore` | quick | `Bash, Glob, Grep, Read, TaskCreate, TaskGet, TaskUpdate, TaskList` | 代码库快速探索（**只读**） |
| `Plan` | main | `Bash, Glob, Grep, Read, TaskCreate, TaskGet, TaskUpdate, TaskList` | 实施方案设计、技术评估（**只读**） |

> `Explore` 与 `Plan` 在 prompt 中明确禁止任何写入/修改操作；即使 `tools` 中包含 `Bash`，也只允许只读 shell 命令。


## 查看与管理 Agent

```javascript
// 查看所有可用 Agent（异步，含缓存）
const agents = await sema.getAgentsInfo()
agents.forEach(a => {
  console.log(`${a.name} [${a.locate}/${a.from}]: ${a.description}`)
})

// 强制刷新（从磁盘重新加载）
await sema.refreshAgentsInfo()

// 添加自定义 Agent（locate 必须为 'user' 或 'project'）
await sema.addAgentConf({
  name: 'my-agent',
  description: '我的自定义代理',
  tools: ['Read', 'Glob', 'Grep', 'Bash'],
  prompt: '你是一个专业的代码质量检查代理...',
  model: 'main',
  locate: 'user',  // 必填：'user' 写入用户目录，'project' 写入项目目录
})

// 删除 Agent（仅 Sema 来源可删，内置/Claude/插件 来源只读）
await sema.removeAgentConf('my-agent')
```

> 这些 API 全部返回 `Promise<AgentConfig[]>`，包含全部 Agent 的最新快照。


## 状态隔离

每个 SubAgent 拥有完全独立的状态：

- **独立消息历史**：SubAgent 的对话不影响主代理
- **独立 agentId**：主代理使用 `'main'`，SubAgent 使用 nanoid 生成的 taskId
- **独立 AbortController**：前台 SubAgent 与主 AC 联动，可通过 `transferAgentToBackground` 解除联动转后台
- **工具限制**：SubAgent 不能调用 `Agent` / `TaskOutput` / `TaskStop` / `AskUserQuestion` / `ExitPlanMode`，从而防止嵌套子代理与等待用户响应


## 前台 vs 后台

`Agent` 工具支持 `run_in_background` 字段，控制子代理是否后台运行：

```javascript
// 主代理调用工具的语义示意（实际由 LLM 决定）
{
  name: 'Agent',
  input: {
    description: '探索 src 目录结构',
    prompt: '...',
    subagent_type: 'Explore',
    run_in_background: true,   // 立即返回，不阻塞主对话
  },
}
```

- **前台**（默认）：主代理等待 SubAgent 返回结果
- **后台**：主代理立即拿到 "已启动" 回执，SubAgent 在后台跑；完成后通过 `<task-notification>` 注入主对话
- **运行中转后台**：用户调用 `sema.transferAgentToBackground(taskId)`，前台子代理立刻变后台

> 详见 [后台任务使用](wiki/getting-started/basic-usage/background-task-usage)。


## 事件

SubAgent 运行时触发以下事件：

```javascript
// SubAgent 启动
sema.on('task:agent:start', ({ taskId, subagent_type, description, prompt, run_in_background }) => {
  console.log(`SubAgent 启动 [${taskId}]: ${subagent_type}`)
})

// SubAgent 完成
sema.on('task:agent:end', ({ taskId, status, content }) => {
  console.log(`SubAgent 完成 [${taskId}]: ${status}`)
  // status: 'completed' | 'failed' | 'interrupted'
})

// SubAgent 的工具执行（含 agentId）
sema.on('tool:execution:complete', ({ agentId, toolName, summary }) => {
  if (agentId !== 'main') {
    console.log(`[SubAgent ${agentId}] ${toolName}: ${summary}`)
  }
})
```

SubAgent **不触发** `state:update`、`conversation:usage`、`todos:update` 等主代理专用事件。


## 进一步了解

更深入的 SubAgent 设计、上下文构建、与后台任务的关系，参考 [Agent 子代理](wiki/core-concepts/advanced-topics/subagents) 与 [Agent 后台任务](wiki/core-concepts/task-management/agent-task)。
