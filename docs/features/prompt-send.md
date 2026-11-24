# prompt-send · 发送、停止与上下文组装

**风险：high**

## 功能

从编辑器捕获上下文，安全展开 @ 文件，在一次发送边界绑定目标和模型。

## 入口

- `src/extension.ts` — `activate()`
- `src/context.ts` — `captureEditorContext()`, `promptWithEditorContext()`, `promptWithFileReferences()`, `workspaceFiles()`, `openEditorReference()`
- `src/agent.ts` — `SessionRuntime.showUserPrompt()`, `SessionRuntime.run()`
- `media/webview.js` — `busy()`, `updateInputHighlight()`, `fileSearch()`, `chooseFile()`, `registerSubmission()`, `retireSubmissionForElement()`

## 调用链

```
用户发送 → prepareRun 冻结 sessionId → 保存 route → 捕获编辑器上下文/文件引用 → SessionRuntime.run → DSH
```

## 界面元素

| 选择器 | 处理函数 |
|--------|----------|
| `#input, #input-highlight, #file-picker` | `fileSearch` |
| `#context-preview` | `openEditorReference` |

## 消息

- **Webview → 扩展**: `send`, `stop`, `openContext`, `fileList`
- **扩展 → Webview**: `user`, `busy`, `fileList`, `editorContext`

## 约束

1. 只读取显式 @ 的工作区普通文本文件，最多 10 个、每个 64 KiB
2. 选区最多 20000 字符；无选区不发送文件内容
3. 展示的用户问题与注入的上下文分离，历史不得重复回显
4. 停止只作用于指定 Session
5. 停止恢复仅依据 submissions 状态机（pending → accepted/observed/failed）；未被 Host 接纳的 pending 回声退回输入框，已 accepted/observed 的消息（含历史重发）绝不回退

## 提交回声状态机

Webview 的 `submissions: Map<requestId, { status, text, element, isHistorical }>` 替代了旧的 DOM 启发式停止恢复（`pendingUserBubble` + `hasRealOutput` + 兄弟节点猜测）：

- `#send` 时登记 `pending` 本地回声
- 扩展 `user` 回声到达（Host 已接纳）→ `retireSubmissionForElement(..., 'observed')`（按元素 identity，回退按文本匹配）
- 历史重发（`resendStart`）登记为 `isHistorical: true`，停止时绝不回退
- 停止恢复只把 `status === 'pending' 且非历史` 的回声退回输入框；已 accepted/observed 的一律不动

## 关键实现

- `pendingPrompt` — 完整 wire 消息（含 `<editor-context>`、@ 引用、图片）
- `pendingDisplayPrompt` — 用户可见纯文本
- 实时回显必须用 `pendingDisplayPrompt`，绝不用 `pendingPrompt`（否则重发时 context 叠加）

## 测试

`quick-webview`, `integration`
