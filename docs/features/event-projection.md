# event-projection · DSH 事件到界面消息

**风险：high**

## 功能

将 DSH 流、工具、重试、路由与测试事件投影为 UI 消息，区分实时事件和历史回放。

## 入口

- `src/agent.ts` — `SessionRuntime.onNotification()`, `onAssistantEvent()`, `replayHistory()`
- `src/agentController.ts` — `AgentController.output()`, `record()`
- `media/webview.js` — `append()`, `flushStream()`, `busy()`

## 调用链

```
session.event → SessionRuntime.onNotification → AgentController.output → 当前 Session Webview 或后台 liveViews
```

## 消息

- **扩展 → Webview**: `assistantBoundary`, `assistant`, `assistantDelta`, `user`, `messageSeq`, `modelRoute`, `status`

## 约束

1. delta 保留边界，不用最终文本覆盖实时流
2. 历史回放不产生新的测试、工具或检查点副作用
3. 错误对象必须可读；重试期间有可见状态
4. 消息所属 Session 不随前台选择变化
5. **检查点 seq 重绑**：比较必须剥离 `<editor-context>` 与 @ 引用后缀，使用 `displayPromptText()`
6. **实时用户回显**：必须用 `pendingDisplayPrompt` 纯文本，绝不用 `pendingPrompt` 线文本

## 关键函数

```typescript
// agent.ts
function displayPromptText(text: string): string {
  const editorSeparator = text.indexOf('\n\n<editor-context>')
  const referenceSeparator = text.indexOf('\n\n以下是用户通过 @ 明确引用的文件：')
  const boundaries = [editorSeparator, referenceSeparator].filter(index => index >= 0)
  const separator = boundaries.length === 0 ? -1 : Math.min(...boundaries)
  return separator < 0 ? text : text.slice(0, separator)
}
```

## 测试

`quick-session`, `quick-webview`, `integration`
