# 管理模型

## 国内支持的服务提供商

| 提供商 | 模型 | baseURL | SDK 类型 |
|--------|----------|----------|----------|
| openrouter | claude-opus-4.6 | https://openrouter.ai/api | anthropic |
| qwen | qwen3.6-plus | https://dashscope.aliyuncs.com/compatible-mode/v1 | anthropic |
| glm | glm-5.1 | https://open.bigmodel.cn/api/paas/v4 | openai |
| minimax | MiniMax-M2.7 | https://api.minimaxi.com/anthropic | anthropic |
| kimi | kimi-k2.5 | https://api.moonshot.cn/v1 | openai |
| deepseek | deepseek-reasoner | https://api.deepseek.com/anthropic | anthropic |

<figure align="center">
  <img src="https://github.com/midea-ai/sema-code-core/releases/download/docs-assets/model-config.png" alt="model-list">
  <figcaption>Sema Code vscode插件页面截图</figcaption>
</figure>

## ModelConfig 接口

```javascript
interface ModelConfig {
  provider: string      // 提供商
  modelName: string     // 提供商侧的模型 ID
  baseURL: string       // 自定义 API 地址
  apiKey: string        // API Key
  maxTokens: number     // 单次响应最大 token 数
  contextLength: number // 上下文窗口大小
  adapt?: 'anthropic' | 'openai'  // SDK 适配类型，自动检测
}
```

> 模型在内部以 `${modelName}[${provider}]` 作为唯一标识，例如 `deepseek-reasoner[deepseek]`。无需手动传入 `name` 字段。

## 添加模型

```javascript
await sema.addModel({
  provider: 'deepseek',
  modelName: 'deepseek-reasoner',
  baseURL: 'https://api.deepseek.com/anthropic',
  apiKey: 'sk-',
  maxTokens: 8192,
  contextLength: 128000,
})
```
`adapt` 字段控制使用哪种 SDK 格式与提供商通信，SemaCore会自动检测，检测逻辑在 `src/util/adapter.ts`。

## 管理模型

### 切换当前使用的模型

```javascript
await sema.switchModel('MiniMax-M2.5[minimax]')
```

### 删除模型

```javascript
await sema.delModel('deepseek-reasoner[deepseek]')
```

### 配置任务模型（主模型 + 快速模型）

系统支持两个模型指针：`main`（主要任务）和 `quick`（快速任务，如 bash前缀提取、话题检测、Explore子代理）：

```javascript
await sema.applyTaskModel({
  main: 'anthropic/claude-sonnet-4.5[openrouter]',   // 主任务使用
  quick: 'anthropic/claude-haiku-4.5[openrouter]',   // 快速任务使用
})
```

### 获取模型数据

```javascript
const { modelName, modelList, taskConfig } = await sema.getModelData()
console.log('当前主模型:', modelName)            // 同 taskConfig.main
console.log('已配置模型列表:', modelList)         // string[]
console.log('主模型 / 快速模型:', taskConfig)     // { main, quick }
```

`ModelUpdateData` 接口：

```typescript
interface ModelUpdateData {
  modelName: string                       // 主模型名称
  modelList: string[]                     // 全部已配置的模型名称
  taskConfig: { main: string; quick: string }
}
```

## 持久化

模型配置自动持久化到 `~/.sema/model.conf`：

```json
{
  "modelProfiles": [
    {
      "name": "anthropic/claude-sonnet-4.5[openrouter]",
      "provider": "openrouter",
      "modelName": "anthropic/claude-sonnet-4.5",
      "baseURL": "https://openrouter.ai/api",
      "apiKey": "sk-or-v1-",
      "maxTokens": 8192,
      "contextLength": 128000,
      "adapt": "anthropic"
    },
    {
      "name": "anthropic/claude-haiku-4.5[openrouter]",
      "provider": "openrouter",
      "modelName": "anthropic/claude-haiku-4.5",
      "baseURL": "https://openrouter.ai/api",
      "apiKey": "sk-or-v1-",
      "maxTokens": 8192,
      "contextLength": 128000,
      "adapt": "anthropic"
    }
  ],
  "modelPointers": {
    "main": "anthropic/claude-sonnet-4.5[openrouter]",
    "quick": "anthropic/claude-haiku-4.5[openrouter]"
  }
}
```

下次创建 `SemaCore` 实例时，已保存的模型无需重新添加。

## 其他API

### 验证 API 连接

添加模型前可先测试连通性：

```javascript
const result = await sema.testApiConnection({
  provider: 'kimi',
  baseURL: 'https://api.moonshot.cn/v1',
  apiKey: '',
  modelName: 'kimi-k2.5',
})

if (result.success) {
  console.log('连接成功')
} else { 
  console.error('连接失败:', `${result.message}\n调试命令: ${result.curlCommand}`);
}
```

### 获取可用模型列表

```javascript
const result = await sema.fetchAvailableModels({
  provider: 'kimi',
  baseURL: 'https://api.moonshot.cn/v1',
  apiKey: '',
})

if (result.success && result.models) {
  console.log('获取模型成功，共', result.models.length, '个模型')
  const modelIds = result.models.map(model => model.id)
  console.log('模型 ID 列表:', modelIds)
} else {
  console.error('获取模型失败:', `${result.message}\n调试命令: ${result.curlCommand}`);
}
```
