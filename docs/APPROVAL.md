# 工具与审批模块开发文档

> **功能索引**：`approval`（工具与安全域）、`structured-questions`（工具与安全域）
> **核心文件**：`src/approval.ts`（70 行）、`src/questions.ts`（57 行）

## 1. 模块职责

管理 Agent 的工具使用权限：
- 三种权限模式（只读/工作区写入/完全访问）
- 单次工具审批（非只读模式下的敏感操作）
- DSH 结构化提问（选项、多选、自定义文本）

## 2. 权限模式

### 2.1 三种模式

| 模式 | 标识 | 说明 |
|------|------|------|
| 只读 | `read-only` | 只允许读取文件，禁止 edit/write/Bash |
| 工作区写入 | `workspace-write` | 允许工作区内文件修改，Bash 需审批 |
| 完全访问 | `danger-full-access` | 允许所有操作，包括工作区外和 Bash |

### 2.2 模式切换

```typescript
// webview.js: 用户选择权限模式
vscode.postMessage({ type: 'permissionMode', mode })

// extension.ts: 验证并保存
controller.setPermissionMode(mode)

// agent.ts: 应用到 DSH Session
await session.query(`/permission ${mode}`)  // DSH 原生命令
```

**关键约束**：
- 运行中不能修改权限（`busy` 时拒绝）
- `danger-full-access` 需要显式风险确认对话框
- 权限 preset 持久化在 DSH 会话日志中
- rewind 后必须重新应用（rewind 会截断日志，丢失 permission/preset 事件）

### 2.3 单次审批

非只读模式下，敏感工具（Bash、工作区外写入）触发审批：

```
DSH Host → approval/request 事件
    ↓
agent.ts: askApproval(tool, reason)
    ↓
webview.js: 显示审批卡片（工具名、原因、允许/拒绝按钮）
    ↓
用户点击 → approvalResponse 消息
    ↓
agent.ts: resolve({ outcome: 'allowed-once' | 'rejected' })
    ↓
DSH Host 继续或中止
```

**关键约束**：
- 一次许可只作用于当前工具调用，不扩展到整个会话
- 拒绝后 DSH 会报错，Agent 可能重试或换方案

## 3. 结构化提问（`QuestionBroker`）

DSH 模型在对话中提出结构化问题（选项、多选、自定义文本）：

```typescript
interface Question {
  id: string
  question: string
  options?: QuestionOption[]   // 选项列表
  multiSelect?: boolean        // 是否多选
  custom?: boolean             // 允许自定义文本
}

class QuestionBroker {
  ask(questions: Question[]): Promise<QuestionResult>  // 等待用户回答
  answer(requestId: string, answers: QuestionAnswer[]): void
  cancel(): void  // Host 关闭时调用
}
```

流程：
```
DSH onUserQuestion 回调
    ↓
QuestionBroker.ask() → postMessage({ type: 'questions', questions })
    ↓
webview.js: 渲染问题卡片（单选/多选/文本输入）
    ↓
用户提交 → postMessage({ type: 'answerQuestions', requestId, answers })
    ↓
QuestionBroker.answer() → resolve Promise
    ↓
DSH 继续执行
```

**关键约束**：
- `requestId` 必须匹配当前 pending 问题
- 答案数量、选项和多选约束需再次校验
- Host 关闭必须 resolve cancelled，不留悬空 Promise

## 4. 不可破坏的约束

1. **运行中不能修改权限**：避免权限在工具执行中间变化
2. **权限 preset 持久化在会话日志中**：resume/rewind 后必须通过 `/permission` 命令重新对齐
3. **不把一次许可扩展成整个会话许可**：每次敏感操作单独审批
4. **不允许通过 Bash 绕过只读审批**：只读模式下 Bash 被 DSH 沙箱阻止
5. **异步设置刷新不应当误判为拒绝**：等待 DSH 确认权限已应用

## 5. 与其他模块的关系

```
approval.ts
    ├── 被 agent.ts 调用（askApproval、applyPermissionToSession）
    ├── 被 agentController.ts 调用（setPermissionMode）
    └── 被 extension.ts 调用（confirmFullAccess）

questions.ts
    ├── 被 agent.ts 调用（answerQuestions）
    └── 被 webview.js 调用（渲染问题卡片）
```

## 6. 调试技巧

- **审批日志**：`[Coding Agent] Approval requested: ...`
- **权限命令**：DSH 会话日志中的 `permission/preset` 事件
- **问题流程**：`[Coding Agent] Question asked: ...` / `Question answered: ...`
