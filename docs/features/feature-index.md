# feature-index · 功能索引与一致性校验

**风险：low**

## 功能

以功能条目关联模块、协议、存储、不变量、测试和 DSH 接口，并生成可检索的开发目录。

## 入口

- `docs/feature-catalog.json` — `schemaVersion`, `features`, `integrations`, `tests`
- `scripts/feature-index.cjs` — `main()`, `validateCatalog()`, `renderIndex()`
- `docs/FEATURE_INDEX_MAINTENANCE.md` — 维护指南

## 调用链

```
编辑 feature-catalog.json → npm run index:generate → 提交生成文档 → npm run index:check 防止漂移
```

## 约束

1. 功能 id 稳定，不因文件移动或文案调整改变
2. 登记路径、锚点、消息、功能依赖和测试引用必须可由脚本验证
3. 删除代码功能必须同时处理协议、存储、测试和索引；不能只删 UI

## 命令

```bash
# 生成索引
npm run index:generate

# 校验一致性
npm run index:check
```

## 测试

`index`
