# Rule & Memory

Rule 与 Memory 都是注入到系统提示词的"长期上下文"，但定位不同：

| 维度 | Rule | Memory |
|------|------|--------|
| 目的 | 告诉 AI **怎么做事**（编码规范、回答风格、命令偏好） | 告诉 AI **它已经知道什么**（跨会话沉淀的事实、用户画像、项目背景） |
| 形态 | 单文件 Markdown | 一个 `MEMORY.md` 主文件 + 同目录其它 `.md` 引用文件 |
| 来源 | 用户级 / 项目级 + 兼容 Claude Code 的同名文件 | 项目级（Sema） + 兼容 Claude Code 的项目 memory 目录 |
| 注入时机 | **首次查询**时一次性写入系统提醒，本会话不再重复 | 与 Rule 同步注入 |
| 编辑方式 | 用户/IDE 直接改文件 | 由 Agent 主动写入（写入工具自行管理）+ 用户手工编辑 |

它们与"内联 customRules"（核心配置中的字符串字段）一起，构成 Sema Code Core 的 **三层用户上下文**。

## 三层用户上下文

```
┌─────────────────────────────────────────────────────┐
│ 第 1 层  customRules                                │
│   位置：SemaCoreConfig.customRules（内联字符串）   │
│   用途：极简的运行时偏好（如 "中文回答"）           │
├─────────────────────────────────────────────────────┤
│ 第 2 层  Rule                                       │
│   位置：AGENTS.md / CLAUDE.md（用户级 + 项目级）    │
│   用途：成体系的指令集 / 编码规范 / 风格约束        │
├─────────────────────────────────────────────────────┤
│ 第 3 层  Memory                                     │
│   位置：.sema/memory/MEMORY.md（+ 引用 md 文件）   │
│   用途：跨会话的事实记忆，由 AI 自维护              │
└─────────────────────────────────────────────────────┘
                       │
                       ▼
       generateRulesReminders() 拼接为
       一段 <system-reminder>，仅在首次查询时
       通过 buildAdditionalReminders 注入用户消息
```

## Rule

由 `RuleManager`（`src/services/rules/rulesManager.ts`）单例管理。

### 文件位置 & 优先级

按从高到低的顺序，**取第一个存在且非空的文件**：

| 优先级 | 来源 | 路径 |
|--------|------|------|
| 1（最高） | Sema 项目级 | `<workingDir>/AGENTS.md` |
| 2 | Sema 用户级 | `~/.sema/AGENTS.md` |
| 3 | Claude 项目级 | `<workingDir>/CLAUDE.md` |
| 4（最低） | Claude 用户级 | `~/.claude/CLAUDE.md` |

> Claude Code 的两个文件**只读**。是否启用兼容由核心配置 `enableClaudeCodeCompat` 决定（默认 `true`）；设为 `false` 时只读取 Sema 的两个 `AGENTS.md`。

### RuleConfig 数据结构

```typescript
interface RuleConfig {
  prompt: string                    // 文件内容（trim 后）
  locate?: 'user' | 'project'       // 命中的层级
  from?: 'sema' | 'claude'          // 命中的来源
  filePath?: string                 // 命中的绝对路径
}
```

### 加载流程

1. `RuleManager` 在构造时（即首次 `getRuleManager()` 时）后台静默调用 `refreshRuleInfo()`，把结果缓存到 `ruleInfoCache`
2. `getRuleInfo()` 优先返回缓存；若缓存为 `undefined`，则等待后台 promise 或重新加载
3. 任何文件不存在 / 内容为空都会跳过，继续下一优先级
4. 命中后写日志：`加载 Rule 配置: sema project`（或其它）

### 用法示例

最简单的项目级 Rule —— 在工程根目录建立 `AGENTS.md`：

```markdown
# Project Rules

- 所有命令默认使用 pnpm
- 不要在生产代码中使用 console.log，统一用 logger
- React 组件优先使用函数式 + hooks
- 提交信息遵循 Conventional Commits
```

下一次启动 Sema Core 时，第一轮对话就会自动把这段内容注入系统提醒。

### Sema vs Claude 的命名取舍

`AGENTS.md` 是 Sema 推荐的命名（更通用）；`CLAUDE.md` 是 Claude Code 生态原生命名。**两者优先级 Sema > Claude**，意味着：

- 如果同时存在，Sema 的 `AGENTS.md` 会覆盖 Claude 的 `CLAUDE.md`
- 想从 Claude Code 平滑迁移：什么都不用改，直接用 `CLAUDE.md`
- 想做 Sema 专属规则：建一个 `AGENTS.md`，它会优先于已有的 `CLAUDE.md`


## Memory

由 `MemoryManager`（`src/services/memory/memManager.ts`）单例管理。

### 目录结构

Memory 是**目录形式**（不是单文件），目录中的 `MEMORY.md` 是主入口：

```
.sema/memory/
├── MEMORY.md              # 主 prompt（必须存在）
├── user_role.md           # 引用文件 #1
├── feedback_testing.md    # 引用文件 #2
└── project_state.md       # 引用文件 #3
```

`MEMORY.md` 通常充当索引（每行一个引用文件 + 一句简介），其它 `.md` 文件保存具体记忆条目。`MemoryManager` 加载时只把 `MEMORY.md` 的内容注入系统提醒，其它 `.md` 文件路径会通过 `refFilePath` 暴露给写入工具，让 Agent 知道完整目录结构以便后续读写。

### 文件位置 & 优先级

| 优先级 | 来源 | 路径 |
|--------|------|------|
| 1（最高） | Sema 项目级 | `<workingDir>/.sema/memory/` |
| 2 | Claude 项目级 | `~/.claude/projects/<project-dir-name>/memory/` |

`<project-dir-name>` 由 `projectPathToDirName(<workingDir>)` 计算，规则：
- 路径分隔符替换为 `-`
- 开头加 `-`
- Windows 盘符冒号去掉

例：`/Users/foo/code/project` → `-Users-foo-code-project`

> 与 Rule 不同，Memory 没有"用户级"层 —— 记忆按项目隔离，避免无关项目的事实污染。

### MemoryConfig 数据结构

```typescript
interface MemoryConfig {
  prompt: string         // MEMORY.md 内容
  from?: 'sema' | 'claude'
  FilePath?: string      // MEMORY.md 绝对路径
  refFilePath?: string[] // 同目录其它 .md 文件路径列表
}
```

### 加载流程

与 Rule 一致：构造时后台预加载 + `getMemoryInfo()` 优先取缓存。命中后将 `activeMemoryDir` 设为对应目录，供后续写入工具使用。

### Auto Memory 工作流

Memory 系统的设计意图是**让 Agent 自维护**：

1. Agent 在执行任务过程中遇到值得长期记住的内容（如用户角色、约定、决策）
2. Agent 把记忆条目写入 `.sema/memory/<topic>.md`
3. 同时把一行索引追加到 `MEMORY.md`：`- [Topic](file.md) — one-line hook`
4. 下一次启动 Sema Core 时，`MEMORY.md` 自动被注入系统提醒，Agent 即可看到全部索引

> 主流程中默认不绑定特定的写入工具，写入逻辑由 Agent 自身（通过 `Write` / `Edit` 工具）完成。要让 Agent 主动维护 Memory，建议在 `customRules` 或 `AGENTS.md` 里写明触发条件（例如 "当用户告诉你身份/偏好时，把它存入 .sema/memory/"）。


## customRules（内联）

最轻量的一层。直接写在 `SemaCoreConfig` 中：

```javascript
const sema = new SemaCore({
  workingDir: '/path/to/project',
  customRules: '- 中文回答\n- 输出尽量简洁',
})
```

也可以运行时更新：

```javascript
sema.updateCoreConfByKey('customRules', '- 英文回答')
```

`customRules` 与 Rule、Memory 在同一段 `<system-reminder>` 中拼接注入，标题为 `Custom rules (user-defined instructions):`。


## 注入流程

`Conversation.query` → `SemaEngine.processQuery` → `buildAdditionalReminders` → `generateRulesReminders`：

```javascript
// systemReminder.ts
export function generateRulesReminders(): ContentBlockParam[] {
  const customRulesSection = buildCustomRulesSection()  // customRules
  const ruleSection        = getRuleDescription()        // RuleManager
  const memorySection      = getMemoryDescription()      // MemoryManager

  if (!ruleSection && !customRulesSection && !memorySection) return []

  const sections = [
    customRulesSection,
    ruleSection,
    memorySection,
    buildCurrentDateSection(),    // 当前日期
  ].filter(Boolean).join('\n\n')

  return [{
    type: 'text',
    text: `<system-reminder>
As you answer the user's questions, you can use the following context:

Codebase and user instructions are shown below. Be sure to adhere to these instructions.
IMPORTANT: These instructions OVERRIDE any default behavior and you MUST follow them exactly as written.

${sections}

IMPORTANT: this context may or may not be relevant to your tasks. You should not respond to this context unless it is highly relevant to your task.
</system-reminder>`,
  }]
}
```

**关键点**：

- 仅在 `messageHistory.length === 0`（首次查询）时调用，避免每轮重复
- Plan 模式退出后的"清空上下文重新开始"也会重新触发一次 first-query，从而再次注入
- 整段是一个 `<system-reminder>`，LLM 会遵循 "OVERRIDE any default behavior" 提示
- 末尾自动追加当天日期（`buildCurrentDateSection`），让 AI 有时间感


## SemaCore API

```javascript
// Rule
sema.getRuleInfo(): Promise<RuleConfig | null>
sema.refreshRuleInfo(): Promise<RuleConfig | null>

// Memory
sema.getMemoryInfo(): Promise<MemoryConfig | null>
sema.refreshMemoryInfo(): Promise<MemoryConfig | null>

// customRules
sema.updateCoreConfByKey('customRules', '...')
```

`refreshXxxInfo()` 会清缓存重新读取磁盘，常用于：
- 用户在 IDE 中编辑了 `AGENTS.md` / `MEMORY.md` 后
- `enableClaudeCodeCompat` 配置切换后（SemaCore 内部已自动调用）


## 与 enableClaudeCodeCompat 的关系

```javascript
sema.updateCoreConfByKey('enableClaudeCodeCompat', false)
```

会触发：

1. `PluginsManager.refreshMarketplacePluginsInfo()`
2. `MemoryManager.refreshMemoryInfo()` —— 不再读取 `~/.claude/projects/.../memory/`
3. `RuleManager.refreshRuleInfo()` —— 不再读取 `CLAUDE.md`

设为 `false` 后，整个生态收敛到 Sema 自有的 `.sema/` + `~/.sema/` 目录。


## 实践建议

| 场景 | 选哪一层 |
|------|---------|
| "全局都用中文回答" | `customRules`（一行就够） |
| "本项目用 pnpm，别用 npm/yarn" | 项目级 `AGENTS.md` |
| "团队共用的编码规范、提交规范" | 项目级 `AGENTS.md`，进 git |
| "我个人偏爱的命令、快捷键" | 用户级 `~/.sema/AGENTS.md` |
| "记住用户告诉我他是 Go 开发者" | `.sema/memory/user_role.md` + 索引 |
| "记住上一次发布的版本号 / 决策" | `.sema/memory/release.md` + 索引 |
| 从 Claude Code 迁移项目 | 直接保留 `CLAUDE.md`，无需修改 |

> Rule 是"指令"，Memory 是"事实"。规则不变就放 Rule，事实可能演化就放 Memory。
