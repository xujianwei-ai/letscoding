# 运行时基线：Node 与 DSH

> 对应 [阶段开发计划](RUNTIME_DELIVERY_PLAN.md) 的 A1/A2。这里固定构建输入，不代表 VSIX、完整 DSH 构建或干净环境安装已经完成。

## 1. 已固定的输入

| 输入 | 固定值 | 验证范围 |
| --- | --- | --- |
| 平台 | Linux x64，首批 glibc | 其他平台和 musl 尚未支持 |
| Node | `24.9.0`，`https://nodejs.org/dist/` | 下载包 SHA-256、官方 `SHASUMS256.txt`、实际版本、非 Electron、`node:sqlite`、许可证和执行权限 |
| Node 包 | `node-v24.9.0-linux-x64.tar.xz` | `f52ec50e959d72d5c680d9731420b2661cd2a8070e94c7369b6ddfcd8b7278be` |
| DSH 包版本 | `0.2.2-rc.1` | 与根包、CLI、SDK 和 profile 包 manifest 交叉核对 |
| DSH Git 基线 | `4eb8aa00b4dbf7319a9fbb1e5bfde6f6a9bc4e53`，`master` | 当前工作区有未提交修改，不能只凭 commit 重建 |
| DSH 内容基线 | `treeSha256=560868079828811730754e25924731518468ecd37d34bf42207666081f249bcb` | 20,662 个源码/配置文件逐文件 SHA-256，含明确纳入的未跟踪构建配置 |
| 包管理器 | `pnpm@11.28.5` | 根 `package.json` 与本地 pnpm manifest 必须一致；不使用当前全局 `pnpm@12.16.1` |
| 构建工具 | TypeScript `6.0.3`、tsx `4.23.13`、tsdown `0.22.2` | 从 DSH 本地 manifest 读取并写入生成清单 |
| 原生组件 | `node-addon-system[-linux-x64]@0.1.2` | 版本、载荷、SHA-256 与执行权限已固定；glibc flock、SQLite 和 Landlock 行为已通过 B2 |

完整、机器可读的静态输入见 [`config/runtime-baseline.json`](../config/runtime-baseline.json)。当前源码、工具链、profile 和逐文件摘要由命令生成到 `build/runtime-baseline.json`；该目录及 `.runtime-build/` 不提交、不进入 VSIX。

## 2. DSH 构建与启动清单

在 DSH 仓库根目录执行以下命令。依赖安装要求已有与 lockfile 一致的 pnpm 离线缓存；缓存不全时先由维护者显式联网准备依赖，不能把 `--offline` 删除后仍声称结果相同：

```sh
node node_modules/pnpm/bin/pnpm.cjs install --frozen-lockfile --offline
node node_modules/tsx/dist/cli.mjs scripts/build.ts --scope artifacts
node node_modules/tsx/dist/cli.mjs scripts/build.ts --scope check
```

后两条与 DSH 根 `build:artifacts` / `build:check` 脚本对应，但显式使用本地 tsx，避免全局工具漂移。它们登记为后续 B 阶段的构建命令，本轮没有运行完整构建。

| 项目 | 固定选择 |
| --- | --- |
| 发布入口 | `apps/cli/src/installed-bin.ts` → `apps/cli/lib/bin.js`，配置为 `apps/cli/tsdown.config.ts` |
| 开发入口 | 先构建 `apps/cli/lib/bin.js`，由普通 Node 执行；仅显式源码模式叠加源码补丁，扩展不加载 tsx |
| profile | `sdk`：`@deepseek-ai/dsh-base` + `@deepseek-ai/dsh-sdk-app` |
| profile 来源 | `packages/util/official-bundles/src/bundles.ts` 中 `PROFILE_TEMPLATES.sdk` |
| profile 补丁 | `packages/bundle/base/cordis.patch.yml`、`packages/bundle/sdk-app/cordis.patch.yml` |
| 源码附加补丁 | `apps/cli/src/sdk-source.cordis.patch.yml`；只在源码模式使用 |
| 编译模式控制器 | `sdk-app/cordis.patch.yml` 已登记 `session-controller`；不额外叠加源码补丁 |
| 动态补丁 | 源码补丁直接引用仓库固定文件，不复制 `session-controller`；Web 模型声明只读、不含密钥，并写入 `globalStorageUri/runtime-patches` |

## 3. 本地联合开发快照

当前 DSH 有未提交修改且没有 `origin` 远程，所以本次基线明确采用 `local-git-worktree-snapshot`，**不声称某个公开 commit 已包含这些修改**。

`npm run runtime:baseline` 执行以下工作：

1. 使用 `git ls-files` 获取已跟踪文件；额外纳入未忽略的 `tsdown.config.ts`，覆盖目前三个 SDK 的未跟踪构建配置。
2. 排除 `.git`、`node_modules`、构建输出、`.env`、Python 缓存和测试生成目录；仓库内符号链接记录其目标，逃逸链接直接拒绝。
3. 在 `.runtime-build/dsh-source-snapshot.tar.gz` 生成恢复快照；包含源码，不包含依赖、凭据或 Git 历史，**不是 VSIX 内容**。
4. 在 `build/runtime-baseline.json` 记录 commit、dirty 状态、工具版本、入口、补丁摘要和逐文件哈希。

恢复快照时，先解压到隔离目录，再按其中 `packageManager`/lockfile 安装依赖并运行上述构建命令。快照文件及 `build/` 的本地绝对路径仅用于开发机定位，不得复制进发布包。

## 4. 维护入口

在 `vscode-coding-agent/` 执行：

```sh
npm run runtime:baseline          # 审查源码变化后，重新生成 DSH 清单和快照
npm run runtime:baseline -- --check  # 只检查漂移；失败时不改写已审查清单
npm run runtime:node              # 构建期下载/缓存、双重校验、解压和探测 Node
npm run runtime:native          # 完整暂存区 SQLite/flock/Landlock 真实行为验证
npm run runtime:install-check   # 原生 tarball 离线 npm 安装、执行权限与固定 Node 验证
node scripts/runtime-native-suite.cjs --with-install  # 原生损坏拒绝及安装回归
npm run test:runtime-baseline     # 临时 Git 仓库的重复生成、变更拒绝和路径安全测试
npm run test:quick                # 包含 --check 和基线回归，不重新下载 Node
```

`runtime:node` 只写入 `.runtime-build/`，不修改系统 Node 或 VS Code 配置。下载失败、校验不符或探测失败均明确报错；已验证的缓存可以离线复用。

变更 Node、DSH、构建工具、入口、profile 或原生组件时，必须先更新锁定文件和本说明，再审查生成差异。不能用更新哈希替代代码审查。

## 5. 本轮验证与未完成项

已实际通过：

- `npm run runtime:baseline` 及 `npm run runtime:baseline -- --check`。
- `npm run runtime:node`：官方包下载、SHA-256 与官方清单一致；解压后为 `v24.9.0`、`Electron=null`、`DatabaseSync=function`。
- `npm run test:runtime-baseline`：验证精确版本、官方 HTTPS、相对路径、未跟踪构建配置纳入、重复生成稳定、输入变化拒绝、外部符号链接拒绝和实际快照哈希。
- `npm run test:quick`、`npm run runtime:closure -- --require-built` 和 `npm run index:check`：严格产物清单及扩展快速回归通过。

尚未完成：

- A4 真实 VSIX 内容、许可证和执行权限验证；B1 暂存区审查不能替代安装后复核。
- B2 已完成；本机 Landlock 为 `partial`，真实隔离行为已通过，细节见 [闭包与原生载荷](RUNTIME_CLOSURE.md)。
- B3 模型目录、Session 与 SDK 功能验收；B1 已完成生产构建、CLI 启动和客户端导入。
- C/D 扩展启动切换、VSIX 安装及无开发环境验证。
