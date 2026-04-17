---

## 开篇：AI 编码的能力，为什么被"锁死"了？

2026 年，AI 编码赛道的热度又上了一个台阶——

**OpenClaw** 半年冲到 35.8 万 GitHub stars，成为史上增长最快的开源项目之一；Nous Research 的 **Hermes Agent** 凭"自学习闭环"两个月做到 9 万+ stars。头部玩家同样能打：**Claude Code** 以 Opus 4.6 在 SWE-bench Verified 跑出 80.8%，网传新一代 **Claude Mythos Preview** 更是把天花板推到 93.9%。

一个共识已经形成：**AI 编码不再是锦上添花，而是工程生产力的核心乘数。**

但从"企业工程团队"的角度看，情况就不一样了——这些产品的推理引擎都和自家客户端深度耦合，能用但拆不开。开源也不等于可解耦：OpenClaw 虽然代码公开，想把推理内核抽出来嵌入自家服务，改造成本比重写一遍还高。

问题不是工具不够好，而是一个定位错误：**现有方案都把 AI 编码当成"产品功能"来做，而不是当成"基础设施层"来做**。

---

## Sema Code 的答案：引擎即基础设施

> Sema Code 的核心洞察只有一句话：
>
> **把 Agent 引擎与所有客户端层彻底解耦，以独立库的形态发布，让"驱动一个 AI 编码 Agent"变得和"连接一个数据库"一样简单。**

这不是一次常规的功能升级，而是一次定位转换——**从"工具"到"基础设施"**。

![插件生态兼容](https://github.com/midea-ai/sema-code-core/releases/download/docs-assets/background.jpeg)

下面从三个维度来看 Sema Code 做了什么。

---

## 一、安全：企业级的三道硬门槛

从个人工具走向企业基础设施，安全是必须翻过的一座山。Sema Code 在三个方向做了系统性设计。

### 1. 权限管理：五类敏感操作，都要用户点头

任何可能影响系统状态或触及外部世界的操作，Sema Code 都会在执行前向用户征求授权，共覆盖五类敏感操作：

- 📝 **修改代码**
- 💻 **执行终端命令**
- 🌐 **发起网络请求**
- 🔗 **调用外部工具**
- 🎯 **加载技能**

每次权限请求，用户可以选择单次放行或永久放行，也可以拒绝，或直接输入反馈让 Agent 按你的意思调整。

"永久放行"支持细粒度的前缀匹配——比如终端命令，既可以只放行 `python main.py` 这一条，也可以放行 `python *` 匹配所有 `python` 开头的命令，粒度由你自己定。其他几类同理，都按项目级缓存，下次不再打扰。

对于信任度高的场景，还可以在配置页一键跳过某一整类权限请求，比如个人项目里把文件编辑完全放行。子代理自动继承主 Agent 的授权，避免同一会话里反复弹窗。

![权限管理](https://github.com/midea-ai/sema-code-core/releases/download/docs-assets/permission.gif)

### 2. 本地模型：多厂商适配，核心留在本地

一个关键的设计原则：**除了调用模型本身，其他一切都在本地完成**。

Sema Code 内置 Anthropic 原生接口和 OpenAI 兼容接口两套适配器，多厂商 LLM 可无缝接入：

- ☁️ **云端模型**：claude-opus-4.6、gpt-5.4、……
- 🇨🇳 **国产 / 开源模型**：glm-5.1、qwen3.6-plus、MiniMax-M2.7、kimi-k2.5、deepseek-reasoner……
- 🏠 **私有化部署模型**：本地 vLLM、SGLang、Ollama、企业内网推理集群……

同一套 Agent 能力在不同模型下统一运行，上层应用无需感知底层差异。对于数据主权敏感的企业场景，这是底层的关键保障。

![模型配置](https://github.com/midea-ai/sema-code-core/releases/download/docs-assets/model-config.png)

### 3. 任务管理：后台任务 + 定时任务，全程可干预

长时任务和周期任务，是 Agent 走向真实生产场景必须解决的问题。Sema Code 提供了两种开箱即用的能力：

- **后台任务**：把耗时工作丢到后台，主对话保持交互性，不用"死等"
- **定时任务**：监控、报表、每日代码巡检……交给定时任务自动跑，Agent 成为 7×24 的数字员工

所有任务都汇总在统一的任务管理界面里，可以随时查看每个任务的实时输出、运行状态，中途介入或直接叫停——Agent 不是"提交了就看不见"的黑盒，而是全程透明、可随时干预的工作伙伴。

![任务管理演示](https://github.com/midea-ai/sema-code-core/releases/download/docs-assets/task-management.gif)

---

## 二、全生态兼容：Plugin / Agent / Skill / MCP / Command 一网打尽

AI 编码的未来是开放生态，而不是单一厂商闭环。Sema Code 提供五类扩展能力：

| 扩展类型 | 作用 | 什么时候用 |
| :--- | :--- | :--- |
| 🔌 **Plugin 插件** | 一键打包分发其他扩展 | 想把 Agent/Skill/MCP/Command 组合成整体分享安装 |
| 🤖 **Agent 子代理** | 委派专项任务,状态隔离 | 独立上下文执行复杂子任务,保持主上下文简洁 |
| 🎯 **Skill 技能** | 注入领域知识,**渐进式加载** | 让模型在特定领域更专业,按需加载不占上下文 |
| 🔗 **MCP 集成** | 接入外部工具和数据 | 要连数据库、API 等外部系统 |
| ⚡ **Command 命令** | 封装可复用的工作流 | 高频多步流程想一键触发 |


可通过 **插件市场** 统一管理——一键浏览、一键安装、一键启用。

![插件生态兼容](https://github.com/midea-ai/sema-code-core/releases/download/docs-assets/ecosystem.gif)

> 💡 **更关键的一点：完全兼容 Claude Code 生态**
>
> 如果你已经在 Claude Code 里配置好了 Plugin / Agent / Skill / MCP / Command——**装好 Sema 后全都能直接用**，零迁移成本。过去在 Claude Code 上积累的所有生态资产，在 Sema 里继续跑。

相比锁定在单一工具生态的其他方案，Sema Code 在 VSCode 插件、CLI、App 等多种形态下共用同一套生态资源——一次配置，处处可用。

---

## 三、可插拔易用：从百行代码到完整产品

Sema Code 最独特的地方在于：它既是一个开发者百行代码就能调用的库，也是多个已在生产落地的成熟产品。

### 1. 百行代码，CLI 秒跑一个 Agent

三步，一分钟，跑起一个完整的 AI 编码 Agent：

```bash
# ① 创建项目并安装依赖
mkdir my-app && cd my-app && npm init -y && npm install sema-core

# ② 取 sema-code-core 仓库示例代码 example/quickstart.mjs 放进来
#   改两处配置：workingDir（目标仓库路径）+ apiKey（你的模型 Key）

# ③ 运行
node quickstart.mjs
```

跑起来后你会得到一个功能完整的 AI 编码 Agent —— 全生态能力、权限管理、多子代理、后台任务、定时任务，引擎层的每一项能力都在线。

![百行代码快速开始](https://github.com/midea-ai/sema-code-core/releases/download/docs-assets/quick-start.gif)

> 示例的 UI 层只做了最简单的文字输出，没有做任何图形化渲染——这正是为了让你看清：百行代码跑起来的是引擎本身，不是玩具 Demo。所有能力都是现成的，你只需要套上自己的 UI 或接入自己的业务系统。非 JS 运行时（Java、Python、Go、C# 等）也能通过 WebSocket / gRPC 接入。

### 2. VSCode 插件：开箱即用的完整体验

这是 Sema Code 当前最成熟的产品形态，下面通过两个典型场景看一下它的实战体验。

#### 🎯 场景一：Plan 模式 —— 先想清楚再动手

面对复杂任务，Agent 会先出完整方案，评审确认后再执行——避免"改到一半才发现方向错了"。

![Plan 模式演示](https://github.com/midea-ai/sema-code-core/releases/download/docs-assets/plan-mode.gif)

#### 🎯 场景二：MCP 集成 —— 打通一切工具生态

通过 MCP 协议无缝接入设计工具、数据库、浏览器、内部 API……Agent 的能力边界由你定义。

![MCP 演示](https://github.com/midea-ai/sema-code-core/releases/download/docs-assets/mcp.gif)

### 3. SemaClaw

SemaClaw 通过 Harness Engineering 向通用个人助理迈出了一步。

![SemaClaw 介绍](https://github.com/midea-ai/sema-code-core/releases/download/docs-assets/semaclaw-intro.gif)

### 4. 更多 Web App

基于 Sema Code，还可以快速构建各种垂直场景的 Web 应用。Code2Skill 就是一个代表——用自然语言创建自定义技能，自动生成代码并一键发布到 Skill 市场。

![SkillCreate 演示](https://github.com/midea-ai/sema-code-core/releases/download/docs-assets/skill-create.gif)

---

## 写在最后

VSCode 插件、SemaClaw 多通道平台、Code2Skill，以及未来更多 Web App——产品形态截然不同，背后是同一份核心引擎。

过去两年 AI 编码的关键词是"能力爆发"：更强的代码生成、更智能的工具调用、更自主的 Agent 循环。下一阶段的关键词，很可能是"可嵌入性"和"开放生态"——当 AI 编码能力不再被锁在特定工具形态里，而是以引擎的形式融入现有工具链；当能力不再由单一厂商独占，而是通过开放的插件市场持续积累和分享，开发者生态才会迎来真正的变革。

Sema Code 不是终点，但它是 AI 编码从"工具"走向"基础设施"的关键一步。

项目地址：https://github.com/midea-ai/sema-code-core

---

