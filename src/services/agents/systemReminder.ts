import Anthropic from '@anthropic-ai/sdk'
import { getConfManager } from '../../manager/ConfManager'
import { getSkillTypesDescription } from '../skills/skillsManager'
import { getMemoryDescription } from '../memory/memManager'
import { getRuleDescription } from '../rules/rulesManager'

/**
 * 生成 customRules 描述段
 */
function buildCustomRulesSection(): string {
  const configManager = getConfManager()
  const coreConfig = configManager.getCoreConfig()
  const customRules = coreConfig?.customRules ?? ''
  if (!customRules) return ''
  return `Custom rules (user-defined instructions):\n\n${customRules}`
}

/**
 * 生成当前日期描述段
 */
function buildCurrentDateSection(): string {
  const today = new Date()
  const dateStr = today.toISOString().slice(0, 10)
  return `# currentDate\nToday's date is ${dateStr}.`
}

/**
 * 生成 skills 相关的系统提醒信息
 */
export function generateSkillsReminder(): Anthropic.ContentBlockParam[] {
  const skillsDesc = getSkillTypesDescription()
  if (!skillsDesc) return []

  const reminder = `<system-reminder>\nThe following skills are available for use with the Skill tool:\n\n${skillsDesc}\n</system-reminder>`

  return [{
    type: 'text' as const,
    text: reminder
  }]
}

/**
 * 生成 rules 相关的系统提醒信息
 */
export function generateRulesReminders(): Anthropic.ContentBlockParam[] {
  const customRulesSection = buildCustomRulesSection()
  const ruleSection = getRuleDescription()
  const memorySection = getMemoryDescription()

  // 如果全局、项目配置、系统规则配置和 memory 均为空，直接返回空数组
  if (!ruleSection && !customRulesSection && !memorySection) {
    return []
  }

  const sections = [customRulesSection, ruleSection, memorySection, buildCurrentDateSection()]
    .filter(Boolean)
    .join('\n\n')

  const rulesReminder = `<system-reminder>
As you answer the user's questions, you can use the following context:

Codebase and user instructions are shown below. Be sure to adhere to these instructions. IMPORTANT: These instructions OVERRIDE any default behavior and you MUST follow them exactly as written.

${sections}

IMPORTANT: this context may or may not be relevant to your tasks. You should not respond to this context unless it is highly relevant to your task.\n</system-reminder>`

  return [{
    type: 'text' as const,
    text: rulesReminder
  }]
}
