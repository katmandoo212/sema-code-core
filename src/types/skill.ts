/**
 * Skill 系统类型定义
 *
 * 实现 Claude Skills 的类型系统，支持渐进式披露和 allowed-tools 软约束
 */

export type SkillScope = 'user' | 'project' | 'plugin'

export interface SkillConfig {
  name: string
  description: string
  prompt: string
  locate?: SkillScope
  from?: string
  filePath?: string
}