# edit-conflicts · 外部修改与未保存编辑器冲突

**风险：medium**

## 功能

在轮次开始记录文件时间戳，edit/write 前检查外部修改和脏编辑器，只警告不自动覆盖。

## 入口

- `src/conflicts.ts` — `EditConflictMonitor.snapshot()`, `watch()`, `onEditConflict()`
- `src/agent.ts` — `SessionRuntime.onNotification()`
- `src/extension.ts` — `activate()`
- `media/webview.js` — `append()`

## 调用链

```
turn snapshot → tool/call watch → 时间戳/脏文档检查 → VS Code warning + Webview conflict
```

## 消息

- **扩展 → Webview**: `conflict`

## 约束

1. 警告不是恢复或许可；不得自动保存或覆盖任一版本
2. 重新打开同一文档并保存不应当作外部修改
3. 检查器异常要明确提示，不静默声称安全
4. 当前 conflict 无 sessionId；Webview 只记录控制台，VS Code 警告拥有实际展示

## 测试

`quick-webview`, `integration`
