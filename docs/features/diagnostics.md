# diagnostics · 错误分类、重试状态与日志

**风险：medium**

## 功能

展开 JSON-RPC 错误对象，区分模型/Host/工具/沙箱错误，保留重试和耗时线索。

## 入口

- `src/diagnostics.ts` — `errorText()`, `hostError()`, `toolError()`, `diagnostic()`
- `src/agent.ts` — `SessionRuntime.start()`, `SessionRuntime.onNotification()`
- `src/extension.ts` — `activate()`

## 调用链

```
DSH/Host 异常 → errorText → 分类与建议 → Webview error
Coding Agent 输出通道保留详细事件和耗时
```

## 消息

- **扩展 → Webview**: `error`, `status`

## 约束

1. 不得把对象显示为 [object Object]
2. 网络/模型 TIMEOUT 不误导为 Node 或源码路径错误
3. 日志不得包含凭据、完整代理认证 URL 或私密文件内容

## 测试

`quick-webview`, `integration`
