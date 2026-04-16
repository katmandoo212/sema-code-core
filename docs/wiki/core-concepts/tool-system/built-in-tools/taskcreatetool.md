# 任务创建工具 TaskCreate

创建结构化任务，用于跟踪当前会话中的工作进度。帮助 AI 组织复杂任务，并让用户了解整体进展。

## 参数

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `subject` | `string` | ✓ | 任务标题（简短祈使句，如 "修复登录认证 bug"） |
| `description` | `string` | ✓ | 任务详细描述（包含上下文和验收标准） |
| `activeForm` | `string` | — | 进行中状态时 spinner 显示的文本（如 "正在修复认证 bug"），省略时显示 subject |
| `metadata` | `object` | — | 附加到任务的任意元数据 |

## 基本属性

- **isReadOnly**：`false`
- **canRunConcurrently**：`true`（多个任务创建可并发）
- **权限**：无需权限


## 使用场景

适合使用：
- 复杂多步骤任务（3 步以上）
- Plan 模式下跟踪工作进度
- 用户明确要求创建任务列表
- 用户一次提出多项需求

不建议使用：
- 单一简单任务
- 可在 3 步内完成的琐碎任务
- 纯对话或信息查询


## 返回结构

```javascript
{
  task: {
    id: string      // 任务 ID
    subject: string // 任务标题
  }
}
```

创建的任务初始状态为 `pending`，后续使用 [TaskUpdate](wiki/core-concepts/tool-system/built-in-tools/taskupdatetool) 更新状态和建立依赖关系。


## 使用示例

```
# 创建一个任务
TaskCreate(
  subject="修复用户认证模块",
  description="LoginService 中 token 校验逻辑有误，需要修复过期判断条件",
  activeForm="修复认证模块中"
)
→ 返回 Task #1 created successfully

# 创建多个任务（可并发）
TaskCreate(subject="添加单元测试", description="为 AuthService 添加边界条件测试用例")
TaskCreate(subject="更新 API 文档", description="补充新增的认证相关端点文档")
```
