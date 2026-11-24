# extension-shell · 扩展激活与 Webview 容器

**风险：medium**

## 功能

注册侧栏、命令、输出通道、设置和 Webview；controller 在视图销毁后继续存在。

## 入口

- `src/extension.ts` — `activate()`, `html()`, `currentModelRoute()`
- `package.json` — `main`, `contributes`, `capabilities`

## 调用链

```
VS Code activate → AgentController → registerWebviewViewProvider → html → media/webview.js
```

## 界面元素

| 选择器 | 处理函数 |
|--------|----------|
| `#topbar, #session-picker` | `renderSessions` |
| `#conversation, #log, #status` | `append` |
| `#workspace-trust` | `applyTrustState` |
| `#input, #input-highlight` | `updateInputHighlight` |

## 消息

- **Webview → 扩展**: `ready`, `manageTrust`, `openLocation`
- **扩展 → Webview**: `conflict`, `workspaceTrust`

## 约束

1. CSP 只允许受控脚本/样式/图片
2. 未受信任工作区只注册界面，不启动 DSH
3. 视图销毁 ≠ 停止 Agent

## 测试

`quick-session`, `quick-webview`, `vsix`, `integration`
