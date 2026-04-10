# MCP 使用

MCP（Model Context Protocol）是一种标准协议，允许为 AI 扩展自定义工具能力。通过 MCP，任何外部服务都能以标准化方式为 Sema 提供工具。

<figure align="center">
  <img src="images/mcp.png" alt="model-list">
  <figcaption>Sema Code vscode 插件页面截图</figcaption>
</figure>

## MCPServerConfig 接口

```typescript
interface MCPServerConfig {
  name: string                          // 服务器唯一名称
  description?: string                   // 服务描述
  transport: 'stdio' | 'sse' | 'http'   // 传输方式
  enabled?: boolean                     // 是否启用，默认 true
  useTools?: string[] | null            // 过滤工具列表，null 表示所有

  // stdio 模式
  command?: string                      // 可执行命令
  args?: string[]                       // 命令参数
  env?: Record<string, string>          // 环境变量

  // sse / http 模式
  url?: string                          // 服务地址
  headers?: Record<string, string>      // 请求头

  from: string                          // 来源（'sema' / 'claude' / 'plugin'）
  scope: 'user' | 'project' | 'local' | 'plugin'  // 作用域
}
```


## 配置文件位置与优先级

MCP 配置从多个来源加载，按从高到低的顺序后加载的覆盖先加载的：

| 优先级 | 来源 | 路径 |
|-------|------|------|
| 1（最高） | Sema 项目级 | `<project>/.sema/.mcp.json` |
| 2 | Sema 用户级 | `~/.sema/.mcp.json` |
| 3 | Claude 项目级 | `<project>/.mcp.json` |
| 4 | Claude 本地级 | `~/.claude.json` 中 `projects[<cwd>].mcpServers` |
| 5（最低） | Claude 用户级 | `~/.claude.json` 中 `mcpServers` |

> Claude 来源的配置只读，无法通过 API 修改/删除。`enableClaudeCodeCompat: false` 时只读取 Sema 来源。
>
> Sema 的服务启用/禁用状态保存在 `.sema/settings.json` 的 `disabledMcpServers` 字段。


## 添加 MCP 服务器

### stdio 模式（本地子进程，推荐）

```javascript
// npx node 环境
await sema.addMCPServer({
  name: 'sequential-thinking',
  transport: 'stdio',
  command: 'npx',
  args: ['-y', '@modelcontextprotocol/server-sequential-thinking'],
  scope: 'user',     // 必填：'user' | 'project' | 'local' | 'plugin'
  from: 'sema',      // 必填
})

// uvx python 环境
await sema.addMCPServer({
  name: 'time',
  transport: 'stdio',
  command: 'uvx',

  args: ['mcp-server-time'],
  scope: 'project',
  from: 'sema',
})
```

### HTTP / SSE 模式

```javascript
await sema.addMCPServer({
  name: 'remote-search',
  transport: 'http',
  url: 'https://mcp.example.com/api',
  headers: { Authorization: 'Bearer xxx' },
  scope: 'user',
  from: 'sema',
})
```

`addMCPServer` 返回 `Promise<MCPServerInfo[]>`，包含全部 MCP 服务器（含新增）的最新状态。


## 管理 MCP 服务器

```javascript
// 移除
await sema.removeMCPServer('sequential-thinking')

// 重新连接
await sema.reconnectMCPServer('time')

// 启用 / 禁用（修改 .sema/settings.json 中的 disabledMcpServers）
await sema.enableMCPServer('time')
await sema.disableMCPServer('time')

// 限定工具：仅允许使用部分工具
await sema.updateMCPUseTools('filesystem', ['read_file', 'write_file'])
```


## 查看 MCP 服务器

```javascript
// 获取（含缓存）
const servers = await sema.getMCPServerInfo()

// 强制刷新（从磁盘重新加载）
const fresh = await sema.refreshMCPServerInfo()

servers.forEach(s => {
  console.log(`${s.config.name} [${s.scope}/${s.from}] ${s.connectStatus}`)
  console.log(`  enabled=${s.status}, tools=${s.capabilities?.tools?.length ?? 0}`)
})
```

`MCPServerInfo` 关键字段：

```typescript
interface MCPServerInfo {
  config: MCPServerConfig
  connectStatus: 'disconnected' | 'connecting' | 'connected' | 'error'
  capabilities?: { tools?: MCPToolDefinition[] }
  connectedAt?: number
  status: boolean              // 是否启用（≠ 是否已连接）
  error?: string
  from?: string
  scope?: 'user' | 'project' | 'local' | 'plugin'
  filePath?: string
}
```


## 工具命名规则

MCP 工具在 Sema 中以 `mcp__[serverName]_[toolName]` 格式引用，作为 LLM 看到的工具名：

```
服务器名: filesystem
工具名:   read_file
引用名:   mcp__filesystem_read_file
```


## 实时事件

服务器状态变化时会触发 `mcp:server:status` 事件：

```javascript
sema.on('mcp:server:status', (info) => {
  console.log(`MCP [${info.config.name}] → ${info.connectStatus}`)
})
```


## 配置文件示例

`~/.sema/.mcp.json`（用户级）或 `<project>/.sema/.mcp.json`（项目级）：

```json
{
  "mcpServers": {
    "filesystem": {
      "transport": "stdio",
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"]
    }
  }
}
```
