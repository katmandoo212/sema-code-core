import Anthropic from '@anthropic-ai/sdk'
import { Tool } from './Tool'
import { BashTool } from '../Bash/Bash'
import { FileEditTool } from '../Edit/Edit'
import { FileReadTool } from '../Read/Read'
import { FileWriteTool } from '../Write/Write'
import { GlobTool } from '../Glob/Glob'
import { GrepTool } from '../Grep/Grep'
import { NotebookEditTool } from '../NotebookEdit/NotebookEdit'
import { SkillTool } from '../Skill/Skill'
import { AgentTool } from '../Agent/Agent'
import { AskUserQuestionTool } from '../AskUserQuestion/AskUserQuestion'
import { ExitPlanModeTool } from '../ExitPlanMode/ExitPlanMode'
import { TaskOutputTool } from '../TaskOutput/TaskOutput'
import { TaskStopTool } from '../TaskStop/TaskStop'
import { TaskCreateTool } from '../TaskCreate/TaskCreate'
import { TaskGetTool } from '../TaskGet/TaskGet'
import { TaskListTool } from '../TaskList/TaskList'
import { TaskUpdateTool } from '../TaskUpdate/TaskUpdate'
import { CronCreateTool } from '../CronCreate/CronCreate'
import { CronDeleteTool } from '../CronDelete/CronDelete'
import { CronListTool } from '../CronList/CronList'
import { WebFetchTool } from '../WebFetch/WebFetch'
import { getMCPManager } from '../../services/mcp/MCPManager'
import { getConfManager } from '../../manager/ConfManager'
import { zodToJsonSchema } from 'zod-to-json-schema'
import { memoize } from 'lodash-es'
import { ToolInfo } from '../../types/index'
import { logInfo } from '../../util/log'


const BG_TOOLS = new Set(['Bash', 'Agent'])

// 子代理中禁用的工具（防止嵌套调用、任务管理等）
export const SUBAGENT_EXCLUDED_TOOLS = new Set([
  'Agent', 'TaskOutput', 'TaskStop', 'AskUserQuestion', 'ExitPlanMode',
  'TaskCreate', 'TaskGet', 'TaskList', 'TaskUpdate'
])


// 将工具对象安全转换为 Tool 类型（各工具的字面量类型与 Tool 泛型不完全匹配）
const asTool = (tool: any): Tool => tool

// 获取全部内置工具信息（含启用/禁用状态）
export const getAllBuiltinToolInfos = (): ToolInfo[] => {
  const useTools = getConfManager().getCoreConfig()?.useTools
  return getBuiltinTools().map(tool => ({
    name: tool.name,
    description: getToolDescription(tool),
    status: (!useTools || useTools.includes(tool.name)) ? 'enable' : 'disable'
  }))
}

// 获取全部内置工具
export const getBuiltinTools = (): Tool[] => {
  return [
    BashTool,
    GlobTool,
    GrepTool,
    FileReadTool,
    FileWriteTool,
    FileEditTool,
    WebFetchTool,
    AgentTool,
    TaskOutputTool,
    TaskStopTool,
    SkillTool,
    NotebookEditTool,
    AskUserQuestionTool,
    ExitPlanModeTool,
    TaskCreateTool,
    TaskGetTool,
    TaskListTool,
    TaskUpdateTool,
    CronCreateTool,
    CronDeleteTool,
    CronListTool,
  ].map(asTool)
}

// 获取可用内置工具（按 useTools 配置过滤）
export const getAvailableBuiltinTools = memoize(
  (useTools?: string[] | null): Tool[] => {
    const allTools = getBuiltinTools()

    if (!useTools) {
      return allTools
    }

    return allTools.filter(tool => useTools.includes(tool.name))
  },
  (useTools?: string[] | null) => {
    if (!useTools) {
      return 'all-tools'
    }
    return useTools.sort().join(',')
  }
)

// 获取可用内置工具 + MCP 工具
export function getAvailableTools(): Tool[] {
  const useTools = getConfManager().getCoreConfig()?.useTools
  const builtinTools = getAvailableBuiltinTools(useTools)
  const mcpTools = getMCPManager().getMCPTools()
  const tools: Tool[] = [...builtinTools, ...mcpTools]
  logInfo(`tools len: ${tools.length} (builtin: ${builtinTools.length}, mcp: ${mcpTools.length})`)
  return tools
}


// 从 zod schema 中提取 required 字段
function extractRequiredFields(schema: any): string[] {
  if (!schema || typeof schema !== 'object') return []

  if (schema._def && schema._def.shape) {
    const shape = schema._def.shape()
    return Object.entries(shape)
      .filter(([_, fieldSchema]: [string, any]) => {
        return !fieldSchema.isOptional()
      })
      .map(([fieldName]) => fieldName)
  }

  if (schema.properties) {
    return schema.required || []
  }

  return []
}

// 使用 memoize 优化的 buildTools 函数
export const buildTools = memoize(
  (tools: Tool[]): Anthropic.Tool[] => {
    const disableBackgroundTasks = getConfManager().getCoreConfig()?.disableBackgroundTasks ?? false
    return tools.map(tool => {
      const jsonSchema = zodToJsonSchema(tool.inputSchema as any);
      const requiredFields = extractRequiredFields(tool.inputSchema);

      // 安全地获取 properties
      let properties = (jsonSchema && typeof jsonSchema === 'object' && 'properties' in jsonSchema)
        ? { ...(jsonSchema.properties as Record<string, unknown>) }
        : jsonSchema

      // 禁用后台任务时，从 Bash/Agent 的 schema 中过滤 run_in_background
      if (disableBackgroundTasks && BG_TOOLS.has(tool.name) && properties && typeof properties === 'object') {
        const { run_in_background: _, ...rest } = properties as Record<string, unknown>
        properties = rest
      }

      return {
        name: tool.name,
        description: getToolDescription(tool),
        input_schema: {
          type: 'object',
          properties: properties,
          required: requiredFields
        }
      }
    })
  },
  (tools: Tool[]) => {
    const disableBackgroundTasks = getConfManager().getCoreConfig()?.disableBackgroundTasks ?? false
    return tools.map(tool => tool.name).sort().join(',') + (disableBackgroundTasks ? ':no-bg' : '')
  }
)

// 辅助函数：获取工具描述
export function getToolDescription(tool: Tool): string {
  if (typeof tool.description === 'function') {
    return tool.description()
  }
  return tool.description || ''
}