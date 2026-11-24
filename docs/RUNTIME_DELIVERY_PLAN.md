# 独立运行时与一键安装阶段开发计划

> 状态：A、B、C、D 阶段已完成（2026-11-16）。Linux x64 的真实 VSIX 已通过隔离离线安装、真实 DeepSeek 账户核心工作流和安全审计；本文记录阶段结论，长期功能规范仍以 [工程功能索引](FEATURE_INDEX.md) 为准。

## 1. 目标与当前决策

把当前依赖开发机环境的扩展，改造成可独立安装、独立启动的 VS Code 扩展。首批交付只支持 **Linux x64**，通过一个 VSIX 同时携带扩展代码、普通 Node ≥24.9、DSH 编译产物及所需生产依赖。

**现阶段暂停新增业务功能。** 只处理运行时交付、阻断现有功能的缺陷和必要的安全修复；索引维护、运行时回归测试属于本阶段工作，不算新增功能。

完成标准不是“能生成 VSIX”，而是：**在干净 Linux x64 用户环境中，没有外部 Node、没有 DSH 源码、没有开发依赖，安装 VSIX 后仍能完成核心工作流。**

### 一键安装的范围

- 包括：Node 运行时、DSH 运行时、所需 profile/补丁、原生组件和扩展自身依赖。
- 不包括：模型账号登录、凭据配置、模型服务联网和项目所需的 Python/Java 等业务工具。这些不能也不应伪装成扩展已解决的环境问题。
- 本阶段不做首次启动联网下载运行时；构建期准备和校验运行时，安装后离线启动 Host。
- bundled 模式默认复用 `DSH_HOME` 或 `~/.dsh` 中已有的 DSH 登录态和会话，不把账户凭据复制进 VS Code 设置或 VSIX。显式 `privateCodingAgent.dshHome` 可指定其他目录；测试仍通过 `DSH_AGENT_HOME` 使用隔离目录。空模型目录必须提示登录或配置模型，不能误报为 VSIX 缺少模型声明。
- 本阶段不承诺 macOS、arm64、Windows；平台扩展必须在现有独立运行时边界上增量实现，不重新引入业务耦合。

## 2. 当前问题与目标状态

当前 `package.json` 通过 `file:` 引用相邻 DSH monorepo，`.vscodeignore` 排除 `node_modules`，而 `src/runtime.ts` 在 Electron 中要求外部普通 Node 和 DSH TypeScript 源码，并通过 `tsx` 启动。它适合联合开发，但不能作为独立发布路径。

| 项目 | 当前开发态 | 本阶段发布态 |
| --- | --- | --- |
| Node | 搜索 `DSH_NODE_PATH`、系统路径和 `PATH` | 使用 VSIX 内固定版本的普通 Node |
| DSH | 优先 `apps/cli/src/bin.ts` 和 `tsx` | 只启动随包交付的编译后 JS 入口 |
| 依赖 | 本地 monorepo / workspace | 明确的版本和完整生产依赖闭包 |
| profile | 源码补丁和运行时生成补丁 | 受控的发布补丁，路径可定位且可重复构建 |
| 可写文件 | 部分写入扩展目录 `.runtime` | 写入 VS Code `globalStorageUri` 下的专用目录 |
| 失败行为 | 提示安装 Node 或设置源码目录 | 明确报告内置组件缺失/不兼容；不偷偷切换源码启动 |
| 开发模式 | 隐式源码优先 | 显式开发配置；发布模式默认且独立于源码仓库 |

扩展仍由 Webview、Controller、SessionRuntime 和独立 DSH 子进程组成。**不把 DSH 强行放进 Extension Host，不改变现有 Session、检查点、模型路由和 Webview 协议。**

## 3. 需要固定的技术决策

### 3.1 发布包边界

建立可复现的 DSH 生产运行时，而不是复制整个 monorepo 或现有开发机 `node_modules`。交付清单至少包括：

- 编译后的 CLI/SDK 入口及声明依赖；
- SDK profile 所需的全部 Cordis 插件与补丁；
- `node-addon-system` 当前 Linux x64 对应的原生载荷和可执行权限；
- 包版本、来源提交、Node 版本、平台和依赖锁定信息；
- 必需的许可证与第三方声明。

禁止以“本机能运行”为理由包含源码、测试、浏览器开发工具、缓存、日志、凭据或其他无关插件。最小闭包由 SDK profile 和实际启动/会话验证确定，不手工猜测依赖列表。

### 3.2 启动方式

设计两个显式模式：

- `bundled`：发布默认模式。解析扩展安装目录中的 Node 和 DSH 编译产物；不读取 `developmentRepository()`，不需要 `tsx`。
- `source`：仅开发使用。显式指定 DSH 仓库和可选外部 Node，用于联合调试。它不能成为内置运行时失败后的静默回退。

优先在 DSH SDK 提供受支持的普通 Node 可执行文件/启动描述配置，替代 `createHarness()` 中的私有构造器类型断言。若确需修改 DSH，先读其 `AGENTS.md`、架构、防御性设计和测试规范；只改 SDK 启动 seam，不顺手改变模型、会话格式或工具行为。

### 3.3 文件、数据与权限

- VSIX 内运行时按只读资源处理；不得假设扩展安装目录可写。
- 动态 YAML、日志、凭据、会话和检查点分别使用明确的可写位置；扩展生成的补丁迁入 `globalStorageUri`。
- 保持 DSH home、会话 JSONL 和检查点的已有归属与兼容策略；不因打包清空或迁移用户数据。
- 工作区文件操作仍受现有权限、审批和路径范围约束；内置 Node 不是绕过沙箱或工具审批的通道。
- 不把代理认证 URL、API Key、Cookie 或私有会话内容写进构建清单、安装包或日志。

## 4. 实施阶段与任务顺序

以下任务以依赖顺序排列；标记“可并行”的工作可同时进行，但合并前必须分别验证。每项完成后更新本文状态及实际验证结果。

### 阶段 A：发布基线与依赖清单 · 已完成

**目标：先把交付事实写清楚，再改启动代码。**

- [x] A1 确定 Node 的精确版本、官方来源、SHA-256 和 Linux x64 二进制许可；构建期下载/缓存并校验，不在用户首次启动时下载。
- [x] A2 确定 DSH 版本或提交、构建命令、SDK 入口、profile 和补丁清单；保证同一输入能重复生成同一运行时清单。
- [x] A3 生成 SDK 生产依赖闭包和原生组件清单，记录暂存体积、路径、权限和排除项；暂存区没有指向开发机的绝对路径或逃逸符号链接。VSIX 内复核仍归 A4/D6。
- [x] A4 在真实 VSIX 检查中覆盖 `.vscodeignore`、SDK 生产依赖和第三方许可证，而不只检查 `out/` 是否生成。

**完成条件**：有可审查的运行时物料清单；可以解释每个随包组件的来源、用途和平台限制。

### 阶段 B：DSH 与 Node 交付能力 · 已完成

**目标：得到两个独立可检查的组件，不提前改动业务层。**

- [x] B1 构建 DSH 编译产物、建立发布暂存区并回填严格产物清单；通过普通 Node 直接启动编译入口，不需要源码目录和 `tsx`。
- [x] B2 检查内置 Node 的版本、Electron 排除语义、`node:sqlite` 和 DSH 所需原生能力；暂存区与原生 tarball 离线安装已验证执行位保留，真实 VSIX 安装后的复核归 D1/D2。
- [x] B3 验证 SDK profile 对模型目录、SessionController、历史、rewind 和结构化提问的支持，发现缺失插件时显式失败。
  - [x] 2026-11-15：固定 Node 24.9.0 启动 `.runtime-build/dsh` 编译 SDK；离线模型路由、空 Session 隔离、`user-question/ask` 取消与 AbortSignal、迟到答案忽略、缺少 `sessionController` 时明确启动失败均已通过。
  - [x] 2026-11-16：本地受控模型闭环通过 `npm run runtime:sdk -- --controlled-mock`。真实 SDK、Agent Loop、Messages HTTP/SSE 和持久化执行 4 个完成轮次、5 次模型请求和 1 次原生提问；验证历史边界、fork 不含后续轮次、rewind 删除目标及后续输入、重启恢复后继续轮次，以及恢复请求不含已 rewind 内容。报告：`build/runtime-sdk-controlled-mock-report.json`。
  - [x] 真实外部供应商的同一流程：`npm run runtime:sdk -- --controlled` 已通过，使用 `deepseek-account/deepseek-flash` 完成四个真实模型轮次、流式事件、历史、fork、rewind、原生结构化提问与重启恢复。
    - 用户授权显式指定现有 DSH Home 为凭据源；仅复制 DeepSeek 的账户 grant 与 device 记录到测试隔离 Home，权限为 `0600`。OAuth grant 不是 API key，不伪装为 `DEEPSEEK_API_KEY`；原凭据不修改，测试结束后连同隔离 Home 和会话全部删除。
    - 入口要求显式指定 `DSH_TEST_CREDENTIAL_SOURCE` 与 `DSH_TEST_PROVIDER=deepseek-account`，不自动发现或复制账户；也可使用独立 `DSH_TEST_API_KEY`。报告不含凭据值、token、cookie 或账户目录。
- [x] B4 为 SDK 启动 seam 增加必要测试，证明指定 Node 后不再使用 `process.execPath` 启动 Electron；上游 13/13 测试及真实 Electron 的模型目录、空会话、stdio 和关闭语义均通过。

**完成条件**：在扩展之外，以随包目录和固定 Node 完成无模型启动检查，以及一次受控模型/SDK 探针；产物不引用开发仓库。

### 阶段 C：扩展启动切换 · 已完成

**目标：发布模式不再依赖开发机。**

- [x] C1 分离 Node 定位、DSH 产物定位、补丁生成和 Host 启动职责；`host-launch` 仍是索引功能 ID。
- [x] C2 默认走 `bundled`，显式开发配置才走 `source`；取消发布路径对 `dshRepository`、相邻目录、源码入口和 `DSH_NODE_PATH` 的必需依赖。
- [x] C3 将运行时生成的补丁移到 `globalStorageUri`，保持内容哈希、私有权限、并发创建和重复启动行为。
- [x] C4 保持 `direct/system/proxy`、模型逐轮 route、按 Session Host、只读/写 Host 和空闲时重建语义不变。
- [x] C5 更新诊断文案：区分内置 Node 缺失、原生组件不兼容、DSH 启动失败、模型网络超时；网络错误不得再提示安装 Node。
- [x] C6 为路径缺失、损坏运行时、重复启动和开发/发布模式隔离增加最小测试，不允许发布失败时静默回退到源码。`npm run test:quick` 和 B4 Electron 验收通过。

**完成条件**：临时移开/隐藏相邻 DSH 仓库并清空外部 Node 查找路径后，开发中的扩展仍能通过内置组件启动；`npm run test:quick` 通过。

### 阶段 D：VSIX 与干净环境验收 · 已完成

**目标：验证实际安装产物，而非开发工作区。**

- [x] D1 添加可重复的打包/内容检查入口，记录 VSIX 名称、版本、大小、文件清单和构建环境。
- [x] D2 使用隔离的 VS Code 用户数据、扩展目录、DSH home 和临时工作区安装 VSIX；不继承开发机 Node、DSH 仓库或凭据。
- [x] D3 无模型验收：扩展激活、Webview 加载、内置 Node 启动、模型/Host 错误分类、隔离环境关闭。运行中停止和界面销毁语义沿用既有 Electron 套件，不由当前 VSIX 脚本重复声明。
- [x] D4 使用单独提供的测试凭据验收：真实账户模型目录、发送与流式输出、会话切换、历史恢复、工具审批、文件修改和原生 Diff。
- [x] D5 验收历史重发、受影响文件预览、回滚与 undo、控制器重建后的 Session 恢复、删除非活动 Session；运行中任务归属沿用既有生命周期回归。
- [x] D6 检查安装目录无运行时写入，归档/安装树/日志无授权材料，VSIX 无源码仓库依赖、开发依赖、测试数据或本机路径。

**最终交付物（2026-11-16）**：

- 文件：`letscoding-0.0.1-linux-x64.vsix`，Linux x64 glibc。
- Node `24.9.0`，DSH `0.2.2-rc.1`，`@vscode/vsce@4.1.1`。
- 归档大小 `144,031,214 bytes`；解包后 `439,052,539 bytes`；17,891 个文件。
- SHA-256：`e5daee686e982e43dd87a211882421e86c1c366a46db8a603bb5384875beb668`。
- 严格清单：`build/vsix-package.json`；离线证据：`build/vsix-acceptance-offline.json`；真实模型证据：`build/vsix-acceptance-model.json`。
- 真实模型验收覆盖流式 delta、文件修改、检查点与原生 Diff、恢复预览、同 Session rewind/resend、undo、切换/删除非活动 Session、控制器重建后续聊、只读模式切换，以及 read-only 下的拒绝和允许一次审批。
- 安全扫描使用隔离凭据的敏感字段值，先验证扫描器能够命中临时探针，再扫描 VSIX 归档、安装树、VS Code 用户数据/日志、globalStorage、工作区和隔离 DSH Home（仅排除显式凭据文件）；不保存敏感值或日志正文。
- 安装前后安装树的路径、大小和权限完全一致。验收中的 Node 搜索路径为不存在的目录，且删除 `DSH_NODE_PATH`；不需要外部 Node 或相邻 DSH 源码。
- 已知范围：首批只支持 Linux x64 glibc；本机是 glibc 2.35。模型登录、联网和项目业务依赖仍由用户环境负责；不把本结果推广到其他平台或 musl。

**完成条件**：以下命令及真实 VSIX 安装清单全部通过，结果和未覆盖项写回本文：

```sh
npm run test:quick
npm run test:vscode
npm run test:approval
npm run test:workbench-e2e
npm run runtime:native
npm run runtime:install-check
node scripts/runtime-native-suite.cjs --with-install
npm run runtime:sdk
npm run vsix:package
node scripts/vsix-security-suite.cjs # 已包含在 test:quick 中
npm run vsix:accept
DSH_TEST_CREDENTIAL_SOURCE=<授权的 DSH Home> npm run vsix:accept -- --with-model
npm run runtime:sdk -- --controlled # 需显式 DSH_TEST_API_KEY，或授权凭据源配合 DSH_TEST_PROVIDER=deepseek-account
```

若修改 DSH 会话、事件或持久化 seam，还必须按 DSH 规范运行对应单元、构建、快照/双 SDK 检查；不能用扩展测试替代上游验证。

### 阶段 E：发布收尾与恢复功能开发 · 待开始

- [ ] E1 将实际脚本、产物布局、配置项、已知限制和安装故障处理补入功能索引与使用文档。
- [ ] E2 固定升级策略：扩展版本如何绑定 DSH/Node，旧版数据如何保留，损坏安装如何诊断，不在线替换运行中的 Node。
- [ ] E3 在全新环境复验一次最终 VSIX，确认和开发态测试结果一致。
- [ ] E4 由用户确认首批 Linux x64 交付后，解除“暂停新增功能”的限制。

**阶段退出条件**：一键安装不是文档承诺，而是已有可重复的 VSIX 构建、干净环境安装证据和核心回归结果。之后才规划其他平台、平台包体积优化或可选的自动下载机制。

## 5. 验证分层与禁止事项

| 层级 | 要证明的事实 | 不足以证明的事实 |
| --- | --- | --- |
| `test:quick` / 启动单测 | 模式选择、路径、错误与既有状态边界 | 真实 VSIX 包含所有依赖 |
| DSH 构建与 SDK 探针 | 编译入口、SDK 插件和指定 Node 可用 | Extension Host 中可用 |
| Electron 集成 | 扩展、子进程、模型和会话链路可用 | 离开源码仓库仍可安装运行 |
| VSIX 内容检查 | 文件、权限、版本、依赖和许可证完整 | 用户工作流正确 |
| 隔离安装 + 真实模型 | 无开发环境的用户可完成核心流程 | 其他 OS/CPU 已支持 |

本阶段明确禁止：

1. 为赶进度把整个 DSH monorepo、`.git`、缓存或全部 `node_modules` 直接装入 VSIX。
2. 在 Electron 中直接运行 DSH，或通过 `ELECTRON_RUN_AS_NODE` 冒充支持的普通 Node。
3. 发布模式自动寻找相邻源码、静默使用 `tsx`，或在失败时改用用户任意版本的 Node。
4. 用新增运行时全局状态改变 Session 归属、模型路由、检查点、文件恢复和审批规则。
5. 把模型登录、网络服务、项目业务依赖失败误报为扩展安装失败。
6. 仅凭索引校验、TypeScript 编译或本机开发启动宣称“一键安装完成”。

## 6. 计划维护与恢复开发的判据

- 每个任务实现前，在 [工程功能索引](FEATURE_INDEX.md) 阅读 `host-launch`、`session-lifecycle`、`model-routing`、`history-resend`、`checkpoints`、`approval` 和 `test-infrastructure` 的约束。
- 代码入口、协议、存储、DSH seam 或测试发生变化时，同步 `feature-catalog.json`，运行 `npm run index:generate` 和对应测试；不要手工编辑生成的索引。
- 本文只记录当前阶段目标、任务状态、最终产物和验证结果。已完成的历史修复不堆积到本文，长期功能规范仍归功能索引。
- **恢复新增功能的最低判据**：阶段 D 完成、最终 VSIX 干净安装通过、已有快速回归通过、已知限制明确，并获得用户确认。
- 若内置运行时阻塞严重，可暂停具体任务并记录证据；不得用继续堆功能替代交付问题，也不得为通过测试削弱现有安全约束。

## 7. 当前状态

- 当前阶段：A、B、C、D 已完成，下一阶段为 E（发布收尾、升级策略和用户交付确认）。详见 [运行时基线](RUNTIME_BASELINE.md) 和 [闭包与原生载荷](RUNTIME_CLOSURE.md)。
- 已确认：优先整理运行时；首批 Linux x64；Node/DSH 随 VSIX 交付；保留显式源码开发模式。
- 已固定：Node `24.9.0` 官方包与双重 SHA-256 校验；DSH `0.2.2-rc.1` 本地联合开发快照、`pnpm@11.28.5`、构建命令、编译入口、sdk profile 与补丁。
- 已验证：独立 Node 的版本、非 Electron、SQLite、执行权限和许可证；DSH 生产构建和暂存探针通过，源码漂移和路径拒绝有回归覆盖。
- B1 已生成：`.runtime-build/dsh` 平面生产目录，227 个包版本节点、45 个外部依赖；严格清单记录 8,982 个文件、74,425,949 bytes、权限和 SHA-256，3 个 Linux x64 原生载荷无缺失。
- B1 构建边界：`scripts/build.ts --scope artifacts` 通过 8/8 门；`--scope check` 被上游 host 测试 `SessionHandle.rewind` 等类型漂移阻断，详见 `RUNTIME_CLOSURE.md`，未改写上游测试掩盖问题。
- B2 已验证：固定 Node v24.9.0、非 Electron、SQLite schema 8/FTS5 持久化、glibc flock 互斥/释放、Landlock 拒绝/授权/子进程隔离和失败关闭；本机 Landlock 为 `partial`。原生 tarball 离线 npm 安装和复制 Node 保留哈希与执行位，故障注入回归通过。
- B3 已验证：无模型目录/隔离/协议/故障拒绝，以及本地受控模型 turn、历史、fork、rewind、结构化提问和恢复。临时 `HOME`、`DSH_HOME`、工作区在套件结束时清理；不记录密钥，不读取现有登录态。
- 本轮最终自检：`npm run test:quick`、`npm run vsix:accept`、`DSH_TEST_CREDENTIAL_SOURCE=/home/shang/.dsh npm run vsix:accept -- --with-model` 均通过。`--keep` 仅用于保留隔离环境供审计，完成后删除隔离凭据、日志和会话。
- 普通安装修复（2026-11-16）：原先 bundled 模式把 VS Code 私有存储误作默认 DSH Home，已有 `~/.dsh` 登录态不会自动生效，模型目录为空。现在默认依次使用 `DSH_HOME`、`~/.dsh`，显式设置和测试隔离保持不变；空目录错误提示包含登录和配置指引。真实 VSIX 验收不再通过 `DSH_AGENT_HOME` 掩盖此路径，而是在隔离 `HOME/.dsh` 中验证默认行为。修复包 SHA-256 为 `1ee54fe44f0acd1607941f37dc908da564d711c629710194a2ebd09f9feb1118`，大小 `144031643` bytes；默认 Home 的真实账户完整工作流和 18,036 个文件凭据扫描均通过。
- 下一项任务：E1 整理安装/升级使用文档，E2 固定升级策略；阶段 D 不承诺 macOS、Windows、arm64 或 musl。
