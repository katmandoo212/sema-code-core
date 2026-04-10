# Skill 使用

Skill 是存储在 Markdown 文件中的可复用 AI 工作流。通过 Skill，你可以将常用操作（如代码提交、代码审查、测试等）封装为标准化流程，由 AI 在合适时机自动调用，或在对话中直接触发。

## Skill 文件格式

Skill 采用带 YAML frontmatter 的 Markdown 文件：

```markdown
---
name: commit
description: 按照项目规范创建 Git 提交
---

# Git 提交 Skill

分析当前暂存的改动，按照以下规范创建提交：

1. 使用 `git diff --staged` 查看改动内容
2. 根据改动类型选择合适的前缀：`feat:` / `fix:` / `docs:` / `refactor:`
3. 提交信息保持简洁，不超过 72 字符
4. 如果有多个独立改动，考虑分次提交

请分析改动并创建规范的提交。
```

### 必填字段

| 字段 | 类型 | 说明 |
|------|------|------|
| `name` | `string` | Skill 唯一名称（调用时使用） |
| `description` | `string` | Skill 功能描述（AI 据此决定何时使用） |

> Sema 的 Skill 解析器只读取 `name` / `description` / `prompt`（即 frontmatter 后的 Markdown 正文）。其它常见 Claude Skills 字段（`allowed-tools`、`when-to-use`、`model`、`max-thinking-tokens`、`disable-model-invocation`、`argument-hint`、`version` 等）不会被解析为运行时约束，仅用于兼容来自 Claude 生态的现成 Skill 文件。如需类似能力，请用 [SubAgent](wiki/getting-started/basic-usage/subagent-usage)（`tools` 软约束 + `model` 选择）。


## 存放位置与优先级

按从高到低的顺序：

| 优先级 | 来源 | 路径 |
|-------|------|------|
| 1（最高） | Sema 项目级 | `<project>/.sema/skills/` |
| 2 | Sema 用户级 | `~/.sema/skills/` |
| 3 | 插件级 | 已安装且启用的插件提供的 skills |
| 4 | Claude 项目级 | `<project>/.claude/skills/` |
| 5（最低） | Claude 用户级 | `~/.claude/skills/` |

> Claude 来源由 `enableClaudeCodeCompat` 控制（默认开启）。

### 文件组织方式

**子目录方式（推荐）**：`SKILL.md`（大小写敏感）

```
.sema/skills/commit/SKILL.md
~/.sema/skills/commit/SKILL.md
```

**直接文件方式**：

```
.sema/skills/commit.md
~/.sema/skills/commit.md
```


## 创建 Skill

```bash
mkdir -p .sema/skills/commit
cat > .sema/skills/commit/SKILL.md << 'EOF'
---
name: commit
description: 创建符合 Conventional Commits 规范的 Git 提交
---

分析 git diff --staged 的内容，创建符合 Conventional Commits 规范的提交信息。
EOF
```

无需重启 Sema Core，下次 `getSkillsInfo()` / `refreshSkillsInfo()` 后即生效。


## 查看与刷新 Skill

```javascript
// 获取所有 Skill（含缓存）
const skills = await sema.getSkillsInfo()

skills.forEach(skill => {
  console.log(`${skill.name} [${skill.locate}/${skill.from}]: ${skill.description}`)
})

// 强制从磁盘刷新
await sema.refreshSkillsInfo()

// 删除某个 Skill 配置（仅 Sema 来源可删，Claude/插件 来源只读）
await sema.removeSkillConf('commit')
```

`SkillConfig` 接口：

```typescript
interface SkillConfig {
  name: string
  description: string
  prompt: string                  // SKILL.md 正文（不含 frontmatter）
  locate?: 'user' | 'project' | 'plugin'
  from?: 'sema' | 'claude' | 'plugin'
  filePath?: string
}
```


## 在对话中触发 Skill

Sema 内置 `Skill` 工具，AI 在判断需要时会自动调用对应的 Skill。用户也可以在输入中显式引导：

```
帮我用 commit skill 提交当前改动
```

> Skill 注入到系统提示词的方式：在第一次查询时，所有可用 Skill 的 `name` + `description` 列表会通过 `<system-reminder>` 注入，告知 AI 它有哪些 Skill 可用。具体内容由 `Skill` 工具按需 fetch。


## 示例：代码审查 Skill

`.sema/skills/review/SKILL.md`：

```markdown
---
name: review
description: 对指定文件进行代码审查，覆盖正确性、性能、安全、可维护性
---

# 代码审查

请对提供的代码文件进行全面审查，重点关注：

- **正确性**：逻辑是否正确，边界条件处理
- **性能**：是否存在明显的性能问题
- **安全性**：是否存在安全漏洞（SQL 注入、XSS 等）
- **可维护性**：代码可读性，是否过度复杂
- **最佳实践**：是否遵循该语言/框架的最佳实践

输出结构化的审查报告，每个问题注明文件和行号。
```


## 进一步了解

更深入的 Skill 系统设计、加载流程、与 SubAgent 的对比，参考 [Skill 支持](wiki/core-concepts/advanced-topics/skill-support)。
