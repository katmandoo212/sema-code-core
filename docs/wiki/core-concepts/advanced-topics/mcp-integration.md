# MCP 集成

MCP（Model Context Protocol）是 Anthropic 主导的开放标准，允许 AI 应用通过统一协议接入外部工具和数据源。

## 架构

```
┌──────────────────────────────────────────────────┐
│                  Sema Core                       │
│                                                  │
│  MCPManager（单例）                               │
│  ├─ MCPClient A ──── stdio ──── 本地子进程 A       │
│  ├─ MCPClient B ──── sse  ──── 远程服务 B          │
│  └─ MCPClient C ──── http ──── HTTP 服务 C        │
│                                                  │
│  MCPToolAdapter                                  │
│  └─ 将 MCP 工具转换为 Sema Tool 接口                │
└──────────────────────────────────────────────────┘
```

- **MCPManager**：单例，管理所有 MCP 服务器的生命周期、配置加载和连接状态
- **MCPClient**：单个服务器连接，处理协议通信
- **MCPToolAdapter**：将 MCP 工具定义适配为 Sema `Tool` 接口


## 传输方式

| 方式 | 适用场景 | 配置字段 |
|------|---------|---------|
| `stdio` | 本地子进程（推荐） | `command`, `args`, `env` |
| `sse` | 远程 SSE 服务 | `url` |
| `http` | 远程 HTTP 服务 | `url`, `headers` |


## 配置来源与优先级

MCPManager 从多个位置加载配置，按以下优先级（后加载覆盖先加载）：

| 优先级 | 来源 | 配置文件 | 权限 |
|--------|------|---------|------|
| 1（最低） | Claude 用户级 | `~/.claude.json` → `mcpServers` | 只读 |
| 2 | Claude 本地级 | `~/.claude.json` → `projects[cwd].mcpServers` | 只读 |
| 3 | Claude 项目级 | `<project>/.mcp.json` | 只读 |
| 4 | 插件级 | 插件目录下 `.mcp.json` | 只读 |
| 5 | Sema 用户级 | `~/.sema/.mcp.json` | 读写 |
| 6（最高） | Sema 项目级 | `<project>/.sema/.mcp.json` | 读写 |

同名服务器，高优先级覆盖低优先级。Claude 来源的配置为只读，不可通过 Sema API 修改。

### Claude 项目级特殊规则

`<project>/.mcp.json` 中的服务器需要满足两个额外条件才生效：
- `<project>/.claude/settings.local.json` 中 `enableAllProjectMcpServers` 为 `true`
- 服务器名在 `enabledMcpjsonServers` 数组中


## 作用域

| 作用域 | 说明 | Sema 配置路径 |
|--------|------|--------------|
| `'user'` | 全局生效 | `~/.sema/.mcp.json` |
| `'project'` | 仅当前项目 | `<project>/.sema/.mcp.json` |
| `'local'` | Claude 本地级（只读） | — |
| `'plugin'` | 插件提供（只读） | — |


## 完整配置示例

### stdio 本地子进程

```javascript
await sema.addMCPServer({
  name: 'filesystem',
  transport: 'stdio',
  command: 'npx',
  args: ['-y', '@modelcontextprotocol/server-filesystem', '/Users/dev/projects'],
  env: { NODE_ENV: 'production' },
  scope: 'user',
})
```

### SSE 远程服务

```javascript
await sema.addMCPServer({
  name: 'my-api-tools',
  transport: 'sse',
  url: 'https://api.example.com/mcp/sse',
  scope: 'project',
})
```

### HTTP 远程服务（支持自定义请求头）

```javascript
await sema.addMCPServer({
  name: 'my-api-tools',
  transport: 'http',
  url: 'https://api.example.com/mcp',
  headers: {
    Authorization: `Bearer ${process.env.API_TOKEN}`,
  },
  scope: 'project',
})
```


## 工具命名与过滤

MCP 工具在 Sema 内的完整名称格式：

```
mcp__[serverName]__[toolName]

示例:
  服务器: filesystem
  工具:   read_file
  完整名: mcp__filesystem__read_file
```

### 工具过滤（useTools）

可以限制某个 MCP Server 只暴露部分工具：

```javascript
// 只使用 read_file 和 write_file 两个工具
await sema.updateMCPUseTools('filesystem', ['read_file', 'write_file'])

// 恢复使用所有工具
await sema.updateMCPUseTools('filesystem', null)
```

工具过滤配置存储在 `<project>/.sema/settings.json` 的 `enabledMcpServerUseTools` 字段中。


## 启用与禁用

```javascript
// 禁用（断开连接，保留配置）
await sema.disableMCPServer('filesystem')

// 重新启用（恢复连接）
await sema.enableMCPServer('filesystem')
```

禁用状态存储在 `<project>/.sema/settings.json` 的 `disabledMcpServers` 数组中。支持对任何来源（包括 Claude 来源）的服务器进行禁用/启用操作。


## 管理 API

```javascript
// 添加或更新服务器
await sema.addMCPServer(config)

// 移除服务器（仅 Sema 来源）
await sema.removeMCPServer('filesystem')

// 重新连接
await sema.reconnectMCPServer('filesystem')

// 禁用 / 启用
await sema.disableMCPServer('filesystem')
await sema.enableMCPServer('filesystem')

// 工具过滤
await sema.updateMCPUseTools('filesystem', ['read_file'])
await sema.updateMCPUseTools('filesystem', null)  // 恢复所有

// 查看所有配置
const servers = await sema.getMCPServerInfo()
// MCPServerInfo[]

// 强制刷新
await sema.refreshMCPServerInfo()
```


## 数据结构

### MCPServerConfig

```typescript
interface MCPServerConfig {
  name: string
  transport: 'stdio' | 'sse' | 'http'
  description?: string
  command?: string              // stdio
  args?: string[]               // stdio
  env?: Record<string, string>  // stdio
  url?: string                  // sse / http
  headers?: Record<string, string>  // http
  from?: 'sema' | 'claude'
  scope: 'local' | 'project' | 'user' | 'plugin'
  useTools?: string[] | null    // 工具过滤列表
}
```

### MCPServerInfo

```typescript
interface MCPServerInfo {
  config: MCPServerConfig
  connectStatus: 'disconnected' | 'connecting' | 'connected' | 'error'
  status: boolean               // 启用状态
  capabilities?: MCPServerCapabilities  // 服务器能力（含工具列表）
  error?: string
  connectedAt?: number
  from?: 'sema' | 'claude'
  scope?: MCPScopeType
  filePath?: string             // 配置文件路径
}
```


## 连接生命周期

```
refreshMCPServerConfigs()
   │
   ▼
加载所有配置来源 → 合并为 serverMap
   │
   ▼
对比旧缓存：
  ├─ 已移除 → 断开连接
  ├─ 已禁用 → 断开连接
  ├─ 配置未变 → 保留现有连接
  └─ 新增/配置变更 → 后台重连
```

### 智能重连

刷新配置时，MCPManager 会逐个对比配置变化：
- 连接相关字段（transport、command、args、env、url、headers）未变的服务器保持现有连接
- 仅 `useTools` 变更时不触发重连，直接更新缓存
- 新增或配置变更的服务器才执行重连

这避免了不必要的连接中断，尤其在频繁刷新配置时。


## 插件 MCP

通过插件安装的 MCP Server，名称格式为 `plugin:插件名:server名`（如 `plugin:my-plugin:db-tools`），scope 为 `'plugin'`。

插件 MCP 由 MCPManager 在加载时自动从已安装且启用的插件中读取。


## Claude Code 兼容

当 `enableClaudeCodeCompat` 配置启用时（默认），MCPManager 会读取 Claude 的配置路径：

- `~/.claude.json` 中的 `mcpServers`（用户级）和 `projects[cwd].mcpServers`（本地级）
- `<project>/.mcp.json`（项目级）
- `~/.claude.json` 中的 `projects[cwd].disabledMcpServers`（禁用列表）

这些来源的服务器通过 `from: 'claude'` 标识，配置本身不可通过 Sema API 修改，但可以通过 Sema 的 `disableMCPServer`/`enableMCPServer` 控制启用状态。
