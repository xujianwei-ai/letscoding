# diff-review · 内联 Diff、历史基线与 Git Diff

**风险：high**

## 功能

编辑器显示本轮增删改，删除内容通过 hover 查看；打开检查点基线或 Git HEAD 的原生 Diff。

## 入口

- `src/agent.ts` — `SessionRuntime.refreshInlineDiff()`, `openDiff()`, `checkpointBaseline()`
- `src/inlineDiff.ts` — `InlineDiffRenderer.apply()`
- `src/diff.ts` — `changedPath()`, `openChangedDiff()`
- `src/extension.ts` — `activate()`
- `media/webview.js` — `showTool()`, `showVerificationReport()`

## 调用链

```
成功文件修改 → changedPath → baseline → InlineDiffRenderer
打开 Diff → coding-agent-checkpoint URI → 当前工作区校验 → vscode.diff
```

## 界面元素

| 选择器 | 处理函数 |
|--------|----------|
| `#diff-visible, #diff, .tool-diff` | `showTool` |

## 消息

- **Webview → 扩展**: `openDiff`
- **扩展 → Webview**: `toolResult`, `verificationReport`

## 约束

1. Diff URI 必须保留源 sessionId，切换会话后不得读取另一会话的基线
2. 装饰失败不能使 Agent 轮次失败；删除行不覆盖修改行
3. 无检查点基线时可回退 Git HEAD；无 Git 基线给出明确提示

## 测试

`quick-diff`, `quick-webview`, `diff-integration`, `integration`, `workbench-e2e`
