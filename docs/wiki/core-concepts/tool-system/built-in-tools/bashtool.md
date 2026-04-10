# 终端工具 Bash

在持久化 Shell 进程中执行命令，工作目录状态跨调用保持。

## 参数

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `command` | `string` | ✓ | 要执行的 Shell 命令 |
| `description` | `string` | — | 命令描述（5-10 字，主动语态）|
| `timeout` | `number` | — | 超时毫秒数，最大 600000ms（10 分钟），默认 120000ms（2 分钟）|
| `run_in_background` | `boolean` | — | 设为 `true` 时直接 spawn 独立后台进程，主对话立即返回 task id |

> 当核心配置 `disableBackgroundTasks: true` 时，`run_in_background` 字段会被 `buildTools` 从 schema 中剔除，LLM 看不到该参数。

## 基本属性

- **isReadOnly**：`false`（串行执行）
- **supportsInterrupt**：`true`（中断时保留已捕获的 stdout/stderr）
- **权限**：默认需要确认（`skipBashExecPermission` 控制）


## 安全限制

### 禁止命令

以下命令被完全禁止，调用会直接返回错误（不走权限流程）：

```
alias, curl, curlie, wget, axel, aria2c,
nc, telnet, lynx, w3m, links,
httpie, xh, http-prompt,
chrome, firefox, safari
```

### cd 目录限制

`cd` 命令只能进入**工作目录的子目录**，不能跨出项目根目录：

```bash
cd src/utils    # ✓ 允许
cd ..           # ✗ 跨出工作目录，被阻止
cd /tmp         # ✗ 绝对路径跨出，被阻止
```


## 权限粒度

Bash 权限按**命令前缀**存储，授权 `npm run` 后，所有以 `npm run` 开头的命令自动通过：

```
授权: Bash(npm run:*)
允许: npm run test、npm run build、npm run lint
不允许: npm install（前缀不同）
```


## 持久化 Shell

所有 Bash 调用共享同一个持久化 Shell 进程，`cd` 和环境变量变更在调用间保持：

```bash
# 第一次调用
cd src/

# 第二次调用（在 src/ 目录中执行）
ls -la
```


## 输出格式

工具返回：

```javascript
{
  stdout: string       // 标准输出
  stdoutLines: number  // 输出行数
  stderr: string       // 标准错误
  stderrLines: number  // 错误行数
  interrupted: boolean // 是否被中断
  command?: string     // 执行的命令
}
```

输出超过阈值时自动截断：保留头尾若干行，中间省略部分显示被截断的行数。在工具结果面板中，最多渲染最后 10 行内容。

主代理同步执行时，stdout/stderr 还会以 `tool:execution:chunk` 事件流式增量推送，便于 UI 实时显示。


## 后台执行

Bash 工具有两条进入后台任务的路径：

| 路径 | 触发 | 行为 |
|------|------|------|
| 主动后台 | LLM 传 `run_in_background: true` | 直接 spawn 独立子进程，立即返回 `taskId` 与输出文件路径 |
| 超时接管 | 同步执行 `timeout` 到时仍未完成 | 自动接管底层 shell 为后台任务，向 LLM 返回接管说明 |

约束：

- 仅主代理（`agentId === MAIN_AGENT_ID`）允许后台任务，子代理强制前台
- `disableBackgroundTasks: true` 时：`run_in_background` 被剔除、超时直接 kill 而不接管
- `MAX_RUNNING_TASKS = 5` 限流：超出时启动 / 接管会失败

后台任务通过 [TaskOutput](wiki/core-concepts/tool-system/built-in-tools/taskoutputtool) 获取输出、[TaskStop](wiki/core-concepts/tool-system/built-in-tools/taskstoptool) 停止。详细行为见 [Bash 后台任务](wiki/core-concepts/task-management/bash-task)。


## 中断行为

Bash 实现了 `supportsInterrupt() === true`：用户中断正在执行的命令时，已捕获的 stdout/stderr 会与 `INTERRUPT_MESSAGE_FOR_TOOL_USE` 标记一起返回 LLM，而不是被替换为标准取消消息。这让 LLM 能基于已有输出继续推理。


## 使用示例

```bash
# 查看 git 状态
git status

# 运行测试（需要权限，首次确认）
npm run test

# 链式命令
git add . && git commit -m "feat: add new feature"

# 管道命令
cat package.json | jq '.dependencies'

# 后台跑长任务
npm run build:all   # run_in_background: true
```
