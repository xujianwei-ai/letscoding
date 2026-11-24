<!-- GENERATED FROM docs/feature-catalog.json. Edit the JSON, then run npm run index:generate. -->

# 工程功能索引

> 本文档由 `docs/feature-catalog.json` 生成。功能增删或结构调整时修改数据源，运行 `npm run index:generate`；提交前运行 `npm run index:check`。不要手工编辑本文件。

## 1. 快速使用

**开发工具自动发现**：工作区根目录 `AGENTS.md` 和 `.cursor/rules/feature-index.mdc` 会把 Coding 工具引导到本文档。开发时先按本文档定位功能；新增/删除功能时再读 [维护指南](FEATURE_INDEX_MAINTENANCE.md)；修改 DSH 时同时遵守其 `AGENTS.md`。

- **按需求定位**：在下一节搜索用户可见功能，进入功能 ID，查看入口、调用链、约束与回归命令。
- **按文件定位**：搜索 `src/...` 或 `media/webview.js`，找到拥有它的功能；先看“不可破坏的约束”再修改。
- **按界面定位**：搜索 `#sticky-prompt`、`.history-edit`、`#model` 等选择器；各功能登记对应 DOM 与处理函数。
- **目录导航**：§3 总目录 → §4 功能详情 → §5 协议 → §6 DSH → §7 测试 → §8 已知覆盖缺口。
- **当前阶段**：独立运行时与一键安装优先，暂缓新增业务功能。Node、DSH、VSIX 或干净环境安装任务先读 [阶段开发计划](RUNTIME_DELIVERY_PLAN.md)，再阅读关联功能约束。
- **新增功能**：先阅读 [维护指南](FEATURE_INDEX_MAINTENANCE.md)，稳定分配功能 ID，再写实现、协议、测试和索引。
- **删除功能**：不能只删按钮；按依赖反向检查消息、Host 生命周期、持久化、测试与外部接口。
- **排查问题**：模型与 Host 从 `host-launch` / `diagnostics` 开始；会话错乱从 `session-lifecycle` 开始；回滚和 Diff 从 `checkpoints` / `diff-review` 开始。

### 修改范围速查

| 需求 | 首先阅读 | 常见联动 | 最低验证 |
| --- | --- | --- | --- |
| 独立安装/Node/DSH 打包 | [阶段开发计划](RUNTIME_DELIVERY_PLAN.md)、[host-launch](#host-launch) | 运行时物料、启动模式、原生组件与 VSIX 隔离验收 | `npm run test:quick`；最终必须执行真实 VSIX 安装验收 |
| 发送/切换模型无响应 | [host-launch](#host-launch)、[model-routing](#model-routing)、[diagnostics](#diagnostics) | 实际 route、普通 Node、代理与重试 | `npm run test:quick`；真实连接用 `npm run test:sdk` |
| 历史选择/后台任务错乱 | [session-lifecycle](#session-lifecycle) | 目标 sessionId、读写 Host、视图投影 | `node scripts/session-runtime-suite.cjs` + `npm run test:vscode` |
| 吸顶/滚动/编辑交互 | [conversation-reading](#conversation-reading) | Webview DOM/CSS、`resend` 消息、迟到 seq | `node scripts/webview-suite.cjs` |
| 历史重发/撤销 | [history-resend](#history-resend)、[checkpoints](#checkpoints) | rewind、手工修改、文件范围、模型路由 | `npm run test:quick` + `npm run test:vscode` |
| 工具与测试报告 | [verification](#verification)、[event-projection](#event-projection) | 真实 Bash 输出、退出码、终端事件 | `node scripts/webview-suite.cjs` + `npm run test:workbench-e2e` |
| 权限与网络安全 | [approval](#approval)、[host-launch](#host-launch) | Host 重建、凭据、沙箱、单次审批 | `npm run test:approval` |


## 2. 系统边界与状态归属

```text
media/webview.js  交互与临时视图状态
       │ postMessage（本目录 §5）
src/extension.ts  消息校验、HTML、设置、VS Code 集成
       │ AgentController：按 sessionId 路由与选择
src/agent.ts      每个 Session 的写 Host、事件、检查点和 Diff
       │ src/runtime.ts：普通 Node / 网络环境 / stdio JSON-RPC
./deepseek-harness  模型、工具、会话持久化
```

| 层 | 拥有者 | 职责 | 边界 |
| --- | --- | --- | --- |
| `webview` | `media/webview.js + src/extension.ts:html` | 展示、编辑、用户交互与临时 UI 状态；不直接读写工作区或 DSH。 | 仅通过 postMessage 与扩展通信；刷新会丢失未持久化的视图状态。 |
| `controller` | `src/extension.ts + src/agentController.ts` | 验证 Webview 消息、选择目标 Session、协调读写 Host、保存工作区选择。 | Webview 关闭不销毁运行中的任务；后台 Session 的事件不能直接覆盖当前视图。 |
| `session-runtime` | `src/agent.ts + src/checkpoints.ts + src/inlineDiff.ts` | 一个持久 Session 的写 Host、轮次事件、工具、文件快照和编辑器效果。 | 一个活跃写 Host 只能属于一个 Session；跨 Session 操作必须携带目标 sessionId。 |
| `dsh` | `src/runtime.ts + ./deepseek-harness` | 普通 Node 进程、SDK JSON-RPC、模型与工具、持久化会话。 | 扩展不拥有模型或工具实现；外部接口和本地补丁见 integrations，不把密钥放入扩展配置。 |


**权威数据**：DSH 的 Session 日志是历史事实来源；`AgentController.liveViews` 是内存投影；`CheckpointStore` 是扩展自己的文件恢复事实来源；Webview 不是这些数据的权威存储。

## 3. 功能总目录

| 功能 ID | 领域 / 功能 | 风险 | 主要入口 | 测试 |
| --- | --- | --- | --- | --- |
| [extension-shell](#extension-shell) | 接入与视图 / 扩展激活与 Webview 容器 | medium | [`src/extension.ts`](../src/extension.ts)<br>`activate`<br>`html`<br>`currentModelRoute` | `quick-session`<br>`quick-webview`<br>`vsix`<br>`integration` |
| [session-lifecycle](#session-lifecycle) | 会话 / 多 Session 生命周期与选择 | high | [`src/agentController.ts`](../src/agentController.ts)<br>`AgentController`<br>`AgentController.prepareRun`<br>`AgentController.run`<br>`AgentController.selectSession`<br>`AgentController.restoreSelection`<br>`AgentController.stop`<br>`AgentController.resume` | `quick-session`<br>`integration`<br>`cancel-integration`<br>`cancel-probe` |
| [session-catalog](#session-catalog) | 会话 / 历史目录、缓存与删除 | high | [`src/sessionCatalog.ts`](../src/sessionCatalog.ts)<br>`SessionCatalog`<br>`SessionCatalog.list`<br>`SessionCatalog.invalidate`<br>`SessionCatalog.rename` | `quick-session`<br>`quick-delete`<br>`quick-webview`<br>`integration` |
| [session-export](#session-export) | 会话 / 会话重命名与导出 | medium | [`src/sessionExport.ts`](../src/sessionExport.ts)<br>`sessionToMarkdown`<br>`sessionExportFilename` | `quick-export`<br>`quick-webview` |
| [host-launch](#host-launch) | 运行时 / 普通 Node Host 与模型网络 | high | [`src/runtime.ts`](../src/runtime.ts)<br>`harnessLaunchOptions`<br>`createHarness`<br>`defaultDshHome`<br>`hostNetworkEnvironment`<br>`sameNetworkOptions`<br>`ordinaryNode`<br>`webProviderPatch`<br>`developmentRepository` | `quick-session`<br>`runtime-launch`<br>`node-probe`<br>`electron-probe`<br>`integration`<br>`sdk-probe`<br>`runtime-baseline` |
| [model-routing](#model-routing) | 模型 / 模型目录与逐轮路由 | medium | [`src/extension.ts`](../src/extension.ts)<br>`selectModel`<br>`isCatalog`<br>`isModelRoute`<br>`migrateRemovedBuiltinRoute` | `quick-webview`<br>`integration` |
| [model-onboarding](#model-onboarding) | 模型 / 模型服务引导与私密凭据 | high | [`media/webview.js`](../media/webview.js)<br>`amoOnboarding`<br>`amoOpenProvider`<br>`amoDiscover`<br>`amoSave`<br>`handleAmoMessage` | `quick-webview`<br>`runtime-sdk`<br>`vsix` |
| [prompt-send](#prompt-send) | 对话 / 发送、停止与上下文组装 | high | [`src/extension.ts`](../src/extension.ts)<br>`activate` | `quick-webview`<br>`integration` |
| [event-projection](#event-projection) | 对话 / DSH 事件到界面消息 | high | [`src/agent.ts`](../src/agent.ts)<br>`SessionRuntime.onNotification`<br>`SessionRuntime.onAssistantEvent`<br>`SessionRuntime.replayHistory` | `quick-session`<br>`quick-webview`<br>`integration` |
| [conversation-reading](#conversation-reading) | 对话 / 流式跟随、吸顶问题与历史编辑 | medium | [`media/webview.js`](../media/webview.js)<br>`scrollToLatest`<br>`flushStream`<br>`updateStickyPrompt`<br>`scheduleStickyPrompt`<br>`editHistory`<br>`bindHistory`<br>`updateHistoryBinding` | `quick-webview`<br>`integration` |
| [history-resend](#history-resend) | 恢复 / 历史回滚、换模型重发与撤销 | high | [`src/agentController.ts`](../src/agentController.ts)<br>`AgentController.resendFromHistory`<br>`AgentController.previewRestore`<br>`AgentController.hasCheckpointFor`<br>`AgentController.warmupRewind`<br>`AgentController.undoRestore` | `quick-session`<br>`quick-webview`<br>`quick-checkpoint`<br>`integration` |
| [checkpoints](#checkpoints) | 恢复 / 检查点、快照与文件恢复 | high | [`src/checkpoints.ts`](../src/checkpoints.ts)<br>`CheckpointStore`<br>`CheckpointStore.before`<br>`CheckpointStore.track`<br>`CheckpointStore.trackWorkspaceChanges`<br>`CheckpointStore.finish`<br>`CheckpointStore.deleteSession`<br>`workspacePath` | `quick-checkpoint`<br>`checkpoint-integration`<br>`integration`<br>`workbench-e2e` |
| [diff-review](#diff-review) | 代码审查 / 内联 Diff、历史基线与 Git Diff | high | [`src/agent.ts`](../src/agent.ts)<br>`SessionRuntime.refreshInlineDiff`<br>`SessionRuntime.openDiff`<br>`SessionRuntime.checkpointBaseline` | `quick-diff`<br>`quick-webview`<br>`diff-integration`<br>`integration`<br>`workbench-e2e` |
| [edit-conflicts](#edit-conflicts) | 代码审查 / 外部修改与未保存编辑器冲突 | medium | [`src/conflicts.ts`](../src/conflicts.ts)<br>`EditConflictMonitor`<br>`EditConflictMonitor.snapshot`<br>`EditConflictMonitor.watch`<br>`onEditConflict` | `quick-webview`<br>`integration` |
| [approval](#approval) | 工具与安全 / 只读模式与单次工具审批 | high | [`src/approval.ts`](../src/approval.ts)<br>`requestApproval` | `approval`<br>`integration` |
| [structured-questions](#structured-questions) | 工具与安全 / DSH 结构化提问 | medium | [`src/questions.ts`](../src/questions.ts)<br>`QuestionBroker`<br>`QuestionBroker.ask`<br>`QuestionBroker.answer`<br>`QuestionBroker.cancel` | `question-probe` |
| [verification](#verification) | 验证 / 测试证据、失败定位与托管重跑 | high | [`src/verification.ts`](../src/verification.ts)<br>`VerificationTracker`<br>`VerificationTracker.record`<br>`VerificationTracker.report`<br>`VerificationTracker.rerunCommand` | `quick-webview`<br>`quick-checkpoint`<br>`integration`<br>`workbench-e2e`<br>`real-project` |
| [diagnostics](#diagnostics) | 可观测性 / 错误分类、重试状态与日志 | medium | [`src/diagnostics.ts`](../src/diagnostics.ts)<br>`errorText`<br>`hostError`<br>`toolError`<br>`diagnostic` | `quick-webview`<br>`integration` |
| [test-infrastructure](#test-infrastructure) | 工程效率 / 分层测试与开发探针 | medium | [`scripts/vscode-integration.cjs`](../scripts/vscode-integration.cjs)<br>`main` | `index`<br>`runtime-baseline`<br>`runtime-native` |
| [feature-index](#feature-index) | 工程效率 / 功能索引与一致性校验 | low | [`docs/feature-catalog.json`](feature-catalog.json)<br>`schemaVersion`<br>`features`<br>`integrations`<br>`tests` | `index` |


## 4.1 接入与视图

### extension-shell · 扩展激活与 Webview 容器

**风险：medium**。注册侧栏、命令、输出通道、设置和 Webview；controller 在视图销毁后继续存在。

**代码与符号**

- [`src/extension.ts`](../src/extension.ts)<br>`activate`<br>`html`<br>`currentModelRoute`
- [`package.json`](../package.json)<br>`main`<br>`contributes`<br>`capabilities`<br>`untrustedWorkspaces`
- [`src/agentController.ts`](../src/agentController.ts)<br>`AgentController.requireTrust`<br>`AgentController.restoreSelection`
- [`media/webview.js`](../media/webview.js)<br>`applyTrustState`
- [`media/agent.svg`](../media/agent.svg)

**调用链**

- VS Code activate → AgentController → registerWebviewViewProvider → html → media/webview.js

**界面元素与处理函数**

| 选择器 | 处理函数 |
| --- | --- |
| `#topbar, #session-picker, #session-select, #session-menu` | `renderSessions` |
| `#conversation-shell, #conversation, #log, #status` | `append` |
| `#workspace-trust, .workspace-trust-copy, #trust-workspace` | `applyTrustState` |
| `#bottom, #composer, #input, #input-highlight` | `updateInputHighlight` |
| `#composer-toolbar, #permissionMode, #model, #send` | `busy` |

**Webview → 扩展**：`ready`<br>`manageTrust`<br>`openLocation`  
**扩展 → Webview**：`conflict`<br>`workspaceTrust`

**不可破坏的约束**

- CSP 只允许受控脚本/样式/图片；动态内容使用 DOM API。
- 工作区限制为单项目；扩展 Host 不是运行模型的普通 Node。
- 未受信任工作区只注册界面，不启动 DSH、索引项目、读取目录或恢复会话；信任卡片只调用 VS Code 官方信任对话框，授权后自动初始化目录和会话。
- 视图销毁不得等同于停止 Agent。

**功能依赖**：[session-lifecycle](#session-lifecycle)  
**DSH 接口**：—  
**回归测试**：`quick-session`、`quick-webview`、`vsix`、`integration`（命令见 §7）

## 4.2 会话

### session-lifecycle · 多 Session 生命周期与选择

**风险：high**。创建、切换、后台运行、停止和恢复独立 Session；保存当前工作区选择。

**代码与符号**

- [`src/agentController.ts`](../src/agentController.ts)<br>`AgentController`<br>`AgentController.prepareRun`<br>`AgentController.run`<br>`AgentController.selectSession`<br>`AgentController.restoreSelection`<br>`AgentController.stop`<br>`AgentController.resume`
- [`src/agent.ts`](../src/agent.ts)<br>`SessionRuntime`<br>`SessionRuntime.start`<br>`SessionRuntime.stop`<br>`SessionRuntime.closeHost`<br>`SessionRuntime.prepareRestore`

**调用链**

- Webview 选择/发送 → AgentController 定位 runtime → SessionRuntime Host → DSH resume/run → 按 sessionId 投影当前视图

**Webview → 扩展**：`ready`<br>`sessionSelect`<br>`new`<br>`stop`<br>`resume`  
**扩展 → Webview**：`busy`<br>`sessionSelected`<br>`cleared`

**持久化与状态**

- workspaceState.currentSession:<workspace>
- liveViews: 仅内存的事件投影
- runtimes: 每 Session 一个写 Host
- turnSerial: 单调递增的 turn 标识，stop 后防止迟到的 start finally 覆盖新 turn 的 busy

**不可破坏的约束**

- 选择状态和 runtime.id 不得分离；新任务采用 prepareRun 时的目标。
- 后台 Session 不重置当前 busy、视图或选择。
- 切换/重载不能同时持有同一 Session 的活跃写锁。
- 关闭 Webview 不结束后台任务。
- stop() 通过 session/cancel RPC 优雅中断活跃 turn，Host 进程保持热备、部分输出以 interrupted 落盘；仅当 Host 已冷或 cancel RPC 失败时才 teardown 并同步释放 busy、递增 turnSerial。
- 被 turnSerial 淘汰的旧 start() 的 catch/finally 不得触碰共享状态（harness、busy、stopped），只能清理自己持有的局部 harness 引用。

**功能依赖**：[host-launch](#host-launch)、[event-projection](#event-projection)  
**DSH 接口**：`sdk-client`  
**回归测试**：`quick-session`、`integration`、`cancel-integration`、`cancel-probe`（命令见 §7）

### session-catalog · 历史目录、缓存与删除

**风险：high**。读取当前工作区的历史会话、合并较新投影、异步删除日志和检查点；支持本地重命名覆盖。

**代码与符号**

- [`src/sessionCatalog.ts`](../src/sessionCatalog.ts)<br>`SessionCatalog`<br>`SessionCatalog.list`<br>`SessionCatalog.invalidate`<br>`SessionCatalog.rename`
- [`src/agentController.ts`](../src/agentController.ts)<br>`AgentController.readOnly`<br>`AgentController.deleteSession`<br>`AgentController.history`
- [`src/agent.ts`](../src/agent.ts)<br>`sessionPathSegment`<br>`sessionProjectKey`
- [`media/webview.js`](../media/webview.js)<br>`renderSessions`<br>`selectSession`

**调用链**

- 只读 Host.listSessions → SessionCatalog 合并 → Webview 目录；删除 → 标记 deletedSessions → 关闭目标 Host → 删除 JSONL/投影/检查点

**Webview → 扩展**：`sessionList`<br>`sessionSelect`<br>`sessionDelete`  
**扩展 → Webview**：`sessionList`<br>`sessionListStatus`<br>`sessionDeleted`<br>`sessionSelected`

**持久化与状态**

- <dshHome>/sessions/<projectKey>/<sessionId>
- <dshHome>/storages/session_projcache/sessions/<sessionId>.json
- CheckpointStore 的共享快照引用

**不可破坏的约束**

- 迟到的目录响应不能复活已删除项。
- 正在运行的目标不能删除；删除其他 Session 不影响当前选择。
- 只有磁盘删除成功或目标已不存在才解除删除标记。
- 路径段转义必须与 DSH 一致，禁止目录逃逸。

**功能依赖**：[session-lifecycle](#session-lifecycle)、[checkpoints](#checkpoints)  
**DSH 接口**：`sdk-client`、`session-storage`  
**回归测试**：`quick-session`、`quick-delete`、`quick-webview`、`integration`（命令见 §7）

### session-export · 会话重命名与导出

**风险：medium**。将会话历史导出为 Markdown 文件归档；允许用户覆盖 DSH 派生的默认标题。

**代码与符号**

- [`src/sessionExport.ts`](../src/sessionExport.ts)<br>`sessionToMarkdown`<br>`sessionExportFilename`
- [`src/extension.ts`](../src/extension.ts)<br>`exportSession`<br>`renameSession`
- [`src/agentController.ts`](../src/agentController.ts)<br>`AgentController.renameSession`
- [`src/sessionCatalog.ts`](../src/sessionCatalog.ts)<br>`SessionCatalog.rename`<br>`SessionCatalog.titleOverrides`
- [`media/webview.js`](../media/webview.js)<br>`renameSession`<br>`exportSession`

**调用链**

- Webview 导出请求 → Extension 读取 sessionHistory → 渲染 Markdown → 用户选择保存路径 → 写入文件；重命名 → SessionCatalog 持久化覆盖到 workspaceState

**Webview → 扩展**：`exportSession`<br>`renameSession`  
**扩展 → Webview**：`sessionExported`<br>`sessionRenamed`

**持久化与状态**

- workspaceState.sessionTitle:<sessionId> 用户自定义标题
- 导出文件由用户选择路径，默认建议 <工作区>/<标题>-<id>.md

**不可破坏的约束**

- 重命名不修改 DSH 磁盘日志；覆盖层仅存 workspaceState。
- 导出是只读操作；不触发 Host 写操作。
- 思考过程在导出中折叠为 <details>，默认不展开。

**功能依赖**：[session-catalog](#session-catalog)  
**DSH 接口**：`sdk-client`  
**回归测试**：`quick-export`、`quick-webview`（命令见 §7）

## 4.3 运行时

### host-launch · 普通 Node Host 与模型网络

**风险：high**。默认从 Electron 通过 SDK nodePath 启动随包 Node 24.9.0 和编译 DSH；复用 DSH_HOME/~/.dsh，显式源码模式与代理、模型声明、Host 重建相互隔离。

**代码与符号**

- [`src/runtime.ts`](../src/runtime.ts)<br>`harnessLaunchOptions`<br>`createHarness`<br>`defaultDshHome`<br>`hostNetworkEnvironment`<br>`sameNetworkOptions`<br>`ordinaryNode`<br>`webProviderPatch`<br>`developmentRepository`
- [`src/agent.ts`](../src/agent.ts)<br>`SessionRuntime.options`<br>`SessionRuntime.start`
- [`src/agentController.ts`](../src/agentController.ts)<br>`AgentController.options`<br>`AgentController.readOnly`
- [`package.json`](../package.json)<br>`privateCodingAgent.runtimeMode`<br>`privateCodingAgent.networkMode`<br>`privateCodingAgent.proxyUrl`<br>`privateCodingAgent.dshRepository`<br>`privateCodingAgent.dshHome`
- [`scripts/runtime-launch-options-suite.cjs`](../scripts/runtime-launch-options-suite.cjs)
- [`scripts/runtime-launch-suite.cjs`](../scripts/runtime-launch-suite.cjs)
- [`docs/RUNTIME_DELIVERY_PLAN.md`](RUNTIME_DELIVERY_PLAN.md)
- [`docs/RUNTIME_BASELINE.md`](RUNTIME_BASELINE.md)
- [`docs/RUNTIME_CLOSURE.md`](RUNTIME_CLOSURE.md)

**调用链**

- VS Code settings → DSH_AGENT_HOME / 显式 dshHome / 开发 Home / DSH_HOME / ~/.dsh → harnessLaunchOptions → bundled Node/DSH 或显式已构建 source → SDK nodePath + dsh profile sdk + patches → stdio JSON-RPC

**Webview → 扩展**：—  
**扩展 → Webview**：`config`<br>`status`<br>`error`

**持久化与状态**

- <globalStorage>/runtime-patches/web-providers-<hash>.yml 仅模型声明，不含密钥
- bundled 默认复用 DSH_HOME 或 ~/.dsh 中的 DSH 凭据和会话；界面状态和可写补丁留在 VS Code globalStorage
- DSH home 中的私有凭据由 DSH 管理

**不可破坏的约束**

- direct 默认覆盖继承和 .env 代理变量；system 保留继承；proxy 仅支持 HTTP(S)。
- 测试通过 DSH_AGENT_HOME 强制隔离数据目录；显式 dshHome 优先于默认共享目录。
- 不记录代理认证信息或 API Key。
- 模型切换只改变下一次 route，不重启 Host；网络/权限变化在空闲 Host 边界重建。
- 发布默认 bundled；组件缺失/损坏明确失败，绝不回退 source、tsx 或 Electron。
- 扩展只执行已构建 CLI；source 模式必须先构建 DSH，显式使用源码补丁。

**功能依赖**：—  
**DSH 接口**：`sdk-client`、`sdk-transport`、`sdk-profile`、`model-providers`  
**回归测试**：`quick-session`、`runtime-launch`、`node-probe`、`electron-probe`、`integration`、`sdk-probe`、`runtime-baseline`（命令见 §7）

## 4.4 模型

### model-routing · 模型目录与逐轮路由

**风险：medium**。展示可用模型，串行保存 provider/model，并将所选 route 应用于新轮次和历史重发。

**代码与符号**

- [`src/extension.ts`](../src/extension.ts)<br>`selectModel`<br>`isCatalog`<br>`isModelRoute`<br>`migrateRemovedBuiltinRoute`
- [`media/webview.js`](../media/webview.js)<br>`renderModels`<br>`refreshModelCatalog`
- [`src/agent.ts`](../src/agent.ts)<br>`SessionRuntime.run`<br>`SessionRuntime.options`
- [`src/agentController.ts`](../src/agentController.ts)<br>`AgentController.modelCatalog`
- [`src/modelRouting.ts`](../src/modelRouting.ts)<br>`ModelRoute`<br>`migrateRemovedBuiltinRoute`
- [`src/extension.ts`](../src/extension.ts)<br>`selectModel`

**调用链**

- 独立查询 Host 使用可启动的内置路由读取目录 → 迁移旧版已移除的内置模型选择 → 校验并保存 Workspace 设置 → session.run({route}) → request/header 回显真实路由

**Webview → 扩展**：`modelCatalog`<br>`modelRoute`<br>`send`<br>`resend`  
**扩展 → Webview**：`modelCatalog`<br>`modelCatalogStatus`<br>`modelConfig`<br>`modelRoute`

**不可破坏的约束**

- 目录响应不能覆盖更新的用户选择。
- 查询 Host 不得继承已移除的保存路由；仅迁移旧版内置模型，不擅自替换用户自定义 Provider。
- 无凭据导致的空目录明确提示登录或配置 DSH Home，不误报为模型声明缺失。
- 发送时等待模型设置写入完成；失败不得静默使用另一模型。
- 实际请求头而非下拉框是路由事实来源。

**功能依赖**：[host-launch](#host-launch)、[session-lifecycle](#session-lifecycle)  
**DSH 接口**：`sdk-client`、`model-providers`  
**回归测试**：`quick-webview`、`integration`（命令见 §7）

### model-onboarding · 模型服务引导与私密凭据

**风险：high**。首启或空目录时选择厂商，使用临时草稿发现与测试模型，保存私密凭据并管理已有服务。

**代码与符号**

- [`media/webview.js`](../media/webview.js)<br>`amoOnboarding`<br>`amoOpenProvider`<br>`amoDiscover`<br>`amoSave`<br>`handleAmoMessage`
- [`src/extension.ts`](../src/extension.ts)<br>`html`<br>`activate`
- [`src/agentController.ts`](../src/agentController.ts)<br>`AgentController.discoverModels`<br>`AgentController.testModel`<br>`AgentController.saveProvider`<br>`AgentController.deleteProvider`<br>`AgentController.providerConfig`

**调用链**

- Webview 草稿 → 扩展/Controller → DSH 临时模型发现或最小推理 → 选择模型/别名 → DSH settings + private credentials → Workspace provider/model → 刷新目录并回到会话

**界面元素与处理函数**

| 选择器 | 处理函数 |
| --- | --- |
| `#model-onboarding, #amo-provider-view, #amo-provider-grid` | `amoRenderProviders` |
| `#amo-config-view, #amo-key, #amo-model-list, #amo-config-footer` | `amoSave` |
| `#amo-manage-view, #model-menu` | `amoRenderManage` |

**Webview → 扩展**：`discoverModels`<br>`testModel`<br>`saveCustomProvider`<br>`deleteCustomProvider`<br>`providerConfig`  
**扩展 → Webview**：`discoverModelsResult`<br>`testModelResult`<br>`saveCustomProviderResult`<br>`deleteCustomProviderResult`<br>`providerConfigResult`

**持久化与状态**

- <dshHome>/settings 的 llm-pi-ai.providers.<route> 只含非私密配置
- <dshHome>/.credentials.yaml 由 DSH 凭据服务管理，Webview 不读取明文
- Workspace privateCodingAgent.provider/model 是下一次请求的路由

**不可破坏的约束**

- 发现与测试不创建 Session，不写持久配置；密钥仅单向进入 DSH，结果与配置读取不回显密钥。
- 保存后清空 Webview 密钥；编辑留空保留已有凭据。
- 删除不删除历史会话；删除最后一个服务重新打开引导。
- 目录为空不得伪造默认模型或允许发送。
- 未受信任工作区不启动 DSH 或发送配置请求。

**功能依赖**：[model-routing](#model-routing)、[host-launch](#host-launch)  
**DSH 接口**：`sdk-client`、`model-providers`  
**回归测试**：`quick-webview`、`runtime-sdk`、`vsix`（命令见 §7）

## 4.5 对话

### prompt-send · 发送、停止与上下文组装

**风险：high**。从编辑器捕获上下文，安全展开 @ 文件，在一次发送边界绑定目标和模型。

**代码与符号**

- [`src/extension.ts`](../src/extension.ts)<br>`activate`
- [`src/context.ts`](../src/context.ts)<br>`captureEditorContext`<br>`promptWithEditorContext`<br>`promptWithFileReferences`<br>`workspaceFiles`<br>`openEditorReference`
- [`src/agent.ts`](../src/agent.ts)<br>`SessionRuntime.showUserPrompt`<br>`SessionRuntime.run`
- [`media/webview.js`](../media/webview.js)<br>`busy`<br>`updateInputHighlight`<br>`fileSearch`<br>`chooseFile`<br>`registerSubmission`<br>`retireSubmissionForElement`

**调用链**

- 用户发送 → prepareRun 冻结 sessionId → 保存 route → 捕获编辑器上下文/文件引用 → SessionRuntime.run → DSH

**界面元素与处理函数**

| 选择器 | 处理函数 |
| --- | --- |
| `#input, #input-highlight, #file-picker, .file-option` | `fileSearch` |
| `#context-preview` | `openEditorReference` |

**Webview → 扩展**：`send`<br>`stop`<br>`openContext`<br>`fileList`  
**扩展 → Webview**：`user`<br>`busy`<br>`fileList`<br>`editorContext`

**不可破坏的约束**

- 只读取显式 @ 的工作区普通文本文件，最多 10 个、每个 64 KiB。
- 选区最多 20000 字符；无选区不发送文件内容。
- 展示的用户问题与注入的上下文分离，历史不得重复回显。
- 停止只作用于指定 Session。
- 停止恢复仅依据 submissions 状态机（pending → accepted/observed/failed）；未被 Host 接纳的 pending 回声退回输入框，已 accepted/observed 的消息（含历史重发）绝不回退。

**功能依赖**：[session-lifecycle](#session-lifecycle)、[model-routing](#model-routing)  
**DSH 接口**：`sdk-client`  
**回归测试**：`quick-webview`、`integration`（命令见 §7）

### event-projection · DSH 事件到界面消息

**风险：high**。将 DSH 流、工具、重试、路由与测试事件投影为 UI 消息，区分实时事件和历史回放。

**代码与符号**

- [`src/agent.ts`](../src/agent.ts)<br>`SessionRuntime.onNotification`<br>`SessionRuntime.onAssistantEvent`<br>`SessionRuntime.replayHistory`
- [`src/agentController.ts`](../src/agentController.ts)<br>`AgentController.output`<br>`AgentController.record`
- [`media/webview.js`](../media/webview.js)<br>`append`<br>`flushStream`<br>`busy`

**调用链**

- session.event → SessionRuntime.onNotification → AgentController.output → 当前 Session Webview 或后台 liveViews

**Webview → 扩展**：—  
**扩展 → Webview**：`assistantBoundary`<br>`assistant`<br>`assistantDelta`<br>`user`<br>`messageSeq`<br>`modelRoute`<br>`status`

**不可破坏的约束**

- delta 保留边界，不用最终文本覆盖实时流。
- 历史回放不产生新的测试、工具或检查点副作用。
- 错误对象必须可读；重试期间有可见状态。
- 消息所属 Session 不随前台选择变化。
- 检查点 seq 重绑比较必须剥离 editor-context 与 @ 引用后缀，与 replayHistory 使用同一边界规则；否则带上下文的消息 userSeq 保持 -1，重发时报『当前没有可恢复的历史会话』。
- 实时用户回显（start 的 showUserPrompt）必须用 pendingDisplayPrompt 纯文本，绝不用 pendingPrompt 线文本；线文本含注入的 editor-context，泄漏进历史编辑框会导致每次重发叠加一层 context。

**功能依赖**：[diagnostics](#diagnostics)、[verification](#verification)、[checkpoints](#checkpoints)  
**DSH 接口**：`sdk-client`  
**回归测试**：`quick-session`、`quick-webview`、`integration`（命令见 §7）

### conversation-reading · 流式跟随、吸顶问题与历史编辑

**风险：medium**。流式输出时跟随底部，阅读历史时暂停跟随；吸顶展示当前问题，可展开或在原位编辑重发。

**代码与符号**

- [`media/webview.js`](../media/webview.js)<br>`scrollToLatest`<br>`flushStream`<br>`updateStickyPrompt`<br>`scheduleStickyPrompt`<br>`editHistory`<br>`bindHistory`<br>`updateHistoryBinding`
- [`src/extension.ts`](../src/extension.ts)<br>`html`

**调用链**

- scroll 事件决定 followOutput → 50ms 批量追加稳定文本节点 → 正文阶段结束或轮次完成后统一渲染 Markdown → requestAnimationFrame 更新吸顶 → 点击卡片/右上角图标分别编辑/展开

**界面元素与处理函数**

| 选择器 | 处理函数 |
| --- | --- |
| `#sticky-prompt, .prompt-toggle` | `updateStickyPrompt` |
| `.user, .history-toggle, .history-edit, .history-send` | `editHistory` |
| `.assistant` | `flushStream` |

**Webview → 扩展**：`resend`  
**扩展 → Webview**：`assistant`<br>`assistantDelta`<br>`user`<br>`messageSeq`<br>`messageCheckpoint`<br>`busy`<br>`cleared`

**不可破坏的约束**

- 阅读历史时不强制下拉；回到底部恢复跟随。
- 流式正文按块增量渲染：已闭合代码块或空行分隔的前缀立即渲染为稳定 DOM，仅未闭合尾部追加文本节点；已渲染块绝不重建。
- 吸顶编辑不修改原历史卡片、不滚动原文。
- 正文点击进入编辑，右上角图标控制展开，二者不得混用。
- 运行中禁止编辑另一轮；迟到的 seq/checkpoint 必须更新已存在卡片。

**功能依赖**：[history-resend](#history-resend)、[event-projection](#event-projection)  
**DSH 接口**：—  
**回归测试**：`quick-webview`、`integration`（命令见 §7）

## 4.6 恢复

### history-resend · 历史回滚、换模型重发与撤销

**风险：high**。预览受影响文件、确认回滚、保留 Session 身份 rewind 对话，并用所选模型重新发送。

**代码与符号**

- [`src/agentController.ts`](../src/agentController.ts)<br>`AgentController.resendFromHistory`<br>`AgentController.previewRestore`<br>`AgentController.hasCheckpointFor`<br>`AgentController.warmupRewind`<br>`AgentController.undoRestore`
- [`src/agent.ts`](../src/agent.ts)<br>`SessionRuntime.resendFromHistory`<br>`SessionRuntime.resolveRewindBoundary`<br>`SessionRuntime.ensureRewindReady`<br>`SessionRuntime.warmupRewind`<br>`SessionRuntime.hasCheckpointFor`
- [`src/checkpoints.ts`](../src/checkpoints.ts)<br>`CheckpointStore.previewRestore`<br>`CheckpointStore.validateRestore`<br>`CheckpointStore.restoreFrom`<br>`CheckpointStore.undo`
- [`src/extension.ts`](../src/extension.ts)<br>`confirmRestore`
- [`media/webview.js`](../media/webview.js)<br>`editHistory`

**调用链**

- Webview resend → 并行 previewRestore + warmupRewind；hasCheckpointFor 决定确认框文案 → confirmRestore 立即弹出 → 确认后 await preview、保存脏编辑器 → resolveRewindBoundary 与 checkpoints.list 并发 → ensureRewindReady 与 warmup 去重共享 resume → rewind Session → 漂移时以实时状态重建 RestorePlan 并恢复检查点 → 重新加载历史 → run(route)

**界面元素与处理函数**

| 选择器 | 处理函数 |
| --- | --- |
| `.history-edit, .history-model, .history-hint` | `editHistory` |
| `.checkpoint-restored` | `undoRestore` |

**Webview → 扩展**：`resend`<br>`undoRestore`  
**扩展 → Webview**：`status`<br>`checkpointRestored`<br>`error`

**不可破坏的约束**

- 保留 Session ID 与后续检查点存储归属。
- 无检查点仍允许仅回滚对话；有检查点可选择是否恢复代码。
- rewind 边界必须以持久化日志中的 user/message 事件为准；UI 传入 seq 与 Host 内存投影可能错位，不能直接传给 DSH rewind。
- 确认后文件哈希漂移时以实时状态重建恢复计划继续执行（用户已确认回滚语义），不因陈旧预览哈希中止整个 rewind。
- 只备份和写入计划影响的文件；取消不能 rewind 或发送。

**功能依赖**：[checkpoints](#checkpoints)、[session-lifecycle](#session-lifecycle)、[model-routing](#model-routing)  
**DSH 接口**：`sdk-client`  
**回归测试**：`quick-session`、`quick-webview`、`quick-checkpoint`、`integration`（命令见 §7）

### checkpoints · 检查点、快照与文件恢复

**风险：high**。在每轮开始前保存工作区基线，跟踪 edit/write/Bash 变更，保护手工修改，管理撤销和共享快照生命周期。

**代码与符号**

- [`src/checkpoints.ts`](../src/checkpoints.ts)<br>`CheckpointStore`<br>`CheckpointStore.before`<br>`CheckpointStore.track`<br>`CheckpointStore.trackWorkspaceChanges`<br>`CheckpointStore.finish`<br>`CheckpointStore.deleteSession`<br>`workspacePath`
- [`src/agent.ts`](../src/agent.ts)<br>`SessionRuntime.onNotification`<br>`SessionRuntime.checkpointTracking`

**调用链**

- turn 前 before → 工具修改 track / Bash finish 比较 → finish 保存轮末哈希 → restoreFrom / undo → deleteSession 引用计数清理

**Webview → 扩展**：—  
**扩展 → Webview**：`messageCheckpoint`<br>`messageSeq`<br>`checkpointRestored`

**持久化与状态**

- <globalStorage>/checkpoints/<encoded-workspace>/index.json
- <checkpoint>.json 全量清单与 hash 引用
- <checkpoint>-<path>.json 旧格式单文件快照
- blobs/<sha256>.json 私有内容

**不可破坏的约束**

- 排除 .env、密钥、Git、依赖、私有 Agent 数据与外部符号链接；单文件上限 10 MiB。大文件仅记录元数据、不复制内容；变化时提示人工审查但不阻断轮次或其他文件恢复，回滚与撤销不得误删大文件。
- 快照不可变；同文件多轮恢复以最老基线为准。
- turnEnds 用于区分手工修改；未知变化宁可报冲突。
- 共享 blob/undo/继承记录仍被引用时不能删除。

**功能依赖**：—  
**DSH 接口**：`session-storage`  
**回归测试**：`quick-checkpoint`、`checkpoint-integration`、`integration`、`workbench-e2e`（命令见 §7）

## 4.7 代码审查

### diff-review · 内联 Diff、历史基线与 Git Diff

**风险：high**。编辑器显示本轮增删改，删除内容通过 hover 查看；打开检查点基线或 Git HEAD 的原生 Diff。

**代码与符号**

- [`src/agent.ts`](../src/agent.ts)<br>`SessionRuntime.refreshInlineDiff`<br>`SessionRuntime.openDiff`<br>`SessionRuntime.checkpointBaseline`
- [`src/inlineDiff.ts`](../src/inlineDiff.ts)<br>`InlineDiffRenderer`<br>`InlineDiffRenderer.apply`
- [`src/diff.ts`](../src/diff.ts)<br>`changedPath`<br>`openChangedDiff`
- [`src/extension.ts`](../src/extension.ts)<br>`activate`
- [`media/webview.js`](../media/webview.js)<br>`showTool`<br>`showVerificationReport`

**调用链**

- 成功文件修改 → changedPath → baseline → InlineDiffRenderer；打开 Diff → coding-agent-checkpoint URI → 当前工作区校验 → vscode.diff

**界面元素与处理函数**

| 选择器 | 处理函数 |
| --- | --- |
| `#diff-visible, #diff, .tool-diff` | `showTool` |

**Webview → 扩展**：`openDiff`  
**扩展 → Webview**：`toolResult`<br>`verificationReport`

**不可破坏的约束**

- Diff URI 必须保留源 sessionId，切换会话后不得读取另一会话的基线。
- 装饰失败不能使 Agent 轮次失败；删除行不覆盖修改行。
- 无检查点基线时可回退 Git HEAD；无 Git 基线给出明确提示。

**功能依赖**：[checkpoints](#checkpoints)、[event-projection](#event-projection)  
**DSH 接口**：—  
**回归测试**：`quick-diff`、`quick-webview`、`diff-integration`、`integration`、`workbench-e2e`（命令见 §7）

### edit-conflicts · 外部修改与未保存编辑器冲突

**风险：medium**。在轮次开始记录文件时间戳，edit/write 前检查外部修改和脏编辑器，只警告不自动覆盖。

**代码与符号**

- [`src/conflicts.ts`](../src/conflicts.ts)<br>`EditConflictMonitor`<br>`EditConflictMonitor.snapshot`<br>`EditConflictMonitor.watch`<br>`onEditConflict`
- [`src/agent.ts`](../src/agent.ts)<br>`SessionRuntime.onNotification`
- [`src/extension.ts`](../src/extension.ts)<br>`activate`
- [`media/webview.js`](../media/webview.js)<br>`append`

**调用链**

- turn snapshot → tool/call watch → 时间戳/脏文档检查 → VS Code warning + Webview conflict

**Webview → 扩展**：—  
**扩展 → Webview**：`conflict`

**不可破坏的约束**

- 警告不是恢复或许可；不得自动保存或覆盖任一版本。
- 重新打开同一文档并保存不应当作外部修改。
- 检查器异常要明确提示，不静默声称安全。
- 当前 conflict 无 sessionId；Webview 只记录控制台，VS Code 警告拥有实际展示，不能误称为聊天卡片。

**功能依赖**：[event-projection](#event-projection)  
**DSH 接口**：—  
**回归测试**：`quick-webview`、`integration`（命令见 §7）

## 4.8 工具与安全

### approval · 只读模式与单次工具审批

**风险：high**。权限通过 DSH 原生 /permission 命令实时写入当前会话日志并即时生效；只读模式的升级写入经模态确认，只允许一次或拒绝。

**代码与符号**

- [`src/approval.ts`](../src/approval.ts)<br>`requestApproval`
- [`src/agent.ts`](../src/agent.ts)<br>`SessionRuntime.setPermissionMode`<br>`SessionRuntime.applyPermissionToSession`<br>`SessionRuntime.start`
- [`src/agentController.ts`](../src/agentController.ts)<br>`AgentController.setPermissionMode`
- [`src/extension.ts`](../src/extension.ts)<br>`activate`
- [`media/webview.js`](../media/webview.js)<br>`busy`

**调用链**

- Webview permissionMode → 保存工作区状态 → session/query 发送 /permission <preset> 命令 → DSH 追加 permission/preset 事件并更新沙箱与审批旋钮 → DSH approval/request → 单次允许/拒绝

**界面元素与处理函数**

| 选择器 | 处理函数 |
| --- | --- |
| `#permissionMode` | `busy` |

**Webview → 扩展**：`permissionMode`  
**扩展 → Webview**：`config`<br>`status`<br>`error`

**不可破坏的约束**

- 运行中不能修改权限。
- 权限 preset 持久化在会话日志中，resume/rewind 后必须通过 /permission 命令重新对齐当前工作区模式。
- rewind 截断日志会丢弃边界后的 permission/preset 事件，rewind 完成后必须重新应用。
- 不把一次许可扩展成整个会话许可。
- 不允许通过 Bash 绕过只读审批。
- 异步设置刷新不应当误判为拒绝。

**功能依赖**：[host-launch](#host-launch)、[session-lifecycle](#session-lifecycle)  
**DSH 接口**：`sdk-transport`  
**回归测试**：`approval`、`integration`（命令见 §7）

### structured-questions · DSH 结构化提问

**风险：medium**。把模型提出的选项、多选和自定义文本问题映射到聊天，校验答案并解决 pending 请求。

**代码与符号**

- [`src/questions.ts`](../src/questions.ts)<br>`QuestionBroker`<br>`QuestionBroker.ask`<br>`QuestionBroker.answer`<br>`QuestionBroker.cancel`
- [`src/agent.ts`](../src/agent.ts)<br>`SessionRuntime.answerQuestions`
- [`media/webview.js`](../media/webview.js)<br>`showQuestions`

**调用链**

- SDK onUserQuestion → QuestionBroker.ask → Webview questions → answerQuestions → resolve 或 Host 关闭时 cancel

**界面元素与处理函数**

| 选择器 | 处理函数 |
| --- | --- |
| `.question, .question-title` | `showQuestions` |

**Webview → 扩展**：`answerQuestions`  
**扩展 → Webview**：`questions`<br>`error`

**不可破坏的约束**

- requestId 必须匹配当前 pending 问题；重复/过期答案不解决新请求。
- 答案数量、选项和多选约束需再次校验。
- Host 关闭必须 resolve cancelled，不能留下悬空 Promise。

**功能依赖**：[session-lifecycle](#session-lifecycle)  
**DSH 接口**：`sdk-transport`  
**回归测试**：`question-probe`（命令见 §7）

## 4.9 验证

### verification · 测试证据、失败定位与托管重跑

**风险：high**。从真实 Bash 输出识别测试结果，定位失败源码，仅对覆盖原失败的精确重跑标记恢复。

**代码与符号**

- [`src/verification.ts`](../src/verification.ts)<br>`VerificationTracker`<br>`VerificationTracker.record`<br>`VerificationTracker.report`<br>`VerificationTracker.rerunCommand`
- [`src/diagnostics.ts`](../src/diagnostics.ts)<br>`testSummary`<br>`testFailures`<br>`testRerunCommand`
- [`src/agent.ts`](../src/agent.ts)<br>`SessionRuntime.publishVerification`<br>`SessionRuntime.rerunVerification`
- [`media/webview.js`](../media/webview.js)<br>`showTestResult`<br>`showVerificationReport`

**调用链**

- tool/result bash → testSummary → VerificationTracker → 测试卡片/报告 → VS Code 终端执行目标命令 → 更新原失败状态

**界面元素与处理函数**

| 选择器 | 处理函数 |
| --- | --- |
| `.test-result, #verification-report, .verification-failure, .rerun-tests` | `showVerificationReport` |

**Webview → 扩展**：`rerunTests`<br>`openLocation`  
**扩展 → Webview**：`testResult`<br>`verificationReport`

**不可破坏的约束**

- 模型文字声称通过不算证据；失败退出码优先于 OK 文本。
- 不相关测试通过不能清除已有失败。
- 重跑位置限制在当前工作区，终端完成事件必须按 execution 关联。

**功能依赖**：[event-projection](#event-projection)、[diff-review](#diff-review)  
**DSH 接口**：—  
**回归测试**：`quick-webview`、`quick-checkpoint`、`integration`、`workbench-e2e`、`real-project`（命令见 §7）

## 4.10 可观测性

### diagnostics · 错误分类、重试状态与日志

**风险：medium**。展开 JSON-RPC 错误对象，区分模型/Host/工具/沙箱错误，保留重试和耗时线索。

**代码与符号**

- [`src/diagnostics.ts`](../src/diagnostics.ts)<br>`errorText`<br>`hostError`<br>`toolError`<br>`diagnostic`
- [`src/agent.ts`](../src/agent.ts)<br>`SessionRuntime.start`<br>`SessionRuntime.onNotification`
- [`src/extension.ts`](../src/extension.ts)<br>`activate`

**调用链**

- DSH/Host 异常 → errorText → 分类与建议 → Webview error；Coding Agent 输出通道保留详细事件和耗时

**Webview → 扩展**：—  
**扩展 → Webview**：`error`<br>`status`

**不可破坏的约束**

- 不得把对象显示为 [object Object]。
- 网络/模型 TIMEOUT 不误导为 Node 或源码路径错误。
- 日志不得包含凭据、完整代理认证 URL 或私密文件内容。

**功能依赖**：—  
**DSH 接口**：`sdk-transport`  
**回归测试**：`quick-webview`、`integration`（命令见 §7）

## 4.11 工程效率

### test-infrastructure · 分层测试与开发探针

**风险：medium**。以快速 DOM/数据测试、真实 Electron 集成、真实项目 E2E 和最小探针分层验证功能。

**代码与符号**

- [`scripts/vscode-integration.cjs`](../scripts/vscode-integration.cjs)<br>`main`
- [`config/runtime-baseline.json`](../config/runtime-baseline.json)<br>`node`<br>`dsh`
- [`scripts/runtime-baseline.cjs`](../scripts/runtime-baseline.cjs)<br>`createBaseline`<br>`validateLock`<br>`main`
- [`scripts/prepare-node.cjs`](../scripts/prepare-node.cjs)<br>`prepareNode`<br>`verifiedDownload`
- [`scripts/runtime-closure.cjs`](../scripts/runtime-closure.cjs)<br>`createClosure`<br>`collectClosure`<br>`inspectNative`<br>`stagedInventory`<br>`assertNoHostPaths`
- [`scripts/runtime-stage.cjs`](../scripts/runtime-stage.cjs)<br>`stage`
- [`scripts/runtime-native.cjs`](../scripts/runtime-native.cjs)<br>`nativeProbe`<br>`packedInstall`
- [`scripts/runtime-native-probe.mjs`](../scripts/runtime-native-probe.mjs)
- [`scripts/runtime-native-install-probe.mjs`](../scripts/runtime-native-install-probe.mjs)
- [`scripts/runtime-native-suite.cjs`](../scripts/runtime-native-suite.cjs)
- [`scripts/runtime-closure-suite.cjs`](../scripts/runtime-closure-suite.cjs)
- [`scripts/runtime-baseline-suite.cjs`](../scripts/runtime-baseline-suite.cjs)
- [`scripts/runtime-launch-options-suite.cjs`](../scripts/runtime-launch-options-suite.cjs)
- [`scripts/runtime-launch-suite.cjs`](../scripts/runtime-launch-suite.cjs)
- [`scripts/vsix-package.cjs`](../scripts/vsix-package.cjs)<br>`packageVsix`<br>`assertLicenses`
- [`scripts/runtime-licenses.cjs`](../scripts/runtime-licenses.cjs)<br>`supplementLicenses`<br>`hasLicense`<br>`rules`
- [`scripts/runtime-licenses-suite.cjs`](../scripts/runtime-licenses-suite.cjs)
- [`scripts/vsix-accept.cjs`](../scripts/vsix-accept.cjs)<br>`main`
- [`scripts/vsix-accept-suite.cjs`](../scripts/vsix-accept-suite.cjs)<br>`modelAcceptance`
- [`scripts/vsix-security-suite.cjs`](../scripts/vsix-security-suite.cjs)
- [`docs/RUNTIME_BASELINE.md`](RUNTIME_BASELINE.md)
- [`docs/RUNTIME_CLOSURE.md`](RUNTIME_CLOSURE.md)
- [`docs/RUNTIME_DELIVERY_PLAN.md`](RUNTIME_DELIVERY_PLAN.md)
- [`build/dsh-production-closure.json`](../build/dsh-production-closure.json)<br>`artifacts`
- [`scripts/webview-suite.cjs`](../scripts/webview-suite.cjs)<br>`async function run`
- [`scripts/session-runtime-suite.cjs`](../scripts/session-runtime-suite.cjs)<br>`async function run`
- [`scripts/checkpoint-suite.cjs`](../scripts/checkpoint-suite.cjs)<br>`async function run`
- [`scripts/checkpoint-baseline-suite.cjs`](../scripts/checkpoint-baseline-suite.cjs)<br>`run`
- [`scripts/diff-suite.cjs`](../scripts/diff-suite.cjs)
- [`.vscode/launch.json`](../.vscode/launch.json)<br>`Run Coding Agent Extension`
- [`package.json`](../package.json)<br>`scripts`

**调用链**

- npm run compile → 快速套件；VSCODE_AGENT_SUITE 选择集成脚本 → 隔离 DSH home/工作区 → 真实模型（仅标记测试）

**Webview → 扩展**：—  
**扩展 → Webview**：—

**持久化与状态**

- .vscode-agent-dev/dsh-test-* 临时 DSH home
- 测试专用工作区和 VS Code user-data；不删除交互式会话

**不可破坏的约束**

- 快速测试不依赖模型或真实 VS Code。
- 真实测试明确写出模型/文件/网络副作用。
- 测试失败先读实际错误，不能用跳过或更宽断言掩盖。

**功能依赖**：—  
**DSH 接口**：`sdk-client`  
**回归测试**：`index`、`runtime-baseline`、`runtime-native`（命令见 §7）

### feature-index · 功能索引与一致性校验

**风险：low**。以功能条目关联模块、协议、存储、不变量、测试和 DSH 接口，并生成可检索的开发目录。

**代码与符号**

- [`docs/feature-catalog.json`](feature-catalog.json)<br>`schemaVersion`<br>`features`<br>`integrations`<br>`tests`
- [`scripts/feature-index.cjs`](../scripts/feature-index.cjs)<br>`main`<br>`validateCatalog`<br>`renderIndex`
- [`docs/FEATURE_INDEX_MAINTENANCE.md`](FEATURE_INDEX_MAINTENANCE.md)

**调用链**

- 编辑 feature-catalog.json → npm run index:generate → 提交生成文档 → npm run index:check 防止漂移

**Webview → 扩展**：—  
**扩展 → Webview**：—

**不可破坏的约束**

- 功能 id 稳定，不因文件移动或文案调整改变。
- 登记路径、锚点、消息、功能依赖和测试引用必须可由脚本验证。
- 删除代码功能必须同时处理协议、存储、测试和索引；不能只删 UI。

**功能依赖**：—  
**DSH 接口**：—  
**回归测试**：`index`（命令见 §7）

## 5. 消息与事件协议清单

以下为方向性清单，字段以生产代码中的实际对象为准；新增/删除/改名字段时同时检查生产端、消费端和 DOM 测试。扩展与 Webview 消息不是 DSH JSON-RPC 方法，不能混用。

| 方向 | 类型 | 拥有者/消费位置 |
| --- | --- | --- |
| Webview → 扩展 | `ready` | `src/extension.ts:onDidReceiveMessage` |
| Webview → 扩展 | `fileList` | `src/extension.ts:onDidReceiveMessage` |
| Webview → 扩展 | `sessionList` | `src/extension.ts:onDidReceiveMessage` |
| Webview → 扩展 | `sessionSelect` | `src/extension.ts:onDidReceiveMessage` |
| Webview → 扩展 | `sessionDelete` | `src/extension.ts:onDidReceiveMessage` |
| Webview → 扩展 | `renameSession` | `src/extension.ts:onDidReceiveMessage` |
| Webview → 扩展 | `exportSession` | `src/extension.ts:onDidReceiveMessage` |
| Webview → 扩展 | `modelCatalog` | `src/extension.ts:onDidReceiveMessage` |
| Webview → 扩展 | `modelRoute` | `src/extension.ts:onDidReceiveMessage` |
| Webview → 扩展 | `discoverModels` | `src/extension.ts:onDidReceiveMessage` |
| Webview → 扩展 | `testModel` | `src/extension.ts:onDidReceiveMessage` |
| Webview → 扩展 | `saveCustomProvider` | `src/extension.ts:onDidReceiveMessage` |
| Webview → 扩展 | `deleteCustomProvider` | `src/extension.ts:onDidReceiveMessage` |
| Webview → 扩展 | `providerConfig` | `src/extension.ts:onDidReceiveMessage` |
| Webview → 扩展 | `send` | `src/extension.ts:onDidReceiveMessage` |
| Webview → 扩展 | `resend` | `src/extension.ts:onDidReceiveMessage` |
| Webview → 扩展 | `undoRestore` | `src/extension.ts:onDidReceiveMessage` |
| Webview → 扩展 | `stop` | `src/extension.ts:onDidReceiveMessage` |
| Webview → 扩展 | `new` | `src/extension.ts:onDidReceiveMessage` |
| Webview → 扩展 | `openDiff` | `src/extension.ts:onDidReceiveMessage` |
| Webview → 扩展 | `openLocation` | `src/extension.ts:onDidReceiveMessage` |
| Webview → 扩展 | `rerunTests` | `src/extension.ts:onDidReceiveMessage` |
| Webview → 扩展 | `resume` | `src/extension.ts:onDidReceiveMessage` |
| Webview → 扩展 | `answerQuestions` | `src/extension.ts:onDidReceiveMessage` |
| Webview → 扩展 | `permissionMode` | `src/extension.ts:onDidReceiveMessage` |
| Webview → 扩展 | `openContext` | `src/extension.ts:onDidReceiveMessage` |
| Webview → 扩展 | `manageTrust` | `src/extension.ts:onDidReceiveMessage` |
| 扩展 → Webview | `status` | `media/webview.js:message listener` |
| 扩展 → Webview | `busy` | `media/webview.js:message listener` |
| 扩展 → Webview | `cleared` | `media/webview.js:message listener` |
| 扩展 → Webview | `error` | `media/webview.js:message listener` |
| 扩展 → Webview | `fileList` | `media/webview.js:message listener` |
| 扩展 → Webview | `sessionList` | `media/webview.js:message listener` |
| 扩展 → Webview | `sessionListStatus` | `media/webview.js:message listener` |
| 扩展 → Webview | `sessionDeleted` | `media/webview.js:message listener` |
| 扩展 → Webview | `sessionSelected` | `media/webview.js:message listener` |
| 扩展 → Webview | `sessionRenamed` | `media/webview.js:message listener` |
| 扩展 → Webview | `sessionExported` | `media/webview.js:message listener` |
| 扩展 → Webview | `editorContext` | `media/webview.js:message listener` |
| 扩展 → Webview | `assistantBoundary` | `media/webview.js:message listener` |
| 扩展 → Webview | `assistant` | `media/webview.js:message listener` |
| 扩展 → Webview | `assistantDelta` | `media/webview.js:message listener` |
| 扩展 → Webview | `assistantReasoning` | `media/webview.js:message listener` |
| 扩展 → Webview | `messageSeq` | `media/webview.js:message listener` |
| 扩展 → Webview | `messageCheckpoint` | `media/webview.js:message listener` |
| 扩展 → Webview | `checkpointRestored` | `media/webview.js:message listener` |
| 扩展 → Webview | `user` | `media/webview.js:message listener` |
| 扩展 → Webview | `modelRoute` | `media/webview.js:message listener` |
| 扩展 → Webview | `modelConfig` | `media/webview.js:message listener` |
| 扩展 → Webview | `modelCatalog` | `media/webview.js:message listener` |
| 扩展 → Webview | `modelCatalogStatus` | `media/webview.js:message listener` |
| 扩展 → Webview | `discoverModelsResult` | `media/webview.js:message listener` |
| 扩展 → Webview | `testModelResult` | `media/webview.js:message listener` |
| 扩展 → Webview | `saveCustomProviderResult` | `media/webview.js:message listener` |
| 扩展 → Webview | `deleteCustomProviderResult` | `media/webview.js:message listener` |
| 扩展 → Webview | `providerConfigResult` | `media/webview.js:message listener` |
| 扩展 → Webview | `config` | `media/webview.js:message listener` |
| 扩展 → Webview | `tool` | `media/webview.js:message listener` |
| 扩展 → Webview | `toolResult` | `media/webview.js:message listener` |
| 扩展 → Webview | `testResult` | `media/webview.js:message listener` |
| 扩展 → Webview | `verificationReport` | `media/webview.js:message listener` |
| 扩展 → Webview | `questions` | `media/webview.js:message listener` |
| 扩展 → Webview | `conflict` | `media/webview.js:message listener` |
| 扩展 → Webview | `workspaceTrust` | `media/webview.js:message listener` |
| DSH → SessionRuntime | `request/header` | `src/agent.ts:onNotification` |
| DSH → SessionRuntime | `llm/retry-started` | `src/agent.ts:onNotification` |
| DSH → SessionRuntime | `turn/start` | `src/agent.ts:onNotification` |
| DSH → SessionRuntime | `turn/end` | `src/agent.ts:onNotification` |
| DSH → SessionRuntime | `user/message` | `src/agent.ts:onNotification` |
| DSH → SessionRuntime | `assistant/attempt` | `src/agent.ts:onNotification` |
| DSH → SessionRuntime | `assistant/message` | `src/agent.ts:onNotification` |
| DSH → SessionRuntime | `tool/call` | `src/agent.ts:onNotification` |
| DSH → SessionRuntime | `tool/result` | `src/agent.ts:onNotification` |


**协议修改检查**：验证不可信 Webview 数据；目标操作携带 `sessionId`；保留事件顺序和 delta 边界；历史回放不执行实时副作用；模型/权限/网络变更遵守 Host 边界。

## 6. DSH 外部接口登记

仅登记扩展实际依赖的接口，而不是复制 DSH 全项目目录。修改 DSH 时遵守其 `AGENTS.md`、构建与持久化兼容规范。

### sdk-client

- **位置**：[`./deepseek-harness/packages/sdk/client/src/api.ts`](../deepseek-harness/packages/sdk/client/src/api.ts)<br>`DeepSeekHarness`<br>`HarnessSession`<br>`DeepSeekHarness.start`<br>`DeepSeekHarness.resumeSession`<br>`DeepSeekHarness.listModels`<br>`DeepSeekHarness.listSessions`<br>`DeepSeekHarness.sessionHistory`<br>`DeepSeekHarness.discoverModels`<br>`DeepSeekHarness.testModel`<br>`DeepSeekHarness.saveProvider`<br>`DeepSeekHarness.deleteProvider`<br>`DeepSeekHarness.providerConfig`<br>`HarnessSession.run`<br>`HarnessSession.rewind`
- **用途**：Host 生命周期、目录/历史读取、模型路由、临时模型发现与测试、私密凭据保存、继续会话及原地 rewind。
- **修改边界**：DSH；修改后运行扩展真实集成测试，不假设 npm 包行为等于本地源码。

### sdk-transport

- **位置**：[`./deepseek-harness/packages/sdk/client/src/launch.ts`](../deepseek-harness/packages/sdk/client/src/launch.ts)<br>`resolveDshLaunch`
- **用途**：公开 nodePath 指定普通 Node 子进程，dshBin 选择已编译 CLI，保留 stdio JSON-RPC、超时、审批和关闭。
- **修改边界**：DSH；传输、进程或超时修改需同时验证 Electron 启动和真实模型调用。

### session-controller

- **位置**：[`./deepseek-harness/packages/api/session-controller/src/index.ts`](../deepseek-harness/packages/api/session-controller/src/index.ts)<br>`SessionController`
- **用途**：SDK 精简 profile 中历史、目录与 rewind 所需的 API。
- **修改边界**：DSH；本地补丁，不等同于上游完整 Web profile。

### sdk-profile

- **位置**：[`./deepseek-harness/apps/cli/src/sdk-source.cordis.patch.yml`](../deepseek-harness/apps/cli/src/sdk-source.cordis.patch.yml)<br>`session-controller`
- **用途**：源码启动时注入扩展所需的 SDK profile 插件。
- **修改边界**：DSH；新增插件须检查包依赖、profile 装载顺序与 FiberState 源码启动兼容性。

### session-storage

- **位置**：[`./deepseek-harness/packages/session/session-persistence-jsonl/src/format.ts`](../deepseek-harness/packages/session/session-persistence-jsonl/src/format.ts)<br>`encodeSegment`<br>`projectKey`
- **用途**：会话 JSONL 目录、项目键和删除范围；扩展必须复用相同路径编码。
- **修改边界**：DSH 持久化格式；禁止未经迁移与兼容审查改变已发布数据格式。

### model-providers

- **位置**：[`./deepseek-harness/packages/llm/llm-pi-ai/src/adapter.ts`](../deepseek-harness/packages/llm/llm-pi-ai/src/adapter.ts)<br>`PiAiAdapter`
- **用途**：Kimi 等 pi-ai 模型请求、流式输出、重试错误映射。
- **修改边界**：DSH；模型连接问题先核对实际 Host 代理与请求头，不归因于 Webview。

## 7. 测试矩阵

先 `npm run compile`，然后按修改面选择测试。`quick` 不需要模型或 VS Code；`integration/e2e/probe` 的副作用以表中标记及测试脚本为准。

| ID | 级别 | 模型 | VS Code | 覆盖与副作用 | 命令 |
| --- | --- | --- | --- | --- | --- |
| `runtime-launch` | integration | 否 | 是 | 默认 bundled、公开 SDK nodePath、缺失/损坏拒绝、无 source/tsx 回退、私有补丁、Electron Host 启动与关闭；无凭据模型目录。 | `node scripts/runtime-launch-options-suite.cjs && VSCODE_AGENT_SUITE=runtime-launch-suite.cjs node scripts/vscode-integration.cjs` |
| `quick-session` | quick | 否 | 否 | 多 Session 选择、后台运行、重发目标、读 Host 缓存与网络 Host 边界；未受信任工作区不创建 DSH Host。 | `node scripts/session-runtime-suite.cjs` |
| `quick-webview` | quick | 否 | 否 | Webview 交互、流式滚动、吸顶编辑、模型选择、会话菜单、工具/测试/引用；未受信任工作区的单一引导、控件禁用、信任恢复与对话保留。 | `node scripts/webview-suite.cjs` |
| `quick-checkpoint` | quick | 否 | 否 | 快照、恢复范围、手工修改保护、undo、旧格式与验证解析。 | `node scripts/checkpoint-baseline-suite.cjs && node --input-type=module -e "const {run}=await import('./scripts/checkpoint-suite.cjs'); await run()"` |
| `quick-diff` | quick | 否 | 否 | 编辑器增删改装饰和清理。 | `node scripts/inline-diff-suite.cjs` |
| `quick-delete` | quick | 否 | 否 | 删除目录、投影缓存与失败后的选择恢复。 | `node scripts/session-delete-async-suite.cjs` |
| `quick-export` | quick | 否 | 否 | Markdown 导出内容排序、思考过程折叠、code fence 转义、文件名清洗与长度裁剪。 | `node scripts/session-export-suite.cjs` |
| `integration` | integration | 是 | 是 | 真实 Electron/DSH、路由切换、会话/回滚/删除、上下文、权限、冲突和检查点；直接驱动 Controller，不经过真实 Webview 消息桥。 | `node scripts/vscode-integration.cjs vscode-suite.cjs` |
| `approval` | integration | 是 | 是 | 真实只读沙箱中的单次允许和拒绝；替换客户端请求处理，不覆盖 VS Code 模态框。 | `node scripts/vscode-integration.cjs approval-suite.cjs` |
| `workbench-e2e` | e2e | 是 | 是 | 真实模型/终端 + linkedom 的修复、失败定位、重跑和 Diff；仍绕过真实 Webview 消息桥。 | `node scripts/vscode-integration.cjs workbench-e2e-suite.cjs` |
| `real-project` | e2e | 是 | 是 | 真实 JS 项目修复、测试证据、Git diff 和恢复会话。 | `node scripts/vscode-integration.cjs real-project-suite.cjs` |
| `checkpoint-integration` | integration | 否 | 是 | 在真实 VS Code 工作区执行检查点数据测试。 | `node scripts/vscode-integration.cjs checkpoint-suite.cjs` |
| `diff-integration` | integration | 否 | 是 | 真实 Git 扩展和 HEAD Diff；使用 stage1-fixture 及共享测试配置。 | `npm run compile && node scripts/diff-integration.cjs` |
| `sdk-probe` | probe | 是 | 否 | 最小模型连接和事件观察；使用开发 DSH home，会产生新会话。 | `node --import tsx/esm scripts/sdk-probe.ts` |
| `electron-probe` | probe | 否 | 是 | 仅连接 9333 CDP 并读取 Electron 信息；未使用的 DSH 表达式不会执行，不能作为 Host 验证。 | `node scripts/electron-probe.cjs` |
| `question-probe` | probe | 是 | 否 | 直接 SDK 提问场景与预设答案；观察取消/回答日志，未断言内容，不覆盖 Webview/Broker。 | `node --import tsx/esm scripts/question-fixture.mts` |
| `node-probe` | probe | 否 | 否 | 普通 Node 版本、Electron 排除与 SQLite 可用性。 | `node --import tsx/esm scripts/node-runtime-probe.ts` |
| `index` | quick | 否 | 否 | 索引数据、协议清单、生成文档同步与损坏检测。 | `node scripts/feature-index-suite.cjs` |
| `vsix` | integration | 否 | 是 | 真实 Linux x64 VSIX 文件、依赖、许可证、执行权限、VS Code 隔离安装、无外部 Node 启动、模型目录、错误分类、只读安装与关闭；校验 limited 未受信任工作区声明。测试器强制 --disable-workspace-trust，不能声称实测受限模式；未受信任时不创建 DSH Host 由 quick-session 覆盖，活动栏显示需独立桌面窗口人工验收。--with-model 要求显式 DSH_TEST_CREDENTIAL_SOURCE，仅复制 DeepSeek 账户白名单授权；另验收真实流式对话、文件编辑、原生 Diff、审批、rewind/undo、Session 恢复和删除，扫描归档/安装树/隔离日志的授权值；离线和真实模型证据分别写入 build/vsix-acceptance-offline.json 与 build/vsix-acceptance-model.json。 | `npm run vsix:package && npm run vsix:accept # scripts/vsix-accept.cjs 驱动 scripts/vsix-accept-suite.cjs；真实模型另用 DSH_TEST_CREDENTIAL_SOURCE=<授权 DSH Home> npm run vsix:accept -- --with-model` |
| `runtime-baseline` | quick | 否 | 否 | Node/DSH 精确版本、恢复快照、SDK 生产依赖闭包、原生载荷、发布暂存区和路径拒绝；VSIX 临时副本许可证补齐、精确版本与固定来源哈希；完整构建与 VSIX 安装分别由 B1/D 阶段验证。 | `node scripts/runtime-baseline-suite.cjs && node scripts/runtime-closure-suite.cjs && node scripts/runtime-licenses-suite.cjs` |
| `runtime-native` | probe | 否 | 否 | 固定 Node、SQLite FTS5、glibc flock 和 Landlock 真实行为；原生 tarball 离线安装、权限、哈希与故障拒绝；不覆盖真实 VSIX，要求本机 Landlock 可强制。 | `npm run runtime:native && npm run runtime:install-check && node scripts/runtime-native-suite.cjs --with-install` |
| `runtime-sdk` | probe | 否 | 否 | 固定 Node 启动生产 DSH SDK profile、离线模型目录与 Session 隔离、结构化提问取消/迟到答案保护、缺少 SessionController 的明确启动失败；本地 Messages/SSE 受控服务驱动四个真实 Agent 轮次、历史、fork、rewind、原生提问和重启恢复。辅助模块按基线源码路径与 SHA-256 固定，不进入生产闭包；真实 DeepSeek 账户另用 --controlled、显式 DSH_TEST_CREDENTIAL_SOURCE 与 deepseek-account 路由，仅白名单复制账户授权至 0600 隔离 Home 并在测试后清理；也支持独立 DSH_TEST_API_KEY。 | `node scripts/runtime-sdk-suite.cjs --controlled-mock` |
| `cancel-integration` | integration | 是 | 是 | 真实 Electron/DSH 优雅停止：session/cancel 停止延迟、Host 保活无冷启动、被取消用户消息保留、turn/end reason=aborted 落盘、busy 正确释放。 | `VSCODE_AGENT_SUITE=cancel-integration-suite.cjs node scripts/vscode-integration.cjs` |
| `cancel-probe` | probe | 是 | 否 | 最小优雅停止探针（真实模型，不经 VS Code）：cancel 接受延迟、中断 turn 落盘、用户消息不 rewind、后续消息无冷启动。使用开发 DSH home，会产生新会话。 | `node --import tsx/esm scripts/cancel-probe.ts` |


## 8. 已知覆盖缺口与维护

以下是索引所反映的当前测试边界，不代表已修复问题，也不赋予测试通过超出实际覆盖范围的含义：

- **真实 Webview 消息桥未联通验收**：`webview-suite` 使用 linkedom，`vscode-suite` 直接调用 Controller，`workbench-e2e` 仍是模拟 DOM。`extension.ts:onDidReceiveMessage` 中的 send/resend/权限/删除/问题分发需专门测试。
- **结构化提问**：`QuestionBroker`、Webview 表单和校验没有直接快速测试；`question-fixture.mts` 只是真实 SDK 场景，预设回答不断言具体内容。
- **审批 UI**：真实沙箱测试替换客户端请求处理；DSH→SessionRuntime→VS Code 模态框的允许、拒绝、取消需要单独覆盖。
- **历史与 Diff 跨边界**：Webview 的 `resend.hasCheckpoint` 和 `modelRoute.catalog` 不由扩展消费，扩展必须重新计算权威状态；工具 Diff 未携带前端 activeSessionId，修改时重点检查源 Session 归属与真实桥测试。
- **可恢复状态**：Webview 草稿、未确认模型选择、历史编辑状态、文件引用和滚动位置在真实重载后不恢复；这是当前设计边界，不是持久化能力。
- **其他缺口**：真实代理实现矩阵、Webview 键盘/视觉截图、扩展请求缓存与失效监听、不可信消息载荷和 CSP 的直接测试尚未覆盖。

**覆盖规则**：`src/` 的生产模块必须至少归属一个功能；跨功能模块以各自符号区分职责。
- 功能 ID 和测试 ID 是稳定引用；重命名文件时更新路径，不随意更换 ID。
- 删除功能时同时处理反向依赖、消息、存储迁移/清理、测试与 DSH 修改，详见 [维护指南](FEATURE_INDEX_MAINTENANCE.md)。
- `npm run index:check` 校验数据、路径、符号、协议、设置声明和本文档是否同步；它不替代行为测试。
- 索引中不登记密钥、会话正文、绝对用户路径或临时运行数据。
