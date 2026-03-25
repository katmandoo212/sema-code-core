import * as crypto from 'crypto'
import Anthropic from '@anthropic-ai/sdk'
import { logInfo, logDebug, setLogLevel, logWarn } from '../util/log';
import { initializeSessionId } from '../util/session';
import { getTokens } from '../util/tokens';
import { loadHistory } from '../util/history';
import { getTopicFromUserInput } from '../util/topic';
import { processFileReferences } from '../util/fileReference';
import { createUserMessage } from '../util/message';
import { generateRulesReminders, generateSkillsReminder } from '../services/agents/systemReminder';
import { formatSystemPrompt, generatePlanReminders } from '../services/agents/genSystemPrompt';
import { getConfManager } from '../manager/ConfManager';
import { getModelManager } from '../manager/ModelManager';
import { getTools } from '../tools/base/tools';
import { Tool } from '../tools/base/Tool';
import { EventBus } from '../events/EventSystem';
import { isInterruptedException } from '../types/errors';
import { Message } from '../types/message';
import { query } from './Conversation';
import type { AgentContext } from '../types/agent'
import { getMCPManager } from '../services/mcp/MCPManager';
import { getStateManager, MAIN_AGENT_ID } from '../manager/StateManager';
import { handleCommand } from '../services/commands/runCommand';


/**
 * Sema 引擎 - 处理核心业务逻辑
 */
export class SemaEngine {
  // 待处理的用户输入队列
  private pendingInputs: Array<{ inputId: string; input: string; originalInput?: string }> = []
  // 待处理的会话ID（只保留最新的一个）
  private pendingSession: string | null = null
  // 当前正在执行的 processQuery Promise（用于等待旧会话结束）
  private currentProcessingPromise: Promise<void> | null = null

  // 公共事件接口
  private eventBus = EventBus.getInstance();
  emit = <T>(event: string, data: T) => this.eventBus.emit(event, data as Record<string, any>);
  on = <T>(event: string, listener: (data: T) => void) => this.eventBus.on(event, listener);
  once = <T>(event: string, listener: (data: T) => void) => this.eventBus.once(event, listener);
  off = <T>(event: string, listener: (data: T) => void) => this.eventBus.off(event, listener);

  /**
   * 创建会话
   */
  async createSession(sessionId?: string): Promise<void> {
    const finalSessionId = sessionId || initializeSessionId();
    const stateManager = getStateManager();
    const mainAgentState = stateManager.forAgent(MAIN_AGENT_ID);

    // 如果当前正在处理，记录待处理的会话（只保留最新的）并中断，然后等待完成
    if (mainAgentState.getCurrentState() === 'processing') {
      this.pendingSession = finalSessionId; // 直接覆盖，只保留最新的会话
      this.abortCurrentRequest();
      logInfo(`会话正在处理中，待处理会话已记录: ${finalSessionId}（旧的待处理会话已被覆盖）`);

      // 等待旧会话处理完成（最多等待10秒）
      if (this.currentProcessingPromise) {
        const waitTimeoutSecond = 10
        logInfo(`等待旧会话结束...`);
        try {
          await Promise.race([
            this.currentProcessingPromise,
            new Promise((_, reject) => setTimeout(() => reject(new Error('等待超时')), 1000 * waitTimeoutSecond))
          ]);
          logInfo(`旧会话已结束`);
        } catch (error) {
          logWarn(`等待旧会话结束时出错: ${error instanceof Error ? error.message : String(error)}`);
        }
      }

      // 等待完成后，pendingSession 应该已经被 processQuery 的 finally 块处理并清空
      // 如果还存在（说明 finally 还没执行），则继续等待一小段时间
      if (this.pendingSession) {
        logInfo(`等待 finally 块处理 pendingSession...`);
        await new Promise(resolve => setTimeout(resolve, 100));
      }

      // 此时新会话应该已经创建完成（由 finally 块触发），直接返回
      // 注意：ready 事件已经在递归调用的 createSession 中发送
      return;
    }

    // 直接创建新会话，清空所有待处理状态
    this.abortCurrentRequest();
    this.pendingInputs = [];  // 清空输入队列，因为这些输入属于旧会话
    this.pendingSession = null;

    // 清空所有状态
    stateManager.clearAllState();

    // 初始化新会话
    await this.initialize(finalSessionId);
    const coreConfig = getConfManager().getCoreConfig();
    const workingDir = coreConfig?.workingDir;
    logInfo(`[DEBUG] loadHistory - workingDir: ${workingDir}, coreConfig: ${JSON.stringify(coreConfig)}`);
    const historyData = await loadHistory(sessionId, workingDir);
    logInfo(`会话CoreConfig: ${JSON.stringify(coreConfig, null, 2)}`)

    // 将加载的消息历史和 todos 设置到主代理状态
    mainAgentState.setMessageHistory(historyData.messages);
    mainAgentState.setTodos(historyData.todos);

    // 使用全局配置获取工作路径
    const projectConfig = getConfManager().getProjectConfig();
    const projectInputHistory = projectConfig?.history || [];

    // 获取tokens
    const usage = getTokens(mainAgentState.getMessageHistory())

    const sessionData = {
      workingDir: coreConfig?.workingDir,
      sessionId: stateManager.getSessionId(),
      historyLoaded: !!sessionId,
      projectInputHistory: projectInputHistory,
      usage: usage
    };

    logInfo(`新会话创建完成，sessionId: ${stateManager.getSessionId()}`);
    this.emit('session:ready', sessionData);
    mainAgentState.updateState('idle');
  }

  /**
   * 处理用户输入
   * 如果当前正在处理中，将输入加入队列等待
   */
  processUserInput(input: string, originalInput?: string): void {
    const mainAgentState = getStateManager().forAgent(MAIN_AGENT_ID);
    const inputId = crypto.randomUUID().replace(/-/g, '').substring(0, 8)

    if (mainAgentState.getCurrentState() === 'processing') {
      this.pendingInputs.push({ inputId, input: input.trim(), originalInput })
      logInfo(`输入已入队，队列长度: ${this.pendingInputs.length}`)
      this.emit('input:received', {
        inputId,
        input: input.trim(),
        originalInput,
        queued: true,
        queueLength: this.pendingInputs.length,
      })
      return
    }

    this.emit('input:received', {
      inputId,
      input: input.trim(),
      originalInput,
      queued: false,
      queueLength: 0,
    })
    this.startQuery([{ inputId, input: input.trim(), originalInput }]);
  }

  /**
   * 启动一次查询（构建上下文并调用 processQuery）
   */
  private startQuery(inputs: Array<{ inputId: string; input: string; originalInput?: string }>): void {
    const stateManager = getStateManager();
    const mainAgentState = stateManager.forAgent(MAIN_AGENT_ID);
    mainAgentState.updateState('processing');

    logInfo(`用户输入(${inputs.length}条): ${inputs.map(i => i.input).join(' | ')}`);

    // 创建新的 AbortController 用于此次处理
    stateManager.currentAbortController = new AbortController();

    // 获取核心配置
    const coreConfig = getConfManager().getCoreConfig();

    // 获取工具集
    let tools: Tool[];
    const builtinTools = getTools(coreConfig?.useTools);
    const mcpTools = getMCPManager().getMCPTools();
    tools = [...builtinTools, ...mcpTools];
    // 若 Plan 模式，去掉 TodoWrite 工具
    const agentMode = coreConfig?.agentMode || 'Agent';
    if (agentMode === 'Plan') {
      tools = tools.filter(tool => tool.name !== 'TodoWrite');
    }
    logInfo(`tools len: ${tools.length} (builtin: ${builtinTools.length}, mcp: ${mcpTools.length})`);

    // 构建主代理上下文
    const agentContext: AgentContext = {
      agentId: MAIN_AGENT_ID,
      abortController: stateManager.currentAbortController,
      tools,
      model: 'main',
    }

    // 保存当前的 processQuery Promise，用于等待其完成
    this.currentProcessingPromise = this.processQuery(inputs, agentContext, agentMode)
      .catch(error => {
        logWarn(`processQuery 未捕获异常: ${error instanceof Error ? error.message : String(error)}`);
        // 确保清理 AbortController（防止竞态条件）
        if (stateManager.currentAbortController === agentContext.abortController) {
          stateManager.currentAbortController = null;
        }
        mainAgentState.updateState('idle');
      })
      .finally(() => {
        // 清空 Promise 引用
        this.currentProcessingPromise = null;
      });
  }

  /**
   * 处理查询逻辑
   * @param inputs 待处理的输入数组（多条普通输入或单条命令）
   */
  private async processQuery(
    inputs: Array<{ inputId: string; input: string; originalInput?: string }>,
    agentContext: AgentContext,
    agentMode: 'Agent' | 'Plan'
  ): Promise<void> {
    // 获取状态管理器和主代理状态
    const stateManager = getStateManager();
    const mainAgentState = stateManager.forAgent(MAIN_AGENT_ID);

    // 为每条输入发送独立的 input:processing 事件
    for (const item of inputs) {
      this.emit('input:processing', { inputId: item.inputId, input: item.input, originalInput: item.originalInput })
    }

    try {
      // 将每条用户输入保存到项目配置的 history
      for (const item of inputs) {
        getConfManager().saveUserInputToHistory(item.originalInput || item.input);
      }

      // 处理命令，收集所有 blocks
      const allBlocks: Anthropic.ContentBlockParam[] = [];
      let combinedProcessedText = '';

      for (const item of inputs) {
        // abort 早期检查：避免会话切换后继续执行无用操作
        if (agentContext.abortController.signal.aborted) {
          logInfo('processQuery: abort detected during handleCommand loop, skipping remaining');
          return;
        }
        const commandResult = await handleCommand(item.input);
        if (commandResult === null) {
          // 系统命令已处理（如 /compact, /clear），跳过
          continue;
        }
        combinedProcessedText += (combinedProcessedText ? '\n' : '') + commandResult.processedText;
        allBlocks.push(...commandResult.blocks);
      }

      // 如果所有输入都是系统命令（返回 null），直接结束
      if (allBlocks.length === 0) {
        return;
      }

      // abort 早期检查
      if (agentContext.abortController.signal.aborted) {
        logInfo('processQuery: abort detected after handleCommand, skipping remaining');
        return;
      }

      // 后台异步执行话题检测，不阻塞主流程（使用所有输入拼接）
      const allOriginalTexts = inputs.map(i => i.originalInput || i.input).join('\n');
      if (!getConfManager().getCoreConfig()?.disableTopicDetection) {
        this.detectTopicInBackground(allOriginalTexts);
      }

      // 处理文件引用以获取补充信息（使用处理后的文本）
      const fileReferencesResult = await processFileReferences(combinedProcessedText, agentContext)
      logInfo(`返回文件引用信息: ${JSON.stringify(fileReferencesResult.supplementaryInfo, null, 2)}`)

      if (fileReferencesResult.supplementaryInfo.length > 0) {
        this.emit('file:reference', {
          references: fileReferencesResult.supplementaryInfo
        });
      }

      // abort 早期检查
      if (agentContext.abortController.signal.aborted) {
        logInfo('processQuery: abort detected after processFileReferences, skipping remaining');
        return;
      }

      // 1、构建系统提示（根据是否有代理配置决定）
      const hasSkillTool = agentContext.tools.some(tool => tool.name === 'Skill');
      const systemPromptContent = await formatSystemPrompt();

      // 2、构建用户消息内容
      // 2.1 获取消息历史
      const messageHistory = mainAgentState.getMessageHistory()

      // 2.2 当前用户输入
      // 构建reminder信息 文件引用 每次输入均添加，首次查询添加 todos\rules，Plan 模式添加 Plan 信息
      const additionalReminders = this.buildAdditionalReminders(
        fileReferencesResult.systemReminders,
        messageHistory,
        agentMode,
        hasSkillTool
      )
      const userMessage = createUserMessage([
        ...additionalReminders,
        ...allBlocks
      ])

      // 2.3 完整消息
      const messages: Message[] = [...messageHistory, userMessage]

      // 调用 query 函数
      for await (const _message of query(
        messages,
        systemPromptContent,
        agentContext,
      )) {
        // query 生成器会 yield 消息并在内部通过 finalizeMessages 更新历史
      }

    } catch (error) {
      if (isInterruptedException(error)) {
        logDebug('用户中断操作');
      }
      // API 错误已在 emitSessionError 中记录，这里不重复记录
    } finally {
      // 延迟清空 AbortController，确保所有中断逻辑执行完毕（避免竞态条件）
      const currentAbortController = stateManager.currentAbortController;
      if (currentAbortController === agentContext.abortController) {
        // 使用 setTimeout 0 确保当前执行栈完成后再清空
        setTimeout(() => {
          if (stateManager.currentAbortController === currentAbortController) {
            stateManager.currentAbortController = null;
          }
        }, 0);
      }

      // 优先处理待创建的会话（会话切换优先级最高）
      if (this.pendingSession) {
        const sessionId = this.pendingSession;
        this.pendingSession = null;
        this.pendingInputs = []; // 清空输入队列，因为这些输入属于旧会话

        logInfo(`检测到待处理会话，开始创建: ${sessionId}`);
        this.createSession(sessionId).catch(error => {
          logWarn(`创建待处理会话失败: ${error instanceof Error ? error.message : String(error)}`);
          mainAgentState.updateState('idle');
        });
        return;
      }

      // 处理同一会话中的待处理输入队列
      if (this.pendingInputs.length > 0) {
        const pending = this.pendingInputs.splice(0)
        const batch = this.takeNextBatch(pending)

        // 剩余的放回队列
        if (pending.length > 0) {
          this.pendingInputs = [...pending, ...this.pendingInputs]
        }

        logInfo(`处理队列中 ${batch.length} 条待处理输入`)
        this.startQuery(batch)
      } else {
        mainAgentState.updateState('idle');
      }
    }
  }

  /**
   * 从待处理队列中取出下一批输入
   * 规则：
   * - 如果第一条是命令（/开头），单独取出作为一批
   * - 否则取出所有连续的非命令输入，直到遇到命令为止
   * 取出的元素从 pending 数组中移除（splice）
   */
  private takeNextBatch(
    pending: Array<{ inputId: string; input: string; originalInput?: string }>
  ): Array<{ inputId: string; input: string; originalInput?: string }> {
    if (pending.length === 0) return []

    // 第一条是命令，单独处理
    if (pending[0].input.startsWith('/')) {
      return pending.splice(0, 1)
    }

    // 找到下一个命令的位置
    const nextCommandIdx = pending.findIndex(p => p.input.startsWith('/'))
    if (nextCommandIdx === -1) {
      // 没有命令，全部取出
      return pending.splice(0)
    }

    // 取出命令之前的所有普通输入
    return pending.splice(0, nextCommandIdx)
  }

  /**
   * 构建 additionalReminders：文件引用、首次查询、Plan 模式信息、skill信息
   */
  private buildAdditionalReminders(
    systemReminders: Anthropic.ContentBlockParam[],
    messageHistory: Message[],
    agentMode: 'Agent' | 'Plan',
    hasSkillTool: boolean = false,
  ): Anthropic.ContentBlockParam[] {
    // 文件引用 每次输入均添加
    const reminders = [...systemReminders]

    // 判断是否为首次查询（消息历史为空），添加首次查询的额外信息 skills\rules
    if (messageHistory.length === 0) {
      // 添加 skills 信息（仅当工具集中包含 Skill 工具时）
      if (hasSkillTool) {
        reminders.push(...generateSkillsReminder())
      }

      // 添加 rules 信息
      reminders.push(...generateRulesReminders())
    }

    // 判断是否为首次 Plan 模式查询，添加 Plan 模式信息
    const stateManager = getStateManager()
    if (agentMode === 'Plan' && !stateManager.isPlanModeInfoSent()) {
      reminders.push(...generatePlanReminders())
      stateManager.markPlanModeInfoSent()
    }

    return reminders
  }

  /**
   * 中止当前正在进行的请求（仅处理 AbortController）
   * 不更新状态，用于内部调用
   */
  private abortCurrentRequest(): void {
    const stateManager = getStateManager();
    const abortController = stateManager.currentAbortController;
    if (abortController && !abortController.signal.aborted) {
      logInfo('通过 AbortController 发送中断信号');
      abortController.abort();
    }
    stateManager.currentAbortController = null;
  }

  /**
   * 中断当前会话
   * 仅中断当前正在执行的请求，队列中的待处理输入不受影响
   * 由 processQuery 的 finally 决定是否继续消费队列或设为 idle
   */
  interruptSession(): void {
    this.abortCurrentRequest();
    // 不直接设 idle，由 processQuery 的 finally 决定
    // 若当前未在 processing（如已经 idle），则无需额外操作
  }

  /**
   * 更新 Agent 模式
   */
  updateAgentMode(mode: 'Agent' | 'Plan'): void {
    // 若模式值无变化，直接返回
    const currentMode = getConfManager().getCoreConfig()?.agentMode || 'Agent';
    if (currentMode === mode) {
      return;
    }

    // 更新配置
    getConfManager().updateAgentMode(mode);

    // 切换到 Plan 模式时，重置 Plan 模式信息发送状态
    if (mode === 'Plan') {
      getStateManager().resetPlanModeInfoSent();
    }
  }

  /**
   * 后台异步检测话题，不阻塞主流程
   */
  private async detectTopicInBackground(userInput: string): Promise<void> {
    // 创建独立的 AbortController 用于话题检测
    const topicAbortController = new AbortController();

    // 如果主会话被中断，也中断话题检测
    const stateManager = getStateManager();
    const mainAbortController = stateManager.currentAbortController;

    // 保存监听器引用，确保能够清理
    let abortListener: (() => void) | null = null;
    if (mainAbortController) {
      abortListener = () => {
        topicAbortController.abort();
      };
      mainAbortController.signal.addEventListener('abort', abortListener, { once: true });
    }

    try {
      const topicResult = await getTopicFromUserInput(userInput, topicAbortController.signal);

      if (topicResult) {
        logDebug(`话题检测结果: ${JSON.stringify(topicResult)}`);
        // 发送话题更新事件
        this.emit('topic:update', topicResult);
      }
    } catch (error) {
      // 话题检测失败不影响主流程，只记录调试日志
      if (!isInterruptedException(error)) {
        logDebug(`话题检测失败: ${error}`);
      }
    } finally {
      // 清理监听器（防止内存泄漏）
      if (abortListener && mainAbortController) {
        mainAbortController.signal.removeEventListener('abort', abortListener);
      }
    }
  }

  // 初始化系统
  private async initialize(sessionId?: string): Promise<void> {
    const coreConfig = getConfManager().getCoreConfig();

    // 1、设置日志级别
    setLogLevel(coreConfig?.logLevel || 'info');

    // 2、设置sessionId（如果为空则生成一个）
    const finalSessionId = sessionId || initializeSessionId();
    const stateManager = getStateManager();
    stateManager.setSessionId(finalSessionId);

    // 3、从配置文件加载模型配置 ~/.sema.conf
    try {
      const modelManager = getModelManager();
      const modelProfile = modelManager.getModel('main')

      // 检查是否有可用模型
      if (!modelProfile) {
        // 发送无模型配置事件
        this.emit('config:no_models', {
          message: '未配置任何模型，请先添加模型配置',
          suggestion: ''
        });
      }

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      // 发送模型配置错误事件
      this.emit('session:error', {
        type: 'model_error',
        error: {
          code: 'MODEL_CONFIG_ERROR',
          message: '模型配置文件加载失败，可尝试删除模型配置文件后重新添加模型',
          details: { error: errorMessage }
        }
      });
      throw error;
    }
  }

  /**
   * 清理资源和停止所有活动
   */
  dispose(): void {
    logInfo('开始清理 SemaEngine 资源...');

    // 1. 中止当前正在进行的请求并清空队列
    this.abortCurrentRequest();
    this.pendingInputs = [];
    this.pendingSession = null;

    // 2. 清空所有状态数据
    const stateManager = getStateManager();
    stateManager.clearAllState();

    // 3. 移除所有事件监听器
    this.eventBus.removeAllListeners();

    logInfo('SemaEngine 资源清理完成');
  }
}