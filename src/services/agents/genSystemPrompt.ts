import Anthropic from '@anthropic-ai/sdk'
import { PRODUCT_NAME, GROUP } from '../../constants/product'
import { getGitStatus } from '../../util/git'
import { getEnv } from '../../util/env'
import { memoize } from 'lodash-es'
import { getConfManager } from '../../manager/ConfManager'
import { getOriginalCwd } from '../../util/cwd'
import * as path from 'path';
import { getMemoryManager } from '../memory/memManager'
import { 
  Agent_Summary_Prompt,
  System_Prompt,
  Doing_Tasks_Prompt,
  Executing_actions_with_care_Prompt,
  Using_your_tools_Prompt,
  Tone_and_style_Prompt,
  auto_memory_Prompt,
  PlanMode_Reminder_Prompt,
  SUBAGENT_NOTES
} from './prompt'

export async function formatSystemPrompt(): Promise<Array<{ type: 'text', text: string }>> {
  // 获取系统提示、上下文
  const context = await getContext()

  // 合并系统提示，每个部分作为独立的 text 内容
  const systemPromptParts = [
    getProductSyspromptPrefix(),
    getSystemPrompt(context)
  ].filter(prompt => prompt.trim().length > 0); // 过滤空提示

  // 转换为 text 内容数组格式
  return systemPromptParts.map(text => ({ type: 'text' as const, text }));
}

const getContext = memoize(
  async (): Promise<{
    [k: string]: string
  }> => {
    // 并行获取各种上下文信息
    const [env, gitStatus] = await Promise.all([
      getEnv(), // 目录结构
      getGitStatus(), // Git状态信息
    ])

    // 返回组合的上下文对象
    return {
      ...(env ? { env } : {}),
      ...(gitStatus ? { gitStatus } : {}),
    }
  }
)

function getProductSyspromptPrefix(): string {
  try {
    // 尝试从配置管理器中获取自定义的 systemPrompt
    const configManager = getConfManager();
    const coreConfig = configManager.getCoreConfig();

    if (coreConfig?.systemPrompt) {
      return coreConfig.systemPrompt;
    }
  } catch (error) {
  }

  // 如果没有配置自定义 systemPrompt，使用默认值
  return `You are ${PRODUCT_NAME}, ${GROUP}'s Agent AI for coding.`;
}

function getSystemPrompt(context: Record<string, any> = {}): string {
  const memoryDir = getMemoryManager().getActiveMemoryDir()
  const auto_memory_Prompt_Pro = auto_memory_Prompt.replace('MEMORY_PATH_DIR', memoryDir)

  return `
${Agent_Summary_Prompt}

${System_Prompt}

${Doing_Tasks_Prompt}

${Executing_actions_with_care_Prompt}

${Using_your_tools_Prompt}

${Tone_and_style_Prompt}

${auto_memory_Prompt_Pro}

${genEnv(context)}

${genGitStatus(context)}

When working with tool results, write down any important information you might need later in your response, as the original tool result may be cleared later.
`
}


export function genEnv(context: Record<string, any>): string {
  if (context && 'env' in context) {
    return `Here is useful information about the environment you are running in:
<env>${context.env}</env>`;
  }
  return '';
}

export function genGitStatus(context: Record<string, any>): string {
  if (context && 'gitStatus' in context) {
    return `gitStatus: ${context.gitStatus}`;
  }
  return '';
}

export function generatePlanReminders(taskDescription?: string): Anthropic.ContentBlockParam[] {
  const additionalReminders: Anthropic.ContentBlockParam[] = []
  const currentDir = getOriginalCwd()
  const plansDir = path.join(currentDir, '.sema/', 'plans/')
  
  // 生成计划文件名的提示
  const planFileInstruction = taskDescription 
    ? `You should create your plan at ${plansDir}<title>.md where <title> is a descriptive name based on the task: "${taskDescription}". Choose a clear, concise title in kebab-case (e.g., "implement-api-gateway.md", "fix-streaming-parser.md").`
    : `You should create your plan at ${plansDir}<title>.md where <title> is a descriptive name you generate based on the user's request. Choose a clear, concise title in kebab-case.`

  const rulesReminder = `<system-reminder>
Plan mode is active. The user indicated that they do not want you to execute yet -- you MUST NOT make any edits (with the exception of the plan file mentioned below), run any non-readonly tools (including changing configs or making commits), or otherwise make any changes to the system. This supersedes any other instructions you have received.

## Plan File Info:
No plan file exists yet. ${planFileInstruction}
You should build your plan incrementally by writing to or editing this file. NOTE that this is the only file you are allowed to edit - other than this you are only allowed to take READ-ONLY actions.

${PlanMode_Reminder_Prompt}
</system-reminder>`

  additionalReminders.push({
    type: 'text' as const,
    text: rulesReminder
  })

  return additionalReminders
}

/**
 * 构建代理模式的系统提示（用于 Explore/Plan 等子代理）
 */
export async function buildAgentSystemPrompt(agentPrompt: string): Promise<Array<{ type: 'text', text: string }>> {
  const context = await getContext()
  const fullPrompt = agentPrompt + SUBAGENT_NOTES + genEnv(context) + genGitStatus(context)
  return [{ type: 'text' as const, text: fullPrompt }]
}