# 子代理

子代理（Subagent）是通过 `Agent` 工具启动的隔离 Agent，在独立上下文中执行任务并将结果返回给主 Agent。子代理与主会话共享同一个 `AbortController`，主会话中断时所有子代理同步中断。

系统内置了 `general-purpose`、`Explore` 和 `Plan` 三个子代理；也可以通过配置文件或插件扩展自定义子代理。

> SubAgent **永远不能**使用 `Agent` 工具（系统自动过滤，防止无限递归）。


## 内置子代理

### general-purpose

通用子代理，默认使用主模型（main），拥有所有工具权限。适用于复杂的多步骤任务、代码搜索和研究型工作。

### Explore

代码库探索专用子代理，擅长快速在大型代码库中搜索和理解代码结构。

**能力**：
- 使用 `Glob`、`Grep`、`Read`、`Bash` 等工具快速探索代码库
- 多轮搜索：根据初步结果调整搜索策略
- 综合分析：汇总多个文件的信息，回答架构级问题
- **只读模式**：严禁创建、修改或删除任何文件；`Bash` 仅允许只读操作
- 默认使用 **haiku**（快速模型），响应更快

**适用场景**：

| 场景 | 示例 |
|------|------|
| 文件定位 | "找到所有处理认证的文件" |
| 关键字搜索 | "搜索所有使用 `deprecated` 标记的函数" |
| 架构理解 | "解释这个项目的路由系统是如何工作的" |
| 依赖分析 | "找出哪些模块依赖了 UserService" |

### Plan

架构规划专用子代理，用于在实现任务前设计方案、评估选项和创建分步计划。

**能力**：
- 探索代码库，理解现有架构（工具：`Bash`、`Glob`、`Grep`、`Read`）
- 设计实现方案，评估多种技术选型的权衡
- 创建结构化的分步执行计划，并列出关键文件
- **只读模式**：严禁修改任何文件
- 默认使用 **主模型**（main），推理能力更强

**与 Plan 模式的区别**：

| 特性 | Plan 子代理 | Plan 模式 |
|------|------------|----------|
| 运行方式 | 隔离的子 Agent | 主 Agent 的运行模式 |
| 影响范围 | 不影响主对话历史 | 影响当前会话 |
| 退出方式 | 任务完成自动结束 | 需要用户响应 ExitPlanMode |
| 适用场景 | 需要独立规划子任务 | 整体规划后再实现 |


## 使用方法

子代理通过 `Agent` 工具调用，主要参数：

| 参数 | 类型 | 说明 |
|------|------|------|
| `description` | `string` | 任务简短描述（3-5 词） |
| `prompt` | `string` | 完整的任务描述 |
| `subagent_type` | `string` | 子代理类型名称，默认 `'general-purpose'` |
| `run_in_background` | `boolean` | 是否后台运行（可选） |

```javascript
// AI 在对话中调用 Agent 工具：
{
  subagent_type: 'Explore',
  description: '探索认证系统',
  prompt: `请全面分析这个项目的认证系统：
  1. 找到所有认证相关文件
  2. 理解认证流程（登录、token 验证、权限检查）
  3. 识别使用的第三方库
  4. 总结关键的数据结构和接口`,
}
```

### 前台与后台执行

- **前台**（默认）：主 Agent 等待子代理完成后继续
- **后台**（`run_in_background: true`）：子代理在后台独立运行，主 Agent 继续对话，完成后自动通知


## 自定义子代理

通过创建 Agent 配置文件，可以定义专用于特定任务的子代理。

### Agent 文件格式

Agent 配置文件是带 YAML frontmatter 的 Markdown 文件：

```markdown
---
name: code-reviewer
description: 专业代码审查代理，擅长发现潜在问题和改进机会
tools:
  - Read
  - Glob
  - Grep
  - Bash
model: haiku
---

# 代码审查代理

你是一位拥有 10 年经验的资深软件工程师，专精于代码质量审查。

## 审查标准

1. **安全漏洞**：OWASP Top 10 问题
2. **性能问题**：N+1 查询、内存泄漏
3. **错误处理**：未捕获的异常
4. **代码规范**：命名规范、注释质量
```

### 字段说明

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `name` | `string` | ✓ | 唯一名称（`Agent` 工具中用 `subagent_type` 引用） |
| `description` | `string` | ✓ | 功能描述（AI 据此选择合适的 Agent） |
| `tools` | `string[] \| '*'` | — | 可用工具列表，`'*'` 表示所有工具（默认） |
| `model` | `string` | — | 使用的模型，默认 `'haiku'` |

Markdown 正文是 Agent 的系统提示词（prompt）。


### 存放位置与优先级

| 级别 | 路径 | 适用范围 | 权限 |
|------|------|---------|------|
| Claude 用户级 | `~/.claude/agents/[name].md` | 所有项目 | 只读 |
| Claude 项目级 | `<project>/.claude/agents/[name].md` | 当前项目 | 只读 |
| 内置 | 代码内置 | 全局 | — |
| 插件级 | 插件目录下 `agents/` | 随插件作用域 | 只读 |
| Sema 用户级 | `~/.sema/agents/[name].md` | 所有项目 | 读写 |
| Sema 项目级 | `<project>/.sema/agents/[name].md` | 当前项目 | 读写 |

优先级从低到高（后加载覆盖先加载）：

```
Claude 用户级 → Claude 项目级 → 内置 → 插件 → Sema 用户级 → Sema 项目级
```


## 插件子代理

通过插件安装的 Agent，名称格式为 `插件名:agent名`（如 `my-plugin:reviewer`），`locate` 为 `'plugin'`。

插件 Agent 由 AgentsManager 在加载时自动从已安装且启用的插件中读取，无需手动注册。


## Claude Code 兼容

当 `enableClaudeCodeCompat` 配置启用时（默认），AgentsManager 会自动加载 Claude 路径下的 Agent 配置：

- `~/.claude/agents/` — Claude 用户级
- `<project>/.claude/agents/` — Claude 项目级

Claude 来源的 Agent 通过 `from: 'claude'` 标识，为只读，不可通过 API 修改或删除。


## 管理 API

```javascript
// 查询所有 Agent 信息（有缓存）
const agents = await sema.getAgentsInfo()
// AgentConfig[]: { name, description, tools, model, prompt, locate, from, filePath }

// 强制刷新
await sema.refreshAgentsInfo()

// 添加 Agent（只能写入 Sema 路径）
await sema.addAgentConf({
  name: 'code-reviewer',
  description: '专业代码审查代理',
  tools: ['Read', 'Glob', 'Grep', 'Bash'],
  prompt: '你是一位资深代码审查专家...',
  model: 'haiku',
  locate: 'user',   // 必填：'user' 或 'project'
})

// 移除 Agent（Claude 来源和内置 Agent 不可移除）
await sema.removeAgentConf('code-reviewer')
```

### AgentConfig 结构

```typescript
interface AgentConfig {
  name: string
  description: string
  tools?: string[] | '*'         // 可用工具，默认 '*'
  model?: string                 // 模型，默认 'haiku'
  prompt: string                 // 系统提示词
  locate?: AgentScope            // 'user' | 'project' | 'builtin' | 'plugin'
  from?: 'sema' | 'claude'      // 来源
  filePath?: string              // 配置文件路径
}
```


## 事件监听

所有子代理的生命周期事件均通过以下事件上报：

```javascript
sema.on('task:agent:start', ({ taskId, subagent_type, description }) => {
  console.log(`子代理启动 [${subagent_type}]: ${description}`)
})

sema.on('task:agent:end', ({ taskId, status, content }) => {
  // status: 'completed' | 'interrupted' | 'failed'
  console.log(`子代理结束 [${status}]`)
  // content 包含统计摘要（token 用量、工具调用次数等）
})
```


## 最佳实践

**专注单一职责**：每个 Agent 专注一类任务，避免"万能 Agent"

**明确工具限制**：根据任务需要精确配置 `tools`，最小权限原则

**结构化输出**：在提示词中明确输出格式，方便主 Agent 处理结果

**选择合适模型**：
- 代码分析、复杂推理：`model: main` 或高能力模型
- 快速搜索、简单任务：`model: haiku`（默认，快速低成本）
