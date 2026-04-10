# Plugin 使用

Sema Code Core 兼容 [Claude Code Plugins](https://docs.anthropic.com/claude/docs/plugins) 生态。一个插件可以同时打包 Skills、Agents、Commands、MCP 服务器，通过 marketplace（插件市场）一键安装、启用、升级、卸载。

## 概念

| 概念 | 说明 |
|------|------|
| **Marketplace** | 一个插件目录的描述（git 仓库或本地路径），由 `.claude-plugin/marketplace.json` 列出可用插件 |
| **Plugin** | 单个可安装单元，可包含 commands / agents / skills / mcp 中的任意组合 |
| **Scope** | 插件的安装作用域：`user`（全局，对所有项目生效）/ `project`（仅当前项目）/ `local`（本地路径，调试用） |

## 5 分钟跑通

### 1. 添加一个 marketplace

```javascript
// 从 git 仓库添加
await sema.addMarketplaceFromGit('https://github.com/some-org/sema-marketplace')

// 或从本地目录添加（开发自己的插件时常用）
await sema.addMarketplaceFromDirectory('/path/to/local/marketplace')
```

两个方法都返回 `Promise<MarketplacePluginsInfo>`，包含全部已添加的 marketplace 与插件快照。

### 2. 查看可用插件

```javascript
const info = await sema.getMarketplacePluginsInfo()

info.marketplaces.forEach(m => {
  console.log(`市场: ${m.name} (${m.source.source})`)
  m.available.forEach(p => console.log(`  - ${p.name}: ${p.description}`))
  console.log(`  已安装: ${m.installed.join(', ')}`)
})
```

### 3. 安装插件

```javascript
import { PluginScope } from 'sema-core'

// 安装到用户级（全局生效）
await sema.installPlugin('git-toolkit', 'sema-marketplace', 'user')

// 安装到当前项目级
await sema.installPlugin('git-toolkit', 'sema-marketplace', 'project')

// 项目级安装也可以指定特定项目目录
await sema.installPlugin('git-toolkit', 'sema-marketplace', 'project', '/path/to/other/project')
```

安装会做三件事：
1. 把插件源备份到 `~/.sema/plugins/cache/<marketplace>/<plugin>/<version>/`
2. 在 `installed_plugins.json` 中记录安装信息
3. 在对应作用域的 `settings.json` 中写入 `enabledPlugins[plugin@marketplace] = true`

### 4. 启用 / 禁用 / 卸载 / 升级

```javascript
// 临时禁用（不删除，只把 enabledPlugins 标记为 false）
await sema.disablePlugin('git-toolkit', 'sema-marketplace', 'user')
await sema.enablePlugin('git-toolkit', 'sema-marketplace', 'user')

// 卸载（从 installed_plugins.json 移除，cache 中文件保留）
await sema.uninstallPlugin('git-toolkit', 'sema-marketplace', 'user')

// 升级（重新拉取/复制最新版本）
await sema.updatePlugin('git-toolkit', 'sema-marketplace', 'user')
```

### 5. 查看已安装插件

```javascript
const info = await sema.getMarketplacePluginsInfo()

info.plugins.forEach(p => {
  console.log(`${p.name}@${p.marketplace} [${p.scope}] v${p.version} status=${p.status}`)
  console.log(`  commands: ${p.components.commands.map(c => c.name).join(', ')}`)
  console.log(`  agents:   ${p.components.agents.map(a => a.name).join(', ')}`)
  console.log(`  skills:   ${p.components.skills.map(s => s.name).join(', ')}`)
  console.log(`  mcp:      ${p.components.mcp.map(m => m.name).join(', ')}`)
})
```


## Marketplace 管理

```javascript
// 更新某个 marketplace（重新 git pull / 重读本地目录）
await sema.updateMarketplace('sema-marketplace')

// 移除 marketplace（同时清理它已安装的所有插件记录）
await sema.removeMarketplace('sema-marketplace')

// 强制刷新所有 marketplace 与插件信息
await sema.refreshMarketplacePluginsInfo()
```


## 数据结构

```typescript
interface MarketplacePluginsInfo {
  marketplaces: MarketplaceInfoResult[]
  plugins: PluginInfoResult[]
}

interface MarketplaceInfoResult {
  name: string
  source: { source: 'github' | 'directory'; repo?: string; path?: string }
  lastUpdated: string
  available: Array<{ name: string; description: string; author: string }>
  installed: string[]              // 该市场下已安装的插件名
  from: string
}

interface PluginInfoResult {
  name: string
  marketplace: string
  scope: 'user' | 'project' | 'local'
  status: boolean                  // 是否启用
  version: string
  description: string
  author: string
  components: {
    commands: { name: string; filePath: string }[]
    agents:   { name: string; filePath: string }[]
    skills:   { name: string; filePath: string }[]
    mcp:      { name: string; filePath: string }[]
  }
  from: string
}
```


## 与 Skill / Agent / Command / MCP 的关系

插件安装并启用后，它提供的 Skills / Agents / Commands / MCP 会**自动出现在对应管理器的列表中**，无需重新启动 Sema Core：

| 插件提供的组件 | 出现在 | locate / from |
|--------------|-------|---------------|
| Skill | `getSkillsInfo()` | `from: 'plugin'`，命名 `pluginName:skillName` |
| Agent | `getAgentsInfo()` | `from: 'plugin'` |
| Command | `getCommandsInfo()` | `from: 'plugin'` |
| MCP | `getMCPServerInfo()` | `from: 'plugin'`, `scope: 'plugin'` |

> 与"项目级 / 用户级"配置的优先级关系详见各自的"使用"章节。


## 持久化文件

| 文件 | 位置 | 用途 |
|------|------|------|
| `known_marketplaces.json` | `~/.sema/plugins/` | 全部已添加的 marketplace 索引 |
| `installed_plugins.json` | `~/.sema/plugins/` | 全部已安装插件记录（按 scope 区分） |
| `cache/<marketplace>/<plugin>/<version>/` | `~/.sema/plugins/` | 插件源备份 |
| `settings.json` 的 `enabledPlugins` | 各作用域目录 | 启用状态开关 |


## 进一步了解

更深入的插件市场设计、`marketplace.json` 与 `plugin.json` 格式、组件加载机制，参考 [插件市场](wiki/core-concepts/advanced-topics/plugins)。
