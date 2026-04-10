# 插件市场

插件市场系统允许通过 GitHub 仓库或本地目录引入第三方扩展，统一管理 Commands、Agents、Skills、MCP Server 等组件的安装、启用和更新。

## 架构

```
┌─────────────────────────────────────────────────────────┐
│                    PluginsManager（单例）                 │
│                                                         │
│  known_marketplaces.json ─── 已注册市场列表               │
│  installed_plugins.json ──── 已安装插件记录               │
│  settings.json ───────────── 启用/禁用状态               │
│                                                         │
│  市场来源                                                │
│  ├─ GitHub 仓库（git clone / pull）                      │
│  └─ 本地目录（直接引用）                                   │
│                                                         │
│  插件组件 → 自动分发到各 Manager                           │
│  ├─ commands/*.md  → CommandsManager                    │
│  ├─ agents/*.md    → AgentsManager                      │
│  ├─ skills/*/SKILL.md → SkillsManager                   │
│  └─ .mcp.json      → MCPManager                        │
└─────────────────────────────────────────────────────────┘
```

插件安装后，其组件会自动被各 Manager 加载。组件名称格式为 `插件名:组件名`（如 `my-plugin:review`），避免与用户自定义组件冲突。


## 市场来源

### GitHub 仓库

通过 `git clone` 下载到 `~/.sema/plugins/marketplaces/` 目录，支持 `git pull` 更新。

```javascript
await sema.addMarketplaceFromGit('owner/repo')
```

### 本地目录

直接引用本地路径，不复制文件，适合开发调试。

```javascript
await sema.addMarketplaceFromDirectory('/path/to/marketplace')
```


## 市场目录结构

市场仓库需在根目录包含 `.claude-plugin/marketplace.json`：

```
marketplace-repo/
├── .claude-plugin/
│   └── marketplace.json      ← 市场元数据
├── plugin-a/                 ← 插件 A（相对路径引用）
│   ├── .claude-plugin/
│   │   └── plugin.json       ← 插件元数据（可选）
│   ├── commands/
│   │   └── deploy.md
│   ├── agents/
│   │   └── reviewer.md
│   ├── skills/
│   │   └── commit/
│   │       └── SKILL.md
│   └── .mcp.json             ← MCP Server 配置
└── plugin-b/                 ← 插件 B
    └── ...
```

### marketplace.json

```json
{
  "name": "my-marketplace",
  "description": "团队工具集合",
  "plugins": [
    {
      "name": "plugin-a",
      "description": "部署与审查工具",
      "version": "1.2.0",
      "author": { "name": "Team" },
      "source": "./plugin-a"
    },
    {
      "name": "plugin-b",
      "description": "远程仓库插件",
      "source": { "source": "url", "url": "https://github.com/org/plugin-b.git" }
    }
  ]
}
```

`source` 字段支持两种形式：
- **相对路径字符串**：相对于市场根目录的路径
- **URL 对象**：`{ source: 'url', url: '...' }`，安装时 git clone 独立仓库

### plugin.json（可选）

```json
{
  "name": "plugin-a",
  "version": "1.2.0",
  "description": "部署与审查工具"
}
```

版本优先级：`marketplace.json` 中的 `version` > `plugin.json` 中的 `version` > 默认 `'1.0.0'`


## 插件安装与作用域

安装插件时需指定作用域（scope），决定插件在哪个层级生效：

| 作用域 | 启用状态存储位置 | 适用范围 |
|--------|----------------|---------|
| `'user'` | `~/.sema/settings.json` | 所有项目 |
| `'project'` | `<project>/.sema/settings.json` | 仅当前项目 |
| `'local'` | `<project>/.sema/settings.local.json` | 仅当前本地 |

安装时，插件源文件会备份到 `~/.sema/plugins/cache/市场名/插件名/版本/`，确保后续可离线使用。

```javascript
// 安装插件到用户级
await sema.installPlugin('plugin-a', 'my-marketplace', 'user')

// 安装到项目级
await sema.installPlugin('plugin-a', 'my-marketplace', 'project')
```


## 启用与禁用

```javascript
// 禁用插件（保留安装记录）
await sema.disablePlugin('plugin-a', 'my-marketplace', 'user')

// 重新启用
await sema.enablePlugin('plugin-a', 'my-marketplace', 'user')
```

启用状态存储在对应 scope 的 `settings.json` 的 `enabledPlugins` 字段中：

```json
{
  "enabledPlugins": {
    "plugin-a@my-marketplace": true
  }
}
```

禁用后，该插件的所有组件（commands、agents、skills、MCP）在下次刷新时不再加载。


## Claude Code 兼容

当 `enableClaudeCodeCompat` 配置不为 `false` 时（默认启用），PluginsManager 会同时读取 `~/.claude/plugins/` 下的市场和插件数据：

| 来源 | 配置路径 | 权限 |
|------|---------|------|
| Sema | `~/.sema/plugins/` | 读写 |
| Claude | `~/.claude/plugins/` | **只读** |

两个来源的数据合并返回，通过 `from` 字段区分（`'sema'` 或 `'claude'`）。Claude 来源的市场和插件不可通过 Sema API 修改。


## 组件加载优先级

插件组件在各 Manager 中的加载优先级（后加载的覆盖先加载的）：

```
Claude 用户级 → Claude 项目级 → 内置 → 插件 → Sema 用户级 → Sema 项目级
（最低优先级）                                          （最高优先级）
```

同名组件，高优先级覆盖低优先级。


## 完整管理 API

```javascript
// ==================== 市场管理 ====================
// 添加市场
await sema.addMarketplaceFromGit('owner/repo')
await sema.addMarketplaceFromDirectory('/path/to/dir')

// 更新市场（仅 GitHub 来源）
await sema.updateMarketplace('my-marketplace')

// 移除市场（同时清理已安装插件记录）
await sema.removeMarketplace('my-marketplace')

// ==================== 插件管理 ====================
// 安装 / 卸载
await sema.installPlugin('plugin-a', 'my-marketplace', 'user')
await sema.uninstallPlugin('plugin-a', 'my-marketplace', 'user')

// 启用 / 禁用
await sema.enablePlugin('plugin-a', 'my-marketplace', 'user')
await sema.disablePlugin('plugin-a', 'my-marketplace', 'user')

// 更新（重新安装最新版本）
await sema.updatePlugin('plugin-a', 'my-marketplace', 'user')

// ==================== 信息查询 ====================
// 获取所有市场和插件信息（有缓存）
const info = await sema.getMarketplacePluginsInfo()
// { marketplaces: MarketplaceInfoResult[], plugins: PluginInfoResult[] }

// 强制刷新
await sema.refreshMarketplacePluginsInfo()
```

所有写操作均返回刷新后的 `MarketplacePluginsInfo`，包含完整的市场列表和插件状态。


## 数据结构

### MarketplaceInfoResult

```typescript
interface MarketplaceInfoResult {
  name: string
  source: { source: 'github' | 'directory'; repo?: string; path?: string }
  lastUpdated: string          // 最后更新日期
  available: Array<{           // 市场中所有可用插件
    name: string
    description: string
    author: string
  }>
  installed: string[]          // 已安装的插件名列表
  from: 'sema' | 'claude'
}
```

### PluginInfoResult

```typescript
interface PluginInfoResult {
  name: string
  marketplace: string
  scope: PluginScope           // 'local' | 'project' | 'user'
  status: boolean              // 启用状态
  version: string
  description: string
  author: string
  components: PluginComponents // 插件包含的组件
  from: 'sema' | 'claude'
}

interface PluginComponents {
  commands: Array<{ name: string; filePath: string }>
  agents: Array<{ name: string; filePath: string }>
  skills: Array<{ name: string; filePath: string }>
  mcp: Array<{ name: string; filePath: string }>
}
```


## 插件变更联动

插件信息刷新后，系统会自动在后台触发以下 Manager 的刷新（不阻塞当前流程）：

- `AgentsManager.refreshAgentsInfo()`
- `SkillsManager.refreshSkillsInfo()`
- `CommandsManager.refreshCommandsInfo()`
- `MCPManager.refreshMCPServerConfigs()`

确保插件组件的增删改能及时反映到各子系统中。
