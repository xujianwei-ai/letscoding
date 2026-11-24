# session-catalog · 历史目录、缓存与删除

**风险：high**

## 功能

读取当前工作区的历史会话、合并较新投影、异步删除日志和检查点。

## 入口

- `src/sessionCatalog.ts` — `SessionCatalog.list()`, `invalidate()`
- `src/agentController.ts` — `AgentController.readOnly()`, `deleteSession()`, `history()`

## 调用链

```
只读 Host.listSessions → SessionCatalog 合并 → Webview 目录
删除 → 标记 deletedSessions → 关闭目标 Host → 删除 JSONL/投影/检查点
```

## 消息

- **Webview → 扩展**: `sessionList`, `sessionSelect`, `sessionDelete`
- **扩展 → Webview**: `sessionList`, `sessionListStatus`, `sessionDeleted`

## 存储

- `<dshHome>/sessions/<projectKey>/<sessionId>` — DSH 会话日志
- `<dshHome>/storages/session_projcache/sessions/<sessionId>.json` — 投影缓存

## 约束

1. 迟到的目录响应不能复活已删除项
2. 正在运行的目标不能删除
3. 只有磁盘删除成功才解除删除标记
4. 路径段转义必须与 DSH 一致

## 测试

`quick-session`, `quick-delete`, `quick-webview`, `integration`
