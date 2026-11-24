# test-infrastructure · 分层测试与开发探针

**风险：medium**

## 功能

以快速 DOM/数据测试、真实 Electron 集成、真实项目 E2E 和最小探针分层验证功能。

## 入口

- `scripts/vscode-integration.cjs` — `main()`
- `scripts/runtime-baseline.cjs` — `createBaseline()`, `validateLock()`, `main()`
- `scripts/prepare-node.cjs` — `prepareNode()`, `verifiedDownload()`
- `scripts/runtime-closure.cjs` — `createClosure()`, `collectClosure()`, `inspectNative()`, `stagedInventory()`
- `scripts/runtime-stage.cjs` — `stage()`
- `scripts/vsix-package.cjs` — `packageVsix()`, `assertLicenses()`
- `scripts/webview-suite.cjs` — `run()`
- `scripts/session-runtime-suite.cjs` — `run()`
- `scripts/checkpoint-suite.cjs` — `run()`
- `scripts/cancel-integration-suite.cjs` — `run()`（优雅停止真实 VS Code 端到端）
- `scripts/cancel-probe.ts` — 最小优雅停止探针（真实模型，不经 VS Code）
- `package.json` — `scripts`

## 调用链

```
npm run compile → 快速套件；VSCODE_AGENT_SUITE 选择集成脚本 → 隔离 DSH home/工作区 → 真实模型（仅标记测试）
```

## 测试级别

| 级别 | 命令 | 说明 |
|------|------|------|
| quick | `node scripts/webview-suite.cjs` | DOM/数据，无模型/VS Code |
| integration | `node scripts/vscode-integration.cjs vscode-suite.cjs` | 真实 Electron/DSH |
| cancel-integration | `VSCODE_AGENT_SUITE=cancel-integration-suite.cjs node scripts/vscode-integration.cjs` | 优雅停止端到端（停止延迟、Host 保活、用户消息保留） |
| e2e | `node scripts/vscode-integration.cjs workbench-e2e-suite.cjs` | 真实模型/终端 |
| probe | `node --import tsx/esm scripts/sdk-probe.ts` | 最小 SDK 连接 |
| cancel-probe | `node --import tsx/esm scripts/cancel-probe.ts` 或 `npm run test:cancel` | 最小优雅停止（真实模型，不经 VS Code） |

## 约束

1. 快速测试不依赖模型或真实 VS Code
2. 真实测试明确写出模型/文件/网络副作用
3. 测试失败先读实际错误，不能用跳过或更宽断言掩盖

## 测试

`index`, `runtime-baseline`, `runtime-native`
