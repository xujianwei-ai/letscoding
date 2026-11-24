# checkpoints · 检查点、快照与文件恢复

**风险：high**

## 功能

在每轮开始前保存工作区基线，跟踪 edit/write/Bash 变更，保护手工修改，管理撤销和共享快照生命周期。

## 入口

- `src/checkpoints.ts` — `CheckpointStore.before()`, `track()`, `trackWorkspaceChanges()`, `finish()`, `deleteSession()`, `workspacePath()`
- `src/agent.ts` — `SessionRuntime.onNotification()`, `SessionRuntime.checkpointTracking()`

## 调用链

```
turn 前 before → 工具修改 track / Bash finish 比较 → finish 保存轮末哈希
  → restoreFrom / undo → deleteSession 引用计数清理
```

## 消息

- **扩展 → Webview**: `messageCheckpoint`, `messageSeq`, `checkpointRestored`

## 存储

- `<globalStorage>/checkpoints/<encoded-workspace>/index.json` — 索引
- `<checkpoint>.json` — 全量清单与 hash 引用
- `<checkpoint>-<path>.json` — 旧格式单文件快照
- `blobs/<sha256>.json` — 私有内容

## 约束

1. 排除 .env、密钥、Git、依赖、私有 Agent 数据与外部符号链接
2. 单文件上限 10 MiB；大文件仅记录元数据、不复制内容
3. 快照不可变；同文件多轮恢复以最老基线为准
4. turnEnds 用于区分手工修改；未知变化宁可报冲突
5. 共享 blob/undo/继承记录仍被引用时不能删除

## 测试

`quick-checkpoint`, `checkpoint-integration`, `integration`, `workbench-e2e`
