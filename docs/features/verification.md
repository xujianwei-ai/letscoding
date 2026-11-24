# verification · 测试证据、失败定位与托管重跑

**风险：high**

## 功能

从真实 Bash 输出识别测试结果，定位失败源码，仅对覆盖原失败的精确重跑标记恢复。

## 入口

- `src/verification.ts` — `VerificationTracker.record()`, `report()`, `rerunCommand()`
- `src/diagnostics.ts` — `testSummary()`, `testFailures()`, `testRerunCommand()`
- `src/agent.ts` — `SessionRuntime.publishVerification()`, `rerunVerification()`
- `media/webview.js` — `showTestResult()`, `showVerificationReport()`

## 调用链

```
tool/result bash → testSummary → VerificationTracker → 测试卡片/报告
  → VS Code 终端执行目标命令 → 更新原失败状态
```

## 界面元素

| 选择器 | 处理函数 |
|--------|----------|
| `.test-result, #verification-report, .rerun-tests` | `showVerificationReport` |

## 消息

- **Webview → 扩展**: `rerunTests`, `openLocation`
- **扩展 → Webview**: `testResult`, `verificationReport`

## 约束

1. 模型文字声称通过不算证据；失败退出码优先于 OK 文本
2. 不相关测试通过不能清除已有失败
3. 重跑位置限制在当前工作区，终端完成事件必须按 execution 关联

## 测试

`quick-webview`, `quick-checkpoint`, `integration`, `workbench-e2e`, `real-project`
