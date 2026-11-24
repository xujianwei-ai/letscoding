# DSH 生产依赖闭包与原生载荷

> 对应 [阶段开发计划](RUNTIME_DELIVERY_PLAN.md) 的 A3/B1/B2，三项已完成；本文记录实际产物及检查边界。当前没有构建 VSIX，也没有改变现有开发态启动路径。

## 1. 范围与入口

首批只面向 Linux x64 glibc。编译入口为 `@deepseek-ai/dsh/lib/bin.js`，扩展侧使用 `@deepseek-ai/dsh-sdk-client`，发布 profile 为 `sdk = dsh-base + dsh-sdk-app`。闭包根还包括编译 CLI 实际导入的启动包及 profile 插件，不以 CLI 所有运行模式的生产依赖作为嵌入式 SDK 范围。

```sh
npm run runtime:closure             # 扫描实际暂存区并回填严格清单
npm run runtime:closure -- --check  # 审查后的清单漂移检查，不改写文件
npm run runtime:stage                  # 从真实 tarball 建立独立生产目录，并运行普通 Node 探针
npm run runtime:closure -- --require-built  # 回填实际暂存树的严格逐文件清单
npm run test:runtime-baseline       # 包含闭包和原生缺口的故障注入
```

机器可读结果在 `build/dsh-production-closure.json`；`build/` 和 `.runtime-build/` 不进入 VSIX。闭包绑定 `build/runtime-baseline.json` 的实际源码树及 `pnpm-lock.yaml` 摘要，不能拿另一版 DSH 的包图冒充此基线。

## 2. 闭包规则

1. 从根包递归处理 `dependencies`、必需的 `peerDependencies` 和适用的 `optionalDependencies`。不按目录猜依赖，不把开发依赖加入运行时。
2. 仅由开发依赖提供的 optional peer 不自动进入 VSIX；要随包交付必须由根入口或生产依赖明确声明。
3. workspace 包读取实际 manifest；外部包按 Node 的目录解析规则定位，再以 `name@exact-version` 核对冻结的 pnpm lockfile。相同包名的不同版本分别保留。
4. 检查 CLI 基线包、`sdk` 两个补丁的实际插件引用，以及 A1/A2 登记的原生组件都在闭包内。
5. `sdk` 是扩展唯一发布 profile。B1 的真实打包发现 CLI 的全部生产依赖包含 `private` 实验 bundle，无法合法作为公开 tarball 闭包交付；因此暂存仅保留编译入口、SDK 客户端、两个 bundle 及实际声明的插件闭包，不展开 CLI 的其他模式依赖。
6. 内部包通过 `pnpm pack --config.ignore-scripts=true` 转换 `workspace:*` 为精确版本；外部包通过 `npm pack --ignore-scripts` 遵守其发布规则。所有 tarball 解包到 `.runtime-build/dsh/node_modules/<name>`，不复制嵌套 `node_modules`、pnpm 链接或开发目录。

## 3. 原生载荷实际状态

来源为 `native/system/packages/entry/node_modules/@deepseek-ai/node-addon-system-linux-x64/prebuilds.json`，版本为 `0.1.2`。

| 文件 | 类型 | 当前状态 |
| --- | --- | --- |
| `bin/glibc/system.node` | Node-API v8 flock，glibc | 已构建；在固定 Node 中验证两个文件描述符互斥、EAGAIN 和关闭后重新获取 |
| `bin/landlock-run` | static-musl Landlock 启动器 | `--probe` 在本机返回 partial；拒绝写入、授权写入、子进程继承和无效授权路径失败关闭均通过 |
| `bin/musl/system.node` | Node-API v8 flock，musl | ELF、Node-API 导出、SHA-256 和包安装完整性通过；不在 glibc 主机上加载，musl 行为尚未支持 |

当前缺失被记录在 `missing` 中，`--require-built` 必须使缺失项成为失败。正式命令默认扫描实际暂存区，缺失时给出构建命令；`--package-preview` 仅供包图测试，不作为发布验收。

## 4. 路径、文件与排除规则

- 清单中的 `source` 仅是构建审计用仓库相对路径，安装路径只能是 VSIX 内相对路径。B1 创建暂存区后必须重新扫描真实发布载荷。
- `lib/`、`bin/`、`dist/` 内不得有符号链接；其他发现仅记录，不表示允许进入包。严格文件清单要求常规文件、包内实际路径和无逃逸。
- 排除开发依赖、源码构建缓存、`.git`、`.agents`、会话、profile、凭据、日志、测试源文件及其他 OS/CPU 的 optional 原生包。
- DSH 包的 `files` 可能合法包含类型声明或少量公开源码导出，不能简单删除所有 `.ts` / `.d.ts`。使用 DSH 自己的 `pnpm pack` 规则和许可证清单。
- 第三方已发布包可能包含编译后的测试文件。它们是实际发现，不在生成器里静默改写上游内容；B1 要测量、审查并决定安全裁剪，最终在 D6 的 VSIX 检查中复核。

## 5. B1 暂存与严格清单

`runtime:stage` 从已构建源码快照计算 227 个包版本节点（45 个外部依赖），依次验证原生载荷、打包、解包、排除非发布文件，并以固定 Node 24.9.0 运行 CLI `--version` 和 SDK 客户端导入。只有探针通过才原子替换 `.runtime-build/dsh`。

`--require-built` 扫描实际暂存树，逐文件记录相对路径、字节数、SHA-256 和权限；每个文件归属一个已登记包，禁止符号链接、workspace/file 依赖和开发机路径。当前 8,982 个文件中 8,980 个属于包，另两个是根元数据；包文件为 74,425,949 bytes，含元数据总量为 74,446,529 bytes。暂存树不是压缩包，`packedBytes` 保持 `null`；VSIX 压缩体积由 A4/D1 测量。

第三方 tarball 可能包含硬链接。解包后物化为普通文件，并验证目标存在、路径不逃逸；不保留符号链接。Zod 等上游发布包携带的 benchmark/test 文件按统一排除规则仅删除暂存副本，不修改第三方源缓存。

B1 修复了 SDK client/protocol/server 的 `files`：tsdown 输出多个相对运行时模块，不能只发布 `lib/index.js`。普通 Node 导入测试防止这一遗漏复发。

## 6. B2 原生能力与安装权限

`npm run runtime:native` 在完整暂存区运行 `scripts/runtime-native-probe.mjs`：固定 Node `v24.9.0`、无 Electron、无 `ELECTRON_RUN_AS_NODE`，通过公开的 `SqliteSessionQueryEngine` 创建 schema 8 的临时数据库，再执行 FTS5 写入、查询与重开持久化检查；原生文件逐一与 B1 清单的 SHA-256 比对。

本机为 x86-64、glibc 2.35，Landlock 为 `partial`。这不是跳过或降级为可用性的猜测：探针确认越权写入没有落盘，即使子进程中的包装命令退出 0；授权目录写入成功，无效授权路径以 125 拒绝执行。没有可强制 Landlock 的主机不能让该交付检查通过。

`npm run runtime:install-check` 使用 npm pack/pnpm pack 的两个真实原生 tarball，在临时消费者中执行 `npm install --offline --ignore-scripts`，与暂存载荷比对哈希，并驱动复制后的固定 Node 再次验证 flock/Landlock。原生包无安装期编译或生命周期脚本回退。测试 SQLite、锁与隔离文件全部位于临时目录并清理，不修改暂存区。

`node scripts/runtime-native-suite.cjs --with-install` 另外注入错误 Node、缺失/不可执行的 Landlock 和损坏的 glibc addon，确认正式探针拒绝这些状态。完整安装报告在 `build/runtime-install-report.json`，暂存行为报告在 `build/runtime-native-report.json`；均为本地生成证据，不提交、不进入 VSIX。

## 7. 已知限制

- DSH `build:artifacts` 的 8 个门全部通过，生成 368 个客户端工件；`build:check` 的 client 聚合通过，但 host 聚合仍有上游测试与接口不同步错误（缺少 `rewind`、私有 `sessions` 访问、品牌类型等）。发布编译通过不能替代该检查，未在本任务中修改测试掩盖问题。
- A4/D6 仍须检查真实 VSIX，而非只检查 JSON。凭据、模型连接和现有扩展启动行为不在本轮修改范围内。
- 本地完整 Node 头文件、pnpm 和 musl 工具仅在 `.runtime-build/tools` / `node-build` 用于构建；这些开发工具不进入运行时或 VSIX。
