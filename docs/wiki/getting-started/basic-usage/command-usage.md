# Command 使用

Command 是以 Markdown 文件形式存储的自定义快捷指令，允许你为常用操作定义命令名称，在对话中直接触发特定的提示词或工作流。支持参数占位符，同时内置了 `/clear`、`/compact`、`/btw` 等系统命令。

## 与 Skill 的区别

| 特性 | Command | Skill |
|------|---------|-------|
| 调用方式 | 用户直接 `/cmd` | AI 自动判断或用户引导 |
| 复杂度 | 简单提示词映射 | 完整工作流（含 fetch 流程） |
| 参数支持 | `$ARGUMENTS` 占位符 | 自然语言传入 |


## 命令存储位置与优先级

按从高到低的顺序，**后加载的覆盖先加载的**：

| 优先级 | 来源 | 路径 |
|-------|------|------|
| 1（最高） | Sema 项目级 | `<project>/.sema/commands/` |
| 2 | Sema 用户级 | `~/.sema/commands/` |
| 3 | 插件级 | 已安装且启用的插件提供的 commands |
| 4 | Claude 项目级 | `<project>/.claude/commands/` |
| 5（最低） | Claude 用户级 | `~/.claude/commands/` |

> Sema 项目级的同名命令会覆盖用户级与 Claude 来源。


## 创建命令文件

每个命令对应一个 `.md` 文件，命令名由文件路径自动生成（子目录用 `:` 分隔）：

```
.sema/commands/
├── fix-lint.md          → /fix-lint
├── run-tests.md         → /run-tests
└── frontend/
    └── generate.md      → /frontend:generate
```

文件格式为带 frontmatter 的 Markdown：

```markdown
---
description: 修复所有 lint 错误
argument-hint: <file-path>
---

请检查并修复 $ARGUMENTS 中的所有 lint 错误，遵循项目的 ESLint 配置。
```

frontmatter 支持的字段：

| 字段 | 类型 | 说明 |
|------|------|------|
| `description` | string | 命令描述，未填写时为空 |
| `argument-hint` | string \| string[] | 参数提示文本，如 `<file-path>` 或 `[pr-number] [priority]` |

> `argument-hint` 中以 `[xxx]` 形式书写的多个槽位会被自动解析为数组。


## 参数传递

在命令内容中使用 `$ARGUMENTS` 作为占位符，调用时传入的参数会替换该占位符：

```
/fix-lint src/components/Button.tsx
```

若命令内容中不包含 `$ARGUMENTS`，传入的参数会追加到内容末尾。


## 系统内置命令

以下命令由系统内置处理，无需创建文件：

| 命令 | 说明 |
|------|------|
| `/clear` | 清空当前会话的消息历史 |
| `/compact` | 压缩当前消息历史以减少 token 占用 |
| `/btw <question>` | 旁路问答：不影响主对话状态，回复通过 `btw:response` 事件返回 |


## 查看与管理命令

```javascript
// 获取所有命令（异步，含缓存）
const commands = await sema.getCommandsInfo()
commands.forEach(cmd => {
  console.log(`/${cmd.name}: ${cmd.description}`)
})

// 强制刷新（命令文件变更后调用）
await sema.refreshCommandsInfo()

// 添加自定义命令
await sema.addCommandConf({
  name: 'fix-lint',
  description: '修复 lint 错误',
  argumentHint: '<file-path>',
  prompt: '请检查并修复 $ARGUMENTS 中的所有 lint 错误。',
  locate: 'project',  // 'user' / 'project'
})

// 删除命令（仅 Sema 来源可删，Claude/插件 来源只读）
await sema.removeCommandConf('fix-lint')
```

`CommandConfig` 接口：

```typescript
interface CommandConfig {
  name: string                          // 命令名（如 "fix-lint" 或 "frontend:generate"）
  description: string                   // 命令描述
  argumentHint?: string | string[]      // 参数提示
  prompt: string                        // Markdown 正文（不含 frontmatter）
  locate?: 'user' | 'project' | 'plugin'
  from?: 'sema' | 'claude' | 'plugin'
  filePath?: string                     // 源 .md 文件路径
}
```


## 使用命令

在对话中输入 `/命令名` 即可触发对应命令，支持传入参数：

```
/fix-lint
/run-tests src/
/frontend:generate Button
```

> Command 在 `processUserInput` 入口被识别并展开为对应的 Markdown prompt 后，再交给 LLM 处理。


## 进一步了解

对于更复杂的可复用工作流（含 AI 自动调用、工具约束等），推荐使用 [Skill 使用](wiki/getting-started/basic-usage/skill-usage)；命令系统的更多细节参考 [Command 命令](wiki/core-concepts/advanced-topics/commands)。
