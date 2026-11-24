# session-lifecycle · 多 Session 生命周期与选择

**风险：high**

## 功能

创建、切换、后台运行、停止和恢复独立 Session；保存当前工作区选择。

## 入口

- `src/agentController.ts` — `AgentController.prepareRun()`, `run()`, `selectSession()`, `stop()`, `resume()`
- `src/agent.ts` — `SessionRuntime.start()`, `stop()`, `closeHost()`

## 调用链

```
Webview 选择/发送 → AgentController 定位 runtime → SessionRuntime Host → DSH resume/run → 按 sessionId 投影当前视图
```

## 消息

- **Webview → 扩展**: `sessionSelect`, `new`, `stop`, `resume`
- **扩展 → Webview**: `busy`, `sessionSelected`, `cleared`

## 状态

- `workspaceState.currentSession:<workspace>` — 持久化选择
- `liveViews` — 内存事件投影
- `runtimes` — 每 Session 一个写 Host
- `turnSerial` — 单调递增，防止迟到回调覆盖

## 约束

1. 选择状态和 runtime.id 不得分离
2. 后台 Session 不重置当前 busy/视图/选择
3. 不能同时持有同一 Session 的活跃写锁
4. 关闭 Webview 不结束后台任务
5. stop() 通过 session/cancel RPC 优雅中断活跃 turn，Host 进程保持热备、部分输出以 interrupted 落盘；仅当 Host 已冷或 cancel RPC 失败时才 teardown 并同步释放 busy、递增 turnSerial

## 优雅停止（session/cancel）

`SessionRuntime.stop()` 通过 SDK 的 `session/cancel` RPC 调用 DSH 内核的 `agent.cancel({ kind:'user' }, { keepInbox:true })`：

- 活跃 turn 的 `AbortController` 中止，已流出的部分回复落盘为 `assistant/message`（`interrupted: true`）
- turn 以 `turn/end reason=aborted` 干净结束，Host 进程保持热备
- **不再**杀 Host 进程，也**不再** rewind 用户消息——被取消的用户 prompt 合法保留在持久化 log

回退路径：当 Host 已冷（启动竞态）或 `session/cancel` RPC 失败（旧 runtime）时，才 teardown Host 并同步释放 busy；Webview 的提交回声状态机负责把未被 Host 接纳的 prompt 退回输入框。

DSH 侧实现：`packages/sdk/server/src/server.ts` 的 `cancel()` 方法 + `session/cancel` dispatch；`packages/sdk/client` 的 `cancelSession()`。协议类型在 `packages/sdk/protocol/src/types.ts`（`SessionCancelParams` / `SessionCancelResult`）。

## 测试

`quick-session`, `integration`, `cancel-integration-suite.cjs`（真实 VS Code 端到端：停止延迟、Host 保活、用户消息保留）
