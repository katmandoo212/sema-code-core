# 自定义命令

Commands 系统允许将常用的 AI 指令封装为 Markdown 文件，用户在对话中通过 `/command-name` 语法调用，AI 按命令内容执行任务。

## 系统架构

```
~/.claude/commands/         ←── Claude 用户级（只读，最低优先级）
<project>/.claude/commands/ ←── Claude 项目级（只读）
插件 commands               ←── 插件级
~/.sema/commands/           ←── Sema 用户级
<project>/.sema/commands/   ←── Sema 项目级（最高优先级）

         ↓ 加载（CommandsManager 单例）

    commandConfigs（Map<name, CommandConfig>）

         ↓ AI 调用

    用户输入 /command-name → 解析为 processUserInput
```


## 命令文件格式

命令文件是带 YAML frontmatter 的 Markdown 文件（`.md`）：

```markdown
---
description: 对指定 PR 进行代码审查
argument-hint: "[pr-number] [priority]"
---

请对 PR #$ARGUMENTS 进行代码审查，重点关注：

1. 代码质量和可维护性
2. 潜在的安全问题
3. 性能影响
4. 测试覆盖度

输出结构化的审查报告。
```

### 元数据字段

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `description` | `string` | 推荐 | 命令描述，显示在命令列表中 |
| `argument-hint` | `string \| string[]` | — | 参数提示，支持 `[param]` 格式自动解析为数组 |

Markdown 正文是命令的 prompt 内容，`$ARGUMENTS` 会被替换为用户传入的参数。


## 命名规则

命令名由文件的相对路径生成，路径分隔符替换为冒号，去掉 `.md` 后缀：

| 文件路径 | 命令名 | 调用方式 |
|---------|--------|---------|
| `commands/deploy.md` | `deploy` | `/deploy` |
| `commands/frontend/test.md` | `frontend:test` | `/frontend:test` |
| `commands/db/migrate/up.md` | `db:migrate:up` | `/db:migrate:up` |

支持任意深度的目录嵌套，便于按命名空间组织命令。


## 存放位置与优先级

| 级别 | 路径 | 适用范围 | 权限 |
|------|------|---------|------|
| Claude 用户级 | `~/.claude/commands/` | 所有项目 | 只读 |
| Claude 项目级 | `<project>/.claude/commands/` | 当前项目 | 只读 |
| 插件级 | 插件目录下 `commands/` | 随插件作用域 | 只读 |
| Sema 用户级 | `~/.sema/commands/` | 所有项目 | 读写 |
| Sema 项目级 | `<project>/.sema/commands/` | 当前项目 | 读写 |

优先级从低到高（后加载覆盖先加载）：

```
Claude 用户级 → Claude 项目级 → 插件 → Sema 用户级 → Sema 项目级
```

同名命令，高优先级覆盖低优先级。


## argument-hint 解析

`argument-hint` 支持两种格式：

**括号格式**（自动解析为数组）：

```yaml
argument-hint: "[pr-number] [priority]"
# 解析为: ['pr-number', 'priority']
```

**自由文本格式**（保持原字符串）：

```yaml
argument-hint: "Optional feature description"
# 保持为: 'Optional feature description'
```


## Claude Code 兼容

当 `enableClaudeCodeCompat` 配置启用时（默认），CommandsManager 会自动加载 `~/.claude/commands/` 和 `<project>/.claude/commands/` 下的命令文件。Claude 来源的命令为只读，不可通过 API 修改或删除。

每个命令携带 `from` 字段标识来源：
- `'sema'`：Sema 路径下的命令
- `'claude'`：Claude 路径下的命令

插件命令的 `from` 继承自其所属插件的来源。


## 插件命令

通过插件安装的命令，名称格式为 `插件名:命令名`（如 `my-plugin:deploy`），`locate` 为 `'plugin'`。

插件命令由 CommandsManager 在加载时自动从已安装且启用的插件中读取，无需手动注册。


## 管理 API

```javascript
// 查询所有命令信息（有缓存）
const commands = await sema.getCommandsInfo()
// CommandConfig[]: { name, description, argumentHint, prompt, locate, from, filePath }

// 强制刷新
await sema.refreshCommandsInfo()

// 添加命令（只能写入 Sema 路径）
await sema.addCommandConf({
  name: 'review-pr',
  description: '对 PR 进行代码审查',
  argumentHint: '[pr-number]',
  prompt: '请对 PR #$ARGUMENTS 进行审查...',
  locate: 'project',   // 必填：'user' 或 'project'
})

// 移除命令（Claude 来源和插件命令不可移除）
await sema.removeCommandConf('review-pr')
```

### CommandConfig 结构

```typescript
interface CommandConfig {
  name: string                          // 命令名
  description: string                   // 描述
  argumentHint?: string | string[]      // 参数提示
  prompt: string                        // 命令内容
  locate?: 'user' | 'project' | 'plugin'  // 所在层级
  from?: 'sema' | 'claude'             // 来源
  filePath?: string                     // 文件路径
}
```


## 示例

### 项目部署命令

`.sema/commands/deploy.md`：

```markdown
---
description: 部署项目到指定环境
argument-hint: "[environment]"
---

请执行以下部署流程：

1. 运行测试确认通过
2. 构建生产版本
3. 部署到 $ARGUMENTS 环境
4. 验证部署状态
5. 输出部署摘要
```

### 命名空间组织

```
.sema/commands/
├── deploy.md              → /deploy
├── db/
│   ├── migrate.md         → /db:migrate
│   └── seed.md            → /db:seed
└── frontend/
    ├── test.md            → /frontend:test
    └── build.md           → /frontend:build
```
