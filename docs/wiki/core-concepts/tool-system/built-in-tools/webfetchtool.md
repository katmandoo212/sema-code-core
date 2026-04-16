# 网页抓取工具 WebFetch

从指定 URL 抓取网页内容，转换为 Markdown 后通过小模型处理并返回结果。

## 参数

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `url` | `string` | ✓ | 要抓取的 URL（必须为完整合法 URL） |
| `prompt` | `string` | ✓ | 对抓取内容的处理指令（描述要提取的信息） |

## 基本属性

- **isReadOnly**：`false`（串行执行）
- **权限**：调用时展示 URL，由用户确认


## 行为细节

- HTTP URL 会自动升级为 HTTPS
- HTML 内容会先转换为 Markdown，再由小模型根据 prompt 处理
- 小型 Markdown 内容（低于阈值）直接返回，无需 LLM 处理
- 内置 15 分钟自清理缓存，重复访问同一 URL 时加速响应
- 输出过大时会被摘要压缩

### 跨域重定向

当 URL 重定向到不同域时，工具不会自动跟随，而是返回重定向信息（原始 URL、目标 URL、状态码），提示 LLM 使用新 URL 重新发起 WebFetch 请求。

### 认证限制

WebFetch **无法访问需要认证的 URL**（如 Google Docs、Confluence、Jira、GitHub 私有内容）。对于此类场景，应优先使用对应的 MCP 工具。GitHub URL 建议使用 `gh` CLI 通过 Bash 工具访问。


## 返回结构

```javascript
{
  bytes: number       // 原始内容字节数
  code: number        // HTTP 状态码
  codeText: string    // 状态码文本
  result: string      // 处理后的结果文本
  durationMs: number  // 请求耗时（毫秒）
  url: string         // 请求的 URL
}
```


## 使用示例

```
# 提取页面主要内容
WebFetch(url="https://example.com/docs/api", prompt="提取 API 端点列表及其参数说明")

# 获取文档摘要
WebFetch(url="https://example.com/changelog", prompt="总结最近的变更内容")
```
