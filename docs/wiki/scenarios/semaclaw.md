# SemaClaw 

## 项目概述

**SemaClaw** 是一个通用的开源个人 AI Agent 框架，构建在 Sema Code Core 之上的可复用 Agent 运行时。它提供了将原始运行时变成一个真正可用的个人 AI 系统所需的全部周边设施 —— 权限管理、记忆系统、定时任务、多 Agent 编排、频道适配、Web UI 等等。

完整项目地址：[SemaClaw](https://github.com/midea-ai/SemaClaw)

> SemaClaw 既是一个开箱即用的个人 AI Agent 框架，也是一个参考实现，是社区评估并改进底层工程决策的起点。

## 核心亮点

- **三层上下文管理** —— 将工作上下文、长期记忆检索与按 Agent 划分的人格分区统一为同一个一致模型。
- **Human-in-the-Loop 权限审批** —— `PermissionBridge` 是 harness 的原生原语，同时支持高风险工具调用的显式用户授权与 Agent 主动发起的澄清请求。
- **四层插件架构** —— MCP 工具、子 Agent、Skills、Hooks，每一层对应一个明确的工程关注点,构成一个有原则的扩展面。
- **DAG Teams** —— 两阶段混合编排框架：将 LLM 驱动的动态任务分解，与基于持久 Agent 人格的确定性 DAG 执行结合起来。
- **四模式定时任务** —— 纯通知 / 纯脚本 / 纯 Agent / 脚本+Agent 混合，按任务复杂度匹配执行模式，让 token 消耗与推理工作量成正比。
- **Agentic Wiki** —— 将任务输出转化为结构化、可检索的 wiki 条目,与 Agent 记忆共同建立索引，形成会持续复利、能反哺未来 Agent 会话的个人知识库。
- **多频道与 Web UI** —— 内置 Telegram、飞书、QQ 适配器，配套 WebSocket Gateway 与 React Web UI。

## 快速开始

### 方式 A —— 从 npm 安装（推荐）

```bash
# 1. 全局安装
npm install -g semaclaw

# 2. 启动
semaclaw
```

启动后在浏览器打开 Web UI：<http://127.0.0.1:18788/>

> **首次启动需配置 LLM。** SemaClaw 不内置任何模型。打开 Web UI → **设置 → LLM**，添加一个 provider profile（OpenAI / Anthropic / DeepSeek / Qwen / ……），填写 `baseURL`、`apiKey`、`modelName`。配置会持久化到 `~/.semaclaw/config.json`。在至少有一个 active profile 之前，任何调用 LLM 的 Agent 运行都会失败。

如需启用消息频道（Telegram / 飞书 / QQ / 微信），在启动 `semaclaw` 之前，在当前工作目录创建 `.env` 文件即可。

### 方式 B —— 从源码构建

```bash
# 1. 克隆
git clone https://github.com/midea-ai/SemaClaw.git
cd SemaClaw

# 2. 安装与构建
npm install
npm run build
npm run build:web

# 3. 配置环境变量（可选）
cp .env.example .env
# 编辑 .env 以启用消息频道（Telegram / 飞书 / QQ / 微信）
# 如果不配置任何频道，SemaClaw 将以 Web UI 单机模式启动

# 4. 启动
npm start
```

## 项目结构

```
semaclaw/
├── src/
│   ├── agent/          # Agent 生命周期、bridges、权限路由
│   ├── channels/       # Telegram / 飞书 / QQ 适配器
│   ├── gateway/        # GroupManager、MessageRouter、WebSocket Gateway
│   ├── mcp/            # MCP servers（admin / schedule / memory / dispatch / ...）
│   ├── memory/         # FTS5 + 向量混合搜索、每日日志
│   ├── scheduler/      # Cron / interval / once 调度
│   ├── wiki/           # Git 驱动的个人知识库
│   └── clawhub/        # ClaWHub 技能市场集成
├── web/                # React + Vite Web UI
├── skills/             # 内置技能
└── docs/               # 详细文档
```

## 与 Sema Code Core 的关系

SemaClaw 构建在 [sema-code-core](https://github.com/midea-ai/sema-code-core) 之上 —— 后者提供了底层 Agent 运行时。SemaClaw 在此基础上扩展出权限审批、长期记忆、定时任务、多 Agent 编排、频道适配等周边能力，将原始运行时打磨成一个真正可用的个人 AI 系统。
