# Coding Agent 开发导航

修改、新增、删除、审查或调试扩展功能前，先阅读 `docs/FEATURE_INDEX.md`。按功能 ID、文件、符号或 DOM 选择器定位任务，阅读对应调用链、状态归属、不可破坏的约束、依赖和测试，再修改关联源码。

- `docs/feature-catalog.json` 是功能索引数据源。功能行为、模块归属、协议、依赖或测试变化时同步更新。
- 修改数据源后运行 `npm run index:generate`；不要手工编辑 `docs/FEATURE_INDEX.md`。
- 功能生命周期和风险分级验证见 `docs/FEATURE_INDEX_MAINTENANCE.md`。
- 运行 `npm run index:check` 和相关测试。标准无模型回归使用 `npm run test:quick`；真实模型/Electron 测试的条件和副作用见索引。
- 修改 `../dsh-learning/deepseek-harness/` 时，必须遵守该项目的 `AGENTS.md` 和验证规则，不能将扩展的模块归属套用到 DSH 内部。

打开整个工作区时，根目录 `AGENTS.md` 和 `.cursor/rules/feature-index.mdc` 提供同一入口。
