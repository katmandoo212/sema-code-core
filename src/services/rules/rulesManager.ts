/**
 * Rule 管理器
 *
 * 管理 Rule 配置的全局加载和查找
 * 实现优先级：用户级(Claude) < 项目级(Claude) < 用户级(Sema) < 项目级(Sema)
 * 兼容 Claude Code 和 Sema 两套路径（Claude 只读）
 */

import * as fs from 'fs'
import { promises as fsPromises } from 'fs'
import * as path from 'path'
import { logDebug, logError, logInfo } from '../../util/log'
import { getSemaRootDir, getClaudeRootDir } from '../../util/savePath'
import { getOriginalCwd } from '../../util/cwd'
import { getConfManager } from '../../manager/ConfManager'
import { RuleConfig } from '../../types/rule'

const AGENTS_FILE_NAME = 'AGENTS.md'
const CLAUDE_FILE_NAME = 'CLAUDE.md'

/**
 * Rule 管理器类 - 单例模式
 */
class RuleManager {
  private semaUserRuleFile: string     // ~/.sema/AGENTS.md
  private semaProjectRuleFile: string  // <project>/AGENTS.md

  private claudeUserRuleFile: string    // ~/.claude/CLAUDE.md
  private claudeProjectRuleFile: string // <project>/CLAUDE.md

  private ruleInfoCache: RuleConfig | null | undefined = undefined
  private loadingPromise: Promise<RuleConfig | null> | null = null

  constructor() {
    const semaRootDir = getSemaRootDir()
    this.semaUserRuleFile = path.join(semaRootDir, AGENTS_FILE_NAME)

    const claudeRootDir = getClaudeRootDir()
    this.claudeUserRuleFile = path.join(claudeRootDir, CLAUDE_FILE_NAME)

    const cwd = getOriginalCwd()
    this.semaProjectRuleFile = path.join(cwd, AGENTS_FILE_NAME)
    this.claudeProjectRuleFile = path.join(cwd, CLAUDE_FILE_NAME)

    // 后台静默加载 rules 信息
    this.loadingPromise = this.refreshRuleInfo()
      .catch(err => {
        logError(`后台加载 Rule 信息失败: ${err}`)
        return null
      })
      .finally(() => { this.loadingPromise = null })
  }

  private invalidateCache(): void {
    this.ruleInfoCache = undefined
  }

  /**
   * 从文件加载 RuleConfig
   */
  private async loadRuleFromFile(filePath: string, locate: 'user' | 'project', from: string): Promise<RuleConfig | null> {
    try {
      if (!fs.existsSync(filePath)) {
        logDebug(`Rule 文件不存在: ${filePath}`)
        return null
      }

      const prompt = (await fsPromises.readFile(filePath, 'utf-8')).trim()
      if (!prompt) {
        logDebug(`Rule 文件内容为空: ${filePath}`)
        return null
      }

      return { prompt, locate, from, filePath }
    } catch (error) {
      logError(`加载 Rule 失败 [${filePath}]: ${error}`)
      return null
    }
  }

  /**
   * 加载 Rule 配置
   * 按优先级从高到低取第一个存在的：项目级(Sema) > 用户级(Sema) > 项目级(Claude) > 用户级(Claude)
   */
  private async loadRule(): Promise<RuleConfig | null> {
    const enableClaudeCodeCompat = getConfManager().getCoreConfig()?.enableClaudeCodeCompat !== false

    // 1. 项目级(Sema) - 最高优先级
    const semaProjectRule = await this.loadRuleFromFile(this.semaProjectRuleFile, 'project', 'sema')
    if (semaProjectRule) {
      logInfo('加载 Rule 配置: sema project')
      return semaProjectRule
    }

    // 2. 用户级(Sema)
    const semaUserRule = await this.loadRuleFromFile(this.semaUserRuleFile, 'user', 'sema')
    if (semaUserRule) {
      logInfo('加载 Rule 配置: sema user')
      return semaUserRule
    }

    if (enableClaudeCodeCompat) {
      // 3. 项目级(Claude)
      const claudeProjectRule = await this.loadRuleFromFile(this.claudeProjectRuleFile, 'project', 'claude')
      if (claudeProjectRule) {
        logInfo('加载 Rule 配置: claude project')
        return claudeProjectRule
      }

      // 4. 用户级(Claude) - 最低优先级
      const claudeUserRule = await this.loadRuleFromFile(this.claudeUserRuleFile, 'user', 'claude')
      if (claudeUserRule) {
        logInfo('加载 Rule 配置: claude user')
        return claudeUserRule
      }
    }

    logInfo('加载 Rule 配置: 无')
    return null
  }

  /**
   * 获取 Rule 信息（有缓存则直接返回，否则等待后台加载或重新加载）
   */
  async getRuleInfo(): Promise<RuleConfig | null> {
    if (this.ruleInfoCache !== undefined) {
      return this.ruleInfoCache
    }
    if (this.loadingPromise) {
      return this.loadingPromise
    }
    return this.refreshRuleInfo()
  }

  /**
   * 刷新 Rule 信息
   */
  async refreshRuleInfo(): Promise<RuleConfig | null> {
    logDebug('刷新 Rule 信息...')
    this.invalidateCache()

    const rule = await this.loadRule()
    this.ruleInfoCache = rule
    logInfo(`Rule 信息刷新完成: ${rule ? rule.from : '无'}`)
    return rule
  }

  /**
   * 同步获取 rules 描述（从缓存中读取）
   * 缓存未就绪时返回空字符串
   */
  getRuleDescription(): string {
    const rule = this.ruleInfoCache
    if (!rule || !rule.prompt) return ''
    const filePath = rule.filePath ?? ''
    const header = filePath
      ? `Contents of ${filePath} (user's private global instructions for all projects):`
      : `Project Rule:`
    return `${header}\n\n${rule.prompt}`
  }

  dispose(): void {
    this.invalidateCache()
  }
}

// ===================== 全局 Rule 管理器 =====================

let rulesManagerInstance: RuleManager | null = null

/**
 * 获取 Rule Manager 实例（单例模式）
 */
export function getRuleManager(): RuleManager {
  if (!rulesManagerInstance) {
    rulesManagerInstance = new RuleManager()
  }
  return rulesManagerInstance
}

export function getRuleDescription(): string {
  return getRuleManager().getRuleDescription()
}

export { RuleManager }
