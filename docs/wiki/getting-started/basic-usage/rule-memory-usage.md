# Rule & Memory 使用

Sema Code Core 支持三层"长期上下文"，每次会话首次查询时自动注入到系统提醒，用于约束 AI 行为或提供事实背景。

| 层 | 形态 | 用途 | 谁来写 |
|---|------|------|-------|
| `customRules` | 内联字符串 | 极简偏好（如 "中文回答"） | 调用方 / 用户 |
| Rule | `AGENTS.md` / `CLAUDE.md` | 项目规范、编码风格、命令偏好 | 用户 / IDE |
| Memory | `MEMORY.md` + 同目录 `.md` | 跨会话事实记忆 | AI 自维护 + 用户编辑 |

## 1. customRules（最简单）

直接写在 `SemaCoreConfig`：

```javascript
const sema = new SemaCore({
  workingDir: '/path/to/project',
  customRules: '- 中文回答\n- 输出尽量简洁',
})
```

运行时也可更新：

```javascript
sema.updateCoreConfByKey('customRules', '- 英文回答')
```

## 2. Rule（项目规范）

在工程根目录创建 `AGENTS.md`：

```markdown
# Project Rules

- 所有命令默认使用 pnpm
- 不要在生产代码中使用 console.log，统一用 logger
- React 组件优先使用函数式 + hooks
- 提交信息遵循 Conventional Commits
```

下次启动 Sema Core 时，第一轮对话就会自动注入这段规则。

### 文件优先级（从高到低）

| 来源 | 路径 |
|------|------|
| Sema 项目级 | `<workingDir>/AGENTS.md` |
| Sema 用户级 | `~/.sema/AGENTS.md` |
| Claude 项目级 | `<workingDir>/CLAUDE.md` |
| Claude 用户级 | `~/.claude/CLAUDE.md` |

> 想从 Claude Code 平滑迁移：什么都不用改，直接保留 `CLAUDE.md`。

## 3. Memory（事实记忆）

Memory 是**目录形式**，而不是单文件：

```
.sema/memory/
├── MEMORY.md              # 主入口（必须）
├── user_role.md           # 引用文件
└── feedback_testing.md    # 引用文件
```

`MEMORY.md` 通常充当索引，每行一个引用文件加一句简介；其它 `.md` 文件保存具体记忆条目。最简版本：

```markdown
# Memory Index

- [User](user_role.md) — 用户是 Go 后端工程师，新接触 React
- [Feedback](feedback_testing.md) — 集成测试必须连真实数据库，不能 mock
```

只有 `MEMORY.md` 的内容会被注入系统提醒；其它 `.md` 文件路径会通过 `refFilePath` 暴露给写入工具，供 AI 后续按需读取/更新。

> Memory 没有"用户级"层 —— 记忆按项目隔离。

## 注入时机

三层上下文会**仅在首次查询时**通过一段 `<system-reminder>` 一次性注入主对话，本会话内不再重复。Plan 模式退出后的"清空上下文重新开始"会重新触发首次查询，从而再次注入。

## 常用 API

```javascript
// 取当前生效的 Rule / Memory（含缓存）
const rule   = await sema.getRuleInfo()    // RuleConfig | null
const memory = await sema.getMemoryInfo()  // MemoryConfig | null

// 修改文件后强制刷新
await sema.refreshRuleInfo()
await sema.refreshMemoryInfo()

// 切换 Claude 兼容（会自动重新加载 Rule / Memory / 插件市场）
sema.updateCoreConfByKey('enableClaudeCodeCompat', false)
```

## 选哪一层？

| 场景 | 选 |
|------|---|
| "全局都用中文回答" | `customRules`（一行就够） |
| "本项目用 pnpm，别用 npm/yarn" | 项目级 `AGENTS.md` |
| "团队共用的编码 / 提交规范" | 项目级 `AGENTS.md`，进 git |
| "我个人偏爱的命令、快捷键" | 用户级 `~/.sema/AGENTS.md` |
| "记住用户告诉我他是 Go 开发者" | `.sema/memory/user_role.md` + 索引 |
| "记住上一次发布的版本号 / 决策" | `.sema/memory/release.md` + 索引 |
| 从 Claude Code 迁移项目 | 直接保留 `CLAUDE.md`，无需修改 |

> Rule 是"指令"，Memory 是"事实"。规则不变就放 Rule，事实可能演化就放 Memory。

## 进一步了解

完整的优先级链路、`RuleConfig` / `MemoryConfig` 数据结构、Auto Memory 工作流、与 `enableClaudeCodeCompat` 的联动等，参考 [Rule & Memory](wiki/core-concepts/advanced-topics/rule-memory)。
