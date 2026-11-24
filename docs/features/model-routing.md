# model-routing · 模型目录与逐轮路由

**风险：medium**

## 功能

展示可用模型，串行保存 provider/model，并将所选 route 应用于新轮次和历史重发。

## 入口

- `src/extension.ts` — `selectModel()`, `isCatalog()`, `isModelRoute()`, `migrateRemovedBuiltinRoute()`
- `media/webview.js` — `renderModels()`, `refreshModelCatalog()`
- `src/agent.ts` — `SessionRuntime.run()`, `SessionRuntime.options`

## 调用链

```
独立查询 Host 读取目录 → 迁移旧版已移除的内置模型选择 → 校验并保存 Workspace 设置
  → session.run({route}) → request/header 回显真实路由
```

## 消息

- **Webview → 扩展**: `modelCatalog`, `modelRoute`, `send`, `resend`
- **扩展 → Webview**: `modelCatalog`, `modelCatalogStatus`, `modelConfig`, `modelRoute`

## 约束

1. 目录响应不能覆盖更新的用户选择
2. 查询 Host 不得继承已移除的保存路由
3. 无凭据导致的空目录明确提示登录或配置 DSH Home
4. 发送时等待模型设置写入完成
5. 实际请求头而非下拉框是路由事实来源

## 测试

`quick-webview`, `integration`
