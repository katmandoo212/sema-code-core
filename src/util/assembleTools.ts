import { Tool } from '../tools/base/Tool'
import { getTools } from '../tools/base/tools'
import { getMCPManager } from '../services/mcp/MCPManager'
import { logInfo } from './log'

/**
 * 组装工具集：内置工具 + MCP 工具，Plan 模式下过滤 TodoWrite
 */
export function assembleTools(useTools?: string[] | null, agentMode?: string): Tool[] {
  const builtinTools = getTools(useTools)
  const mcpTools = getMCPManager().getMCPTools()
  let tools: Tool[] = [...builtinTools, ...mcpTools]

  // Plan 模式下去掉 TodoWrite 工具
  if (agentMode === 'Plan') {
    tools = tools.filter(tool => tool.name !== 'TodoWrite')
  }

  logInfo(`tools len: ${tools.length} (builtin: ${builtinTools.length}, mcp: ${mcpTools.length})`)
  return tools
}
