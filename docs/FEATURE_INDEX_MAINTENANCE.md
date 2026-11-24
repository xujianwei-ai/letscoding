# 功能索引维护指南

本目录服务于后续开发，不记录某次修复过程。`feature-catalog.json` 是功能数据源，`FEATURE_INDEX.md` 是生成视图，`scripts/feature-index.cjs` 是生成与校验入口。

## 1. 开发工作流

1. 在 `FEATURE_INDEX.md` 按需求或文件名找到功能 ID，先读入口、调用链、状态归属和不可破坏的约束。
2. 判断修改属于现有功能还是新功能。跨 Session、跨进程、跨持久化格式的修改不能只按 UI 任务处理。
3. 先写或更新最小行为测试，再修改生产代码。测试级别和副作用见索引 §7。
4. 在 `feature-catalog.json` 同步入口符号、消息、依赖、DSH 接口和测试映射。
5. 执行 `npm run index:generate`，检查生成的功能目录。
6. 执行 `npm run test:quick`，再按风险运行真实 Electron、模型或项目测试。
7. 交付时报告实际运行过的测试；不要声称索引校验能替代运行时验证。

当前处于独立运行时交付阶段，新增业务功能暂缓，阻断性缺陷修复除外。Node、DSH、VSIX 打包或干净环境安装任务先阅读 [阶段开发计划](RUNTIME_DELIVERY_PLAN.md)，按阶段 A→E 执行并更新任务状态；长期功能规范仍归功能索引，不在阶段计划中复制。

## 2. 新增功能

- 分配稳定、语义明确的 kebab-case 功能 ID，例如 `session-export`；ID 不随文件移动改变。
- 优先把功能放入现有拥有者，不在 `extension.ts` 堆积业务逻辑。Webview 负责交互，controller 负责选择/编排，SessionRuntime 负责单 Session 运行时，DSH 负责模型/工具/会话。
- 新消息必须同时登记方向、生产端、消费端和测试；不可信 Webview 数据在扩展边界校验。文件操作校验工作区范围，Session 操作携带目标 ID。
- 新配置必须写入 `package.json` 的 `contributes.configuration.properties`，注明默认值、生效边界和敏感信息规则。密钥仍由 DSH 私有存储管理。
- 新状态必须说明权威存储、内存投影、清理时机和重载行为。不能将 Webview 内存当成可恢复的数据源。
- 新持久化格式必须说明版本、已有数据读取、失败恢复和删除策略。会话格式变更还需要 DSH 的迁移审查。
- 新测试登记 `id/path/command/level/requiresModel/requiresVSCode/covers`，并在对应功能中引用。

## 3. 修改或优化现有功能

- 优化局部 UI 时，不得改变消息语义、Session 选择或历史回滚行为。吸顶、编辑、滚动分别由明确的状态和函数负责。
- 修改模型切换时，区分“逐轮 route 覆盖”和“Host 启动配置”。模型切换不应像权限/网络一样无条件重启 Host。
- 修改会话或事件时，验证快速切换、后台任务、Webview 重载、迟到响应和停止/关闭竞态。
- 修改检查点时，保留路径限制、敏感文件排除、轮末哈希、手工修改保护、共享 blob 引用和旧格式读取。恢复是写操作，必须验证预览后文件未变化。
- 修改 DSH 接口时，先阅读 `../dsh-learning/deepseek-harness/AGENTS.md`。索引仅登记接口，不授予绕开上游测试和持久化规则的权限。
- 功能行为、入口或责任改变时更新 `summary/flow/invariants`；文件或符号改名时更新 `entry/modules/integrations`，不依赖行号。

## 4. 删除功能

1. 从功能 ID 找 `dependsOn` 反向依赖、所有消息、测试和 DSH 接口；确认是否仍有其他调用方。
2. 先停止新入口，再移除 UI 和消息处理，最后移除无引用的运行时代码。不得留下可触发但无处理器的数据。
3. 处理 Host 和异步任务：等待、取消或安全关闭，释放监听器、终端、文件句柄及会话写锁。
4. 明确已有数据的处理：保留只读兼容、提供迁移，或经过用户确认清理。删除一个 Session 时，不得删除仍被继承检查点或 undo 引用的 blob。
5. 删除只属于该功能的测试，保留仍然覆盖共享行为的测试；更新其他功能的测试映射。
6. 从 JSON 删除功能条目，清理失效的 `dependsOn/dsh/tests` 引用，运行生成与快速测试。

## 5. 风险级别

| 级别 | 含义 | 最低审查范围 |
| --- | --- | --- |
| `low` | 文档、索引、无共享状态的局部工具 | 静态检查 + 对应快速测试 |
| `medium` | 局部 UI、展示、诊断、配置读取 | Webview/单元测试 + 受影响的 Electron 集成 |
| `high` | Session 身份、并发、Host、权限、网络、持久化、文件写入、跨 Session Diff | 快速回归 + 真实集成；文件恢复/权限还需专门端到端验收 |

风险用于确定验证深度，不代表功能重要程度。即使只改一行，只要影响这些共享边界就按 `high` 处理。

## 6. 索引字段约定

- `entry`：功能最推荐的起始文件和符号，不一定是唯一实现文件。
- `modules`：必须联动阅读的文件与类/方法/配置键/DOM 函数；图像等无符号资源使用空数组。
- `flow`：可读的主要调用链或状态转换，不记录逐行实现。
- `invariants`：后续修改必须维持的行为、安全或生命周期规则。
- `storage`：权威数据与内存状态的归属；相对变量如 `<dshHome>` 表示部署时解析的位置。
- `outbound/inbound`：分别表示 Webview→扩展、扩展→Webview 的消息；DSH 事件在 `integrations` 和索引 §5 单独登记。
- `dependsOn`：功能行为依赖，不是 npm import 的完整列表。
- `dsh`：引用 `integrations` 中的稳定接口 ID。
- `tests`：引用 `tests` 中的 ID；测试命令必须包含脚本路径，禁止不透明的聚合名称掩盖实际入口。

## 7. 校验器覆盖与限制

`npm run index:check` 检查：JSON 结构、ID 唯一性和引用、文件存在、类/方法或文本锚点、消息处理端、DSH 事件、配置声明、脚本入口、生成文档同步。

`npm run test:index` 另外执行损坏数据与缺失文件的故障注入测试，证明校验器会拒绝坏索引。

校验器不推断完整类型、不证明功能行为、不检查每个字段的值、不替代 DSH 测试，也不验证真实 UI 视觉效果。当前生产模块覆盖由索引生成器及故障注入测试保障；新增模块后必须归属功能。

## 8. 常用命令

```sh
npm run index:generate  # 修改 JSON 后生成阅读目录
npm run index:check     # 只校验，不改文档
npm run test:index      # 校验及故障注入
npm run test:quick      # 编译、索引与无模型快速回归
npm run test:vscode     # 真实 Electron + DSH + 模型，使用隔离测试数据
```
