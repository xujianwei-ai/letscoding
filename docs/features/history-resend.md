# history-resend · 历史回滚、换模型重发与撤销

**风险：high**

## 功能

预览受影响文件、确认回滚、保留 Session 身份 rewind 对话，并用所选模型重新发送。

## 入口

- `src/agentController.ts` — `AgentController.resendFromHistory()`, `previewRestore()`, `undoRestore()`
- `src/agent.ts` — `SessionRuntime.resendFromHistory()`, `resolveRewindBoundary()`, `ensureRewindReady()`
- `src/checkpoints.ts` — `CheckpointStore.previewRestore()`, `validateRestore()`, `restoreFrom()`, `undo()`
- `src/extension.ts` — `confirmRestore()`
- `media/webview.js` — `editHistory()`

## 调用链

```
Webview resend
  → 并行启动: previewRestore（后台扫描快照）+ warmupRewind（预热冷 Host）
  → hasCheckpointFor（仅查索引）决定确认框文案 → confirmRestore 立即弹出
  → 确认后 await preview 结果 → 保存脏编辑器
  → resolveRewindBoundary 与 checkpoints.list 并发
  → ensureRewindReady（与 warmup 去重共享同一次 resume）→ rewind Session
  → 漂移时以实时状态重建 RestorePlan 并恢复检查点
  → 重新加载历史 → run(route)
```

## 界面元素

| 选择器 | 处理函数 |
|--------|----------|
| `.history-edit, .history-model, .history-hint` | `editHistory` |
| `.checkpoint-restored` | `undoRestore` |

## 消息

- **Webview → 扩展**: `resend`, `undoRestore`
- **扩展 → Webview**: `status`, `checkpointRestored`, `error`

## 约束

1. 保留 Session ID 与后续检查点存储归属
2. 无检查点仍允许仅回滚对话；有检查点可选择是否恢复代码
3. rewind 边界必须以持久化日志中的 user/message 事件为准；UI 传入 seq 与 Host 内存投影可能错位
4. 确认后文件哈希漂移时以实时状态重建恢复计划继续执行
5. 只备份和写入计划影响的文件；取消不能 rewind 或发送
6. 重发期间按停止时，重发的历史气泡通过 submissions 状态机 `isHistorical` 保护，不被退回输入框或误删

## 测试

`quick-session`, `quick-webview`, `quick-checkpoint`, `integration`
