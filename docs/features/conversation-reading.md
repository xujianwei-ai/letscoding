# conversation-reading · 流式跟随、吸顶问题与历史编辑

**风险：medium**

## 功能

流式输出时跟随底部，阅读历史时暂停跟随；吸顶展示当前问题，可展开或在原位编辑重发。

## 入口

- `media/webview.js` — `scrollToLatest()`, `flushStream()`, `updateStickyPrompt()`, `scheduleStickyPrompt()`, `editHistory()`, `bindHistory()`, `updateHistoryBinding()`
- `src/extension.ts` — `html()`

## 调用链

```
scroll 事件决定 followOutput → 50ms 批量追加稳定文本节点
  → 正文阶段结束或轮次完成后统一渲染 Markdown → requestAnimationFrame 更新吸顶
  → 点击卡片/右上角图标分别编辑/展开
```

## 界面元素

| 选择器 | 处理函数 |
|--------|----------|
| `#sticky-prompt, .prompt-toggle` | `updateStickyPrompt` |
| `.user, .history-toggle, .history-edit, .history-send` | `editHistory` |
| `.assistant` | `flushStream` |

## 消息

- **Webview → 扩展**: `resend`
- **扩展 → Webview**: `assistant`, `assistantDelta`, `user`, `messageSeq`, `messageCheckpoint`, `busy`, `cleared`

## 约束

1. 阅读历史时不强制下拉；回到底部恢复跟随
2. 流式正文按块增量渲染：已闭合代码块或空行分隔的前缀立即渲染为稳定 DOM，仅未闭合尾部追加文本节点；已渲染块绝不重建
3. 吸顶编辑不修改原历史卡片、不滚动原文
4. 正文点击进入编辑，右上角图标控制展开，二者不得混用
5. 运行中禁止编辑另一轮；迟到的 seq/checkpoint 必须更新已存在卡片
6. 历史重发的气泡通过 submissions 状态机标记 `isHistorical: true`，停止时绝不回退或误删（替代旧的 `.history-toggle` DOM 猜测）

## 测试

`quick-webview`, `integration`
