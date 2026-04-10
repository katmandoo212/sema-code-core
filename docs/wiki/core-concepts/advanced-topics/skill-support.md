# Skill 支持

Skill 系统允许将常用的 AI 工作流封装为可复用的 Markdown 文件，在对话中通过 `/skill-name` 语法直接调用。

## 系统架构

```
~/.claude/skills/[name]/SKILL.md    ←── Claude 用户级（只读，最低优先级）
<project>/.claude/skills/[name]/SKILL.md ←── Claude 项目级（只读）
插件 skills                          ←── 插件级
~/.sema/skills/[name]/SKILL.md      ←── Sema 用户级
<project>/.sema/skills/[name]/SKILL.md  ←── Sema 项目级（最高优先级）

         ↓ 加载（SkillsManager 单例）

    skillConfigs（Map<name, SkillConfig>）

         ↓ AI 调用 Skill 工具

    findSkill(name) → 返回 Skill 内容 → LLM 执行
```


## Skill 文件格式

每个 Skill 存放在独立子目录中，目录下包含 `SKILL.md` 文件：

```
skills/
├── review/
│   └── SKILL.md
├── commit/
│   └── SKILL.md
└── deploy/
    └── SKILL.md
```

`SKILL.md` 是带 YAML frontmatter 的 Markdown 文件：

```markdown
---
name: review
description: 对代码进行全面审查，输出结构化报告
---

# 代码审查 Skill

你是一位资深代码审查专家。请对提供的代码进行全面审查：

## 审查维度

1. **正确性**：逻辑是否正确，边界条件是否处理
2. **性能**：是否存在明显的性能瓶颈
3. **安全性**：是否存在安全漏洞（OWASP Top 10）
4. **可维护性**：代码可读性和复杂度

## 输出格式

对每个问题，请提供：
- 文件路径和行号
- 问题描述
- 严重程度（Critical / Warning / Suggestion）
- 修复建议
```


## 元数据字段

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `name` | `string` | ✓ | 唯一名称，用于 `/name` 调用 |
| `description` | `string` | ✓ | 功能描述（显示在工具列表中） |

Markdown 正文是 Skill 的 prompt 内容（必须非空）。


## 参数传递

通过 `args` 字段传入参数：

- 若 Skill 内容包含 `$ARGUMENTS` 占位符，所有占位符会被替换为实际参数
- 若不含占位符，参数以 `ARGUMENTS: <args>` 形式追加到内容末尾

```javascript
// AI 调用示例
{ skill: 'review', args: 'src/components/Button.tsx' }
```


## 存放位置与优先级

| 级别 | 路径 | 适用范围 | 权限 |
|------|------|---------|------|
| Claude 用户级 | `~/.claude/skills/[name]/SKILL.md` | 所有项目 | 只读 |
| Claude 项目级 | `<project>/.claude/skills/[name]/SKILL.md` | 当前项目 | 只读 |
| 插件级 | 插件目录下 `skills/[name]/SKILL.md` | 随插件作用域 | 只读 |
| Sema 用户级 | `~/.sema/skills/[name]/SKILL.md` | 所有项目 | 读写 |
| Sema 项目级 | `<project>/.sema/skills/[name]/SKILL.md` | 当前项目 | 读写 |

优先级从低到高（后加载覆盖先加载）：

```
Claude 用户级 → Claude 项目级 → 插件 → Sema 用户级 → Sema 项目级
```

同名 Skill，高优先级覆盖低优先级。


## 插件 Skill

通过插件安装的 Skill，名称格式为 `插件名:skill名`（如 `my-plugin:commit`），`locate` 为 `'plugin'`。

插件 Skill 由 SkillsManager 在加载时自动从已安装且启用的插件中读取，无需手动注册。


## Claude Code 兼容

当 `enableClaudeCodeCompat` 配置启用时（默认），SkillsManager 会自动加载 Claude 路径下的 Skill 配置：

- `~/.claude/skills/` — Claude 用户级
- `<project>/.claude/skills/` — Claude 项目级

Claude 来源的 Skill 通过 `from: 'claude'` 标识，为只读，不可通过 API 修改或删除。


## 调用流程

1. 用户输入 `/commit` 或 AI 自行决定调用 Skill
2. AI 调用内置 `Skill` 工具：`{ skill: 'commit', args: '...' }`
3. `Skill` 工具从 SkillsManager 查找对应 Skill；未找到时返回可用 Skill 列表
4. 将 Skill 内容返回给 LLM
5. LLM 按 Skill 内容执行任务


## 管理 API

```javascript
// 查询所有 Skill 信息（有缓存）
const skills = await sema.getSkillsInfo()
// SkillConfig[]: { name, description, prompt, locate, from, filePath }

// 强制刷新
await sema.refreshSkillsInfo()

// 移除 Skill（Claude 来源和插件 Skill 不可移除）
await sema.removeSkillConf('review')
```

### SkillConfig 结构

```typescript
interface SkillConfig {
  name: string
  description: string
  prompt: string                        // Skill 内容
  locate?: 'user' | 'project' | 'plugin'  // 所在层级
  from?: 'sema' | 'claude'             // 来源
  filePath?: string                     // 文件路径
}
```


## 最佳实践

**Skill 命名**：使用动词短语，如 `commit`、`review`、`test`、`deploy`

**版本管理**：将 `.sema/skills/` 纳入 Git，团队共享 Skill

**专注单一任务**：每个 Skill 解决一类特定问题，保持 prompt 简洁明确

**结构化输出**：在 prompt 中明确输出格式要求，提升结果一致性
