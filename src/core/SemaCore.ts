import { SemaCoreConfig, ModelConfig, TaskConfig, FetchModelsParams, FetchModelsResult, ApiTestParams, ApiTestResult, ModelUpdateData, UpdatableCoreConfigKeys, UpdatableCoreConfig } from '../types';
import { ToolInfo } from '../types/index';
import { ToolPermissionResponse, AskQuestionResponseData, PlanExitResponseData } from '../events/types';
import { fetchModels, testApiConnection } from '../services/api/apiUtil';
import { getPluginsManager } from '../services/plugins/pluginsManager';
import { PluginScope, MarketplacePluginsInfo } from '../types/plugin';
import { getAgentsManager } from '../services/agents/agentsManager';
import { AgentConfig } from '../types/agent';
import { getSkillsManager } from '../services/skills/skillsManager';
import { SkillConfig } from '../types/skill';
import { getCommandsManager } from '../services/commands/commandsManager';
import { CommandConfig } from '../types/command';
import { getMCPManager } from '../services/mcp/MCPManager';
import { MCPServerConfig, MCPServerInfo } from '../types/mcp';
import { getMemoryManager } from '../services/memory/memManager';
import { MemoryConfig } from '../types/memory';
import { getRuleManager } from '../services/rules/rulesManager';
import { RuleConfig } from '../types/rule';
import { getTaskManager } from '../manager/TaskManager';
import { TaskRecord } from '../types/task';
import { SemaEngine } from './SemaEngine';
import { getConfManager } from '../manager/ConfManager';
import { getModelManager } from '../manager/ModelManager';
import { getToolInfos } from '../tools/base/tools';
import { resolveAdapter } from '../util/adapter';
import { logInfo } from '../util/log';

/**
 * Sema 核心 API 类
 * 提供简洁的公共接口，内部委托给 SemaEngine 处理业务逻辑
 */
export class SemaCore {
  private readonly engine: SemaEngine;
  private configPromise: Promise<void> | null = null;

  constructor(config?: SemaCoreConfig) {
    this.configPromise = getConfManager().setCoreConfig(config || {});
    this.engine = new SemaEngine();

    this.configPromise = this.configPromise.then(async () => {
      // 触发单例初始化，后台加载 市场插件信息、memory 信息、rule 信息
      getPluginsManager(); 
      getMemoryManager(); 
      getRuleManager(); 
    });
    logInfo(`初始化SemaCore: ${JSON.stringify(config, null, 2)}`)
  }

  // ==================== 事件接口 ====================
  // 监听事件接口 - 暴露所有监听能力
  on = <T>(event: string, listener: (data: T) => void) => (this.engine.on(event, listener), this);
  once = <T>(event: string, listener: (data: T) => void) => (this.engine.once(event, listener), this);
  off = <T>(event: string, listener: (data: T) => void) => (this.engine.off(event, listener), this);

  // 权限响应接口 - 只暴露必要的发送能力
  respondToToolPermission = (response: ToolPermissionResponse) =>
    this.engine.emit('tool:permission:response', response);
  respondToAskQuestion = (response: AskQuestionResponseData) =>
    this.engine.emit('ask:question:response', response);
  respondToPlanExit = (response: PlanExitResponseData) =>
    this.engine.emit('plan:exit:response', response);

  // ==================== 会话 ====================
  // 异步操作，通过事件通知结果
  createSession = async (sessionId?: string) => {
    // 等待配置设置完成
    if (this.configPromise) {
      await this.configPromise;
      this.configPromise = null;
    }
    return this.engine.createSession(sessionId);
  };
  processUserInput = (input: string, originalInput?: string): void => this.engine.processUserInput(input, originalInput);

  // ==================== 中断 ====================
  // 同步操作，立即执行
  interruptSession = () => this.engine.interruptSession();

  // ==================== 模型管理 ====================
  addModel = (config: ModelConfig, skipValidation?: boolean): Promise<ModelUpdateData> => getModelManager().addNewModel(config, skipValidation);
  delModel = (ModelName: string): Promise<ModelUpdateData> => getModelManager().deleteModel(ModelName);
  switchModel = (ModelName: string): Promise<ModelUpdateData> => getModelManager().switchCurrentModel(ModelName);
  applyTaskModel = (config: TaskConfig): Promise<ModelUpdateData> => getModelManager().applyTaskModelConfig(config);
  getModelData = (): Promise<ModelUpdateData> => getModelManager().getModelData();

  // ==================== 配置管理 ====================
  // 更新核心配置
  updateCoreConfByKey = <K extends UpdatableCoreConfigKeys>(key: K, value: SemaCoreConfig[K]): void => {
    getConfManager().updateCoreConfByKey(key, value);
    if (key === 'enableClaudeCodeCompat') {
      getPluginsManager().refreshMarketplacePluginsInfo().catch(() => {});
      getMemoryManager().refreshMemoryInfo().catch(() => {});
      getRuleManager().refreshRuleInfo().catch(() => {});
    }
  };
  updateCoreConfig = (config: UpdatableCoreConfig): void => {
    getConfManager().updateCoreConfig(config);
    if ('enableClaudeCodeCompat' in config) {
      getPluginsManager().refreshMarketplacePluginsInfo().catch(() => {});
      getMemoryManager().refreshMemoryInfo().catch(() => {});
      getRuleManager().refreshRuleInfo().catch(() => {});
    }
  };
  updateUseTools = (toolNames: string[] | null): void => getConfManager().updateUseTools(toolNames);
  updateAgentMode = (mode: 'Agent' | 'Plan'): void => this.engine.updateAgentMode(mode);
  getToolInfos = (): ToolInfo[] => getToolInfos();

  // ==================== 工具API ====================
  // 独立的工具函数，不依赖会话状态
  fetchAvailableModels = (params: FetchModelsParams): Promise<FetchModelsResult> => fetchModels(params);
  testApiConnection = (params: ApiTestParams): Promise<ApiTestResult> => testApiConnection(params);
  getModelAdapter = (provider: string, modelName: string) => resolveAdapter(provider, modelName);

  // ==================== 插件市场管理 ====================
  addMarketplaceFromGit = (repo: string): Promise<MarketplacePluginsInfo> => getPluginsManager().addMarketplaceFromGit(repo);
  addMarketplaceFromDirectory = (dirPath: string): Promise<MarketplacePluginsInfo> => getPluginsManager().addMarketplaceFromDirectory(dirPath);
  updateMarketplace = (marketplaceName: string): Promise<MarketplacePluginsInfo> => getPluginsManager().updateMarketplace(marketplaceName);
  removeMarketplace = (marketplaceName: string): Promise<MarketplacePluginsInfo> => getPluginsManager().removeMarketplace(marketplaceName);
  installPlugin = (pluginName: string, marketplaceName: string, scope: PluginScope, projectPath?: string): Promise<MarketplacePluginsInfo> => getPluginsManager().installPlugin(pluginName, marketplaceName, scope, projectPath);
  uninstallPlugin = (pluginName: string, marketplaceName: string, scope: PluginScope, projectPath?: string): Promise<MarketplacePluginsInfo> => getPluginsManager().uninstallPlugin(pluginName, marketplaceName, scope, projectPath);
  enablePlugin = (pluginName: string, marketplaceName: string, scope: PluginScope, projectPath?: string): Promise<MarketplacePluginsInfo> => getPluginsManager().enablePlugin(pluginName, marketplaceName, scope, projectPath);
  disablePlugin = (pluginName: string, marketplaceName: string, scope: PluginScope, projectPath?: string): Promise<MarketplacePluginsInfo> => getPluginsManager().disablePlugin(pluginName, marketplaceName, scope, projectPath);
  updatePlugin = (pluginName: string, marketplaceName: string, scope: PluginScope, projectPath?: string): Promise<MarketplacePluginsInfo> => getPluginsManager().updatePlugin(pluginName, marketplaceName, scope, projectPath);
  refreshMarketplacePluginsInfo = (): Promise<MarketplacePluginsInfo> => getPluginsManager().refreshMarketplacePluginsInfo();
  getMarketplacePluginsInfo = (): Promise<MarketplacePluginsInfo> => getPluginsManager().getMarketplacePluginsInfo();

  // ==================== Agents 管理 ====================
  getAgentsInfo = (): Promise<AgentConfig[]> => getAgentsManager().getAgentsInfo();
  refreshAgentsInfo = (): Promise<AgentConfig[]> => getAgentsManager().refreshAgentsInfo();
  addAgentConf = (agentConf: AgentConfig): Promise<AgentConfig[]> => getAgentsManager().addAgentConf(agentConf);
  removeAgentConf = (name: string): Promise<AgentConfig[]> => getAgentsManager().removeAgentConf(name);

  // ==================== Skills 管理 ====================
  getSkillsInfo = (): Promise<SkillConfig[]> => getSkillsManager().getSkillsInfo();
  refreshSkillsInfo = (): Promise<SkillConfig[]> => getSkillsManager().refreshSkillsInfo();
  removeSkillConf = (name: string): Promise<SkillConfig[]> => getSkillsManager().removeSkillConf(name);

  // ==================== Commands 管理 ====================
  getCommandsInfo = (): Promise<CommandConfig[]> => getCommandsManager().getCommandsInfo();
  refreshCommandsInfo = (): Promise<CommandConfig[]> => getCommandsManager().refreshCommandsInfo();
  addCommandConf = (commandConf: CommandConfig): Promise<CommandConfig[]> => getCommandsManager().addCommandConf(commandConf);
  removeCommandConf = (name: string): Promise<CommandConfig[]> => getCommandsManager().removeCommandConf(name);

  // ==================== MCP 管理 ====================
  getMCPServerInfo = (): Promise<MCPServerInfo[]>  => getMCPManager().getMCPServerConfigs();
  refreshMCPServerInfo = (): Promise<MCPServerInfo[]> => getMCPManager().refreshMCPServerConfigs();
  addMCPServer = (mcpConfig: MCPServerConfig): Promise<MCPServerInfo[]> => getMCPManager().addMCPServer(mcpConfig);
  removeMCPServer = (name: string): Promise<MCPServerInfo[]> => getMCPManager().removeMCPServer(name);
  reconnectMCPServer = (name: string): Promise<MCPServerInfo[]> => getMCPManager().reconnectMCPServer(name);
  disableMCPServer = (name: string): Promise<MCPServerInfo[]> => getMCPManager().disableMCPServer(name);
  enableMCPServer = (name: string): Promise<MCPServerInfo[]> => getMCPManager().enableMCPServer(name);
  updateMCPUseTools = (name: string, toolNames: string[]): Promise<MCPServerInfo[]> => getMCPManager().updateMCPUseTools(name, toolNames);

  // ==================== Memory 管理 ====================
  getMemoryInfo = (): Promise<MemoryConfig | null> => getMemoryManager().getMemoryInfo();
  refreshMemoryInfo = (): Promise<MemoryConfig | null> => getMemoryManager().refreshMemoryInfo();

  // ==================== Rule 管理 ====================
  getRuleInfo = (): Promise<RuleConfig | null> => getRuleManager().getRuleInfo();
  refreshRuleInfo = (): Promise<RuleConfig | null> => getRuleManager().refreshRuleInfo();

  // ==================== Task 管理 ====================
  getTasks = (): TaskRecord[] => getTaskManager().getTasks();
  watchTask = (taskId: string, onDelta: (delta: string) => void): () => void => getTaskManager().watchTask(taskId, onDelta);
  stopTask = (taskId: string): void => getTaskManager().stopTask(taskId);

  // ==================== 资源管理 ====================
  dispose = async () => {
    getTaskManager().dispose();
    getPluginsManager().dispose();
    getMemoryManager().dispose();
    getRuleManager().dispose();
    this.engine.dispose();
  };

}