# host-launch · 普通 Node Host 与模型网络

**风险：high**

## 功能

默认从 Electron 通过 SDK nodePath 启动随包 Node 24.9.0 和编译 DSH；复用 DSH_HOME/~/.dsh，显式源码模式与代理、模型声明、Host 重建相互隔离。

## 入口

- `src/runtime.ts` — `harnessLaunchOptions()`, `createHarness()`, `defaultDshHome()`, `hostNetworkEnvironment()`, `ordinaryNode()`
- `src/agent.ts` — `SessionRuntime.options`, `SessionRuntime.start`
- `package.json` — `privateCodingAgent.runtimeMode`, `networkMode`, `proxyUrl`, `dshRepository`, `dshHome`

## 调用链

```
VS Code settings → DSH_AGENT_HOME / 显式 dshHome / 开发 Home / DSH_HOME / ~/.dsh
  → harnessLaunchOptions → bundled Node/DSH 或显式已构建 source
  → SDK nodePath + dsh profile sdk + patches → stdio JSON-RPC
```

## 设置

| 设置 | 说明 |
|------|------|
| `privateCodingAgent.runtimeMode` | `bundled` / `source` |
| `privateCodingAgent.networkMode` | `direct` / `system` / `proxy` |
| `privateCodingAgent.proxyUrl` | HTTP(S) 代理 |
| `privateCodingAgent.dshRepository` | 显式 DSH 源码路径 |
| `privateCodingAgent.dshHome` | 显式 DSH Home |

## 约束

1. direct 默认覆盖继承和 .env 代理变量
2. 测试通过 DSH_AGENT_HOME 强制隔离数据目录
3. 不记录代理认证信息或 API Key
4. 模型切换只改变下一次 route，不重启 Host
5. 发布默认 bundled；组件缺失明确失败，绝不回退 source/tsx/Electron

## 测试

`quick-session`, `runtime-launch`, `node-probe`, `electron-probe`, `integration`, `sdk-probe`, `runtime-baseline`
