# Coding Agent 扩展

VS Code 侧栏 AI 编程助手，基于 DeepSeek Harness (DSH) 运行时。

## 项目结构

```
vscode-coding-agent/          # 扩展根目录
├── src/                      # TypeScript 源码
│   ├── extension.ts          # 入口：激活、Webview、消息路由
│   ├── agentController.ts    # 控制器：多 Session 管理
│   ├── agent.ts              # SessionRuntime：单会话运行时
│   ├── runtime.ts            # Host 启动：Node/DSH 进程
│   ├── checkpoints.ts        # 检查点：文件快照与恢复
│   ├── context.ts            # 编辑器上下文捕获
│   ├── inlineDiff.ts         # 内联 Diff 渲染
│   ├── diff.ts               # Git Diff 打开
│   ├── conflicts.ts          # 外部修改冲突检测
│   ├── verification.ts       # 测试结果追踪
│   ├── diagnostics.ts        # 错误分类与诊断
│   ├── approval.ts           # 工具审批
│   ├── questions.ts          # 结构化提问
│   ├── sessionCatalog.ts     # 会话目录
│   └── modelRouting.ts       # 模型路由
├── media/webview.js          # Webview 前端
├── scripts/                  # 构建与测试脚本
├── docs/                     # 文档
│   ├── features/             # 功能开发文档（本目录）
│   └── FEATURE_INDEX.md      # 功能索引（自动生成）
└── .runtime-build/           # 打包时生成的 Node/DSH 闭包

../dsh-learning/deepseek-harness/  # DSH 运行时（独立项目）
```

## 快速开始

```bash
cd vscode-coding-agent

# 安装依赖
npm install

# 编译
npm run compile

# 快速测试（无模型/VS Code）
npm run test:quick

# 打包 VSIX
npm run vsix:package

# 安装到 VS Code
code --install-extension letscoding-0.0.5-linux-x64.vsix --force
```

## 功能开发文档

| 功能 | 文档 | 说明 |
|------|------|------|
| 扩展激活与视图 | [features/extension-shell.md](features/extension-shell.md) | Webview 容器、命令注册、信任状态 |
| 多 Session 生命周期 | [features/session-lifecycle.md](features/session-lifecycle.md) | 创建、切换、后台运行、停止恢复 |
| 会话目录 | [features/session-catalog.md](features/session-catalog.md) | 历史列表、缓存、删除 |
| Host 启动 | [features/host-launch.md](features/host-launch.md) | Node/DSH 进程、网络、打包 |
| 模型路由 | [features/model-routing.md](features/model-routing.md) | 模型目录、逐轮路由 |
| 模型引导 | [features/model-onboarding.md](features/model-onboarding.md) | 厂商选择、凭据保存 |
| 发送与上下文 | [features/prompt-send.md](features/prompt-send.md) | 编辑器上下文、@ 文件引用 |
| 事件投影 | [features/event-projection.md](features/event-projection.md) | DSH 事件 → UI 消息 |
| 对话阅读 | [features/conversation-reading.md](features/conversation-reading.md) | 流式跟随、吸顶、历史编辑 |
| 历史重发 | [features/history-resend.md](features/history-resend.md) | 回滚、换模型重发、撤销 |
| 检查点 | [features/checkpoints.md](features/checkpoints.md) | 快照、文件恢复 |
| Diff 审查 | [features/diff-review.md](features/diff-review.md) | 内联 Diff、Git Diff |
| 编辑冲突 | [features/edit-conflicts.md](features/edit-conflicts.md) | 外部修改检测 |
| 工具审批 | [features/approval.md](features/approval.md) | 只读模式、单次审批 |
| 结构化提问 | [features/structured-questions.md](features/structured-questions.md) | 选项/多选/文本问题 |
| 验证追踪 | [features/verification.md](features/verification.md) | 测试证据、失败定位 |
| 诊断日志 | [features/diagnostics.md](features/diagnostics.md) | 错误分类、重试状态 |
| 测试基础设施 | [features/test-infrastructure.md](features/test-infrastructure.md) | 分层测试、探针 |
| 功能索引 | [features/feature-index.md](features/feature-index.md) | 索引维护与校验 |

## 相关项目

- **DSH 运行时**: `../dsh-learning/deepseek-harness/` — 模型、工具、会话持久化
  - 修改前阅读其 `AGENTS.md`

## 关键约束

1. **Webview 只通信不执行**：通过 postMessage 与扩展通信，不直接读写文件
2. **Session 隔离**：每个 Session 独立的写 Host，跨 Session 操作必须带 sessionId
3. **优雅停止**：`stop()` 通过 `session/cancel` RPC 优雅中断活跃 turn，Host 进程保持热备、部分输出以 `interrupted` 落盘；不再杀进程、不再 rewind 用户消息
4. **检查点不可变**：快照只增不改，恢复以最老基线为准
5. **凭据安全**：密钥只进 DSH，扩展不存储明文
6. **构建产物不入 git**：`.runtime-build/`、`out/`、`node_modules/` 被忽略

## 检查点排除规则（重要）

以下文件**不被检查点跟踪**，删除后无法通过检查点恢复：

| 类别 | 文件/目录 | 说明 |
|------|----------|------|
| 版本控制 | `.git/` | Git 内部数据 |
| 依赖 | `node_modules/` | 可通过 npm install 恢复 |
| 私有数据 | `.dsh-dev/`, `.vscode-agent-dev/` | DSH 开发数据 |
| 虚拟环境 | `.venv/` | Python 虚拟环境 |
| 环境变量 | `.env`, `.env.*` | 可能包含密钥 |
| 密钥文件 | `*.pem`, `*.key`, `*.p12` | 安全原因排除 |
| 大文件 | `>10MB` | 只记录元数据（大小/修改时间），不保存内容 |

**建议**：上述文件请通过 Git 或其他备份方式保护。扩展会在删除前提示，但无法阻止排除文件的删除。

## 测试矩阵

| 级别 | 命令 | 说明 |
|------|------|------|
| quick | `npm run test:quick` | 无模型/VS Code，DOM/数据测试 |
| integration | `node scripts/vscode-integration.cjs vscode-suite.cjs` | 真实 Electron/DSH |
| cancel-integration | `VSCODE_AGENT_SUITE=cancel-integration-suite.cjs node scripts/vscode-integration.cjs` | 优雅停止端到端 |
| e2e | `node scripts/vscode-integration.cjs workbench-e2e-suite.cjs` | 真实模型/终端 |
| probe | `node --import tsx/esm scripts/sdk-probe.ts` | 最小 SDK 连接 |
| cancel-probe | `npm run test:cancel` | 最小优雅停止（真实模型，不经 VS Code） |

完整矩阵见 [FEATURE_INDEX.md §7](FEATURE_INDEX.md#7-测试矩阵)。
