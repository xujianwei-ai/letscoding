# 代码审查模块开发文档

> **功能索引**：`diff-review`（代码审查域）、`edit-conflicts`（代码审查域）
> **核心文件**：`src/inlineDiff.ts`（94 行）、`src/diff.ts`（87 行）、`src/conflicts.ts`（70 行）

## 1. 模块职责

提供代码变更的可视化审查：
- 编辑器内联 Diff 装饰（增删改高亮）
- 检查点基线与当前文件对比
- Git HEAD 对比
- 外部修改与未保存编辑器冲突检测

## 2. 核心类

### 2.1 `InlineDiffRenderer`（inlineDiff.ts）

在编辑器中显示本轮增删改：

```typescript
class InlineDiffRenderer implements vscode.Disposable {
  private readonly addedDecoration: TextEditorDecorationType      // 绿色背景
  private readonly deletedDecoration: TextEditorDecorationType    // 红色删除线
  private readonly modifiedDecoration: TextEditorDecorationType   // 黄色背景
  
  apply(editor, changes: FileChange[]): void  // 应用装饰
  clear(): void                                // 清除所有装饰
}
```

变更类型：
- `added`：新增行（绿色背景）
- `deleted`：删除行（红色删除线 + hover 显示原内容）
- `modified`：修改行（黄色背景）

### 2.2 `changedPath`（diff.ts）

从工具调用参数提取变更的文件路径：

```typescript
function changedPath(tool: string, argumentsText: unknown, workspace: string): string | undefined {
  // edit/write/insert 工具 → 提取 path 参数
  // 验证路径在工作区内
}
```

### 2.3 `openChangedDiff`（diff.ts）

打开 Git Diff 视图：

```typescript
async function openChangedDiff(workspace: string, paths: readonly string[]): Promise<void> {
  // 无 paths：打开 Git SCM 视图
  // 有 paths：打开每个文件的 vscode.diff（工作区 vs HEAD）
}
```

### 2.4 `EditConflictMonitor`（conflicts.ts）

监控外部修改：

```typescript
class EditConflictMonitor {
  snapshot(workspace): void           // 轮次开始记录文件时间戳
  watch(path): void                   // 工具调用前检查
  // 检测到外部修改或脏编辑器 → 触发 onEditConflict 回调
}
```

冲突类型：
- **外部修改**：文件在 Agent 读取后被其他程序修改
- **脏编辑器**：文件在 VS Code 中有未保存更改

## 3. Diff 打开流程

### 3.1 检查点基线对比

```
用户点击消息上的 "Diff" 按钮
    ↓
webview.js: postMessage({ type: 'openDiff', path, seq, sessionId })
    ↓
extension.ts: controller.openDiff(path, seq, sessionId)
    ↓
agent.ts: checkpointBaseline(seq, path) 读取基线内容
    ↓
注册 coding-agent-checkpoint:// URI scheme
    ↓
vscode.diff(基线 URI, 工作区文件 URI)
```

URI 格式：`coding-agent-checkpoint://<authority>/<path>?sessionId=...&workspace=...&userSeq=...&path=...`

### 3.2 Git Diff

无检查点基线时回退到 Git HEAD：

```typescript
const git = extensions.getExtension('vscode.git')?.exports
const repository = git?.getRepository(workspaceUri)
// 打开 repository.diffWithHEAD(path)
```

## 4. 冲突检测流程

```
轮次开始: conflicts.snapshot(workspace) 记录所有文件 mtime
    ↓
工具调用前: conflicts.watch(path)
    ↓
检查:
  - 文件 mtime > snapshot 时间 → 外部修改
  - workspace.textDocuments 中有 isDirty 的文档 → 脏编辑器
    ↓
触发 onEditConflict(path, type)
    ↓
VS Code 警告 + Webview conflict 消息
```

## 5. 不可破坏的约束

1. **Diff URI 保留源 sessionId**：切换会话后不得读取另一会话的基线
2. **装饰失败不使 Agent 轮次失败**：内联 Diff 是增强功能，失败静默
3. **删除行不覆盖修改行**：一行同时有删除和修改时，优先显示修改
4. **警告不是恢复或许可**：不自动保存或覆盖任一版本
5. **重新打开同一文档并保存不应当作外部修改**：通过内容哈希区分

## 6. 与其他模块的关系

```
diff.ts / inlineDiff.ts / conflicts.ts
    ├── 被 agent.ts 调用（onNotification 中的 tool/call、tool/result）
    ├── 被 agentController.ts 调用（openDiff）
    └── 被 extension.ts 调用（注册 URI scheme、Git 扩展）
```

## 7. 调试技巧

- **内联 Diff**：查看编辑器装饰是否应用
- **Git 扩展**：确保 Git 扩展已激活且工作区是 Git 仓库
- **冲突日志**：`[Coding Agent] Edit conflict detected: ...`
