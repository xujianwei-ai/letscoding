# 扩展接入模块开发文档

> **功能索引**：`extension-shell`（接入与视图域）
> **核心文件**：`src/extension.ts`（961 行）

## 1. 模块职责

扩展激活入口，负责：
- 注册侧栏 Webview 视图提供器
- 创建/管理 `AgentController` 实例（跨 Webview 生命周期存活）
- 路由 Webview 消息到 Controller
- 生成 Webview HTML（CSP、脚本、样式）
- 管理模型目录、会话列表的加载与缓存
- 注册命令、输出通道、文件系统监听

## 2. 核心类与函数

### 2.1 `activate(context: ExtensionContext)`

扩展入口，VS Code 调用时机：
- 工作区包含 `.vscode-agent` 目录，或
- 用户执行 `coding-agent.open` 命令，或
- 用户点击侧栏图标

关键初始化：
```typescript
const controller = new AgentController(context, message => {
  output.appendLine(`Agent event: ${String(message.type)}`)
  void activeWebview?.postMessage(message)
})
context.subscriptions.push(controller)
```

**重要**：`controller` 在 `context.subscriptions` 中，Webview 关闭不会销毁它，保证后台任务继续。

### 2.2 `html(webview, extensionUri): string`

生成 Webview HTML，关键约束：
- **CSP**：`default-src 'none'; img-src ${webview.cspSource} data: blob:; script-src ${webview.cspSource}; style-src ${webview.cspSource} 'unsafe-inline';`
- **localResourceRoots**：`[extensionUri, workspaceFolders[0].uri]`（允许加载工作区图片）
- 引入 `media/webview.js` 和 KaTeX 资源

### 2.3 消息路由（`onDidReceiveMessage`）

| 消息类型 | 处理 | 说明 |
|---------|------|------|
| `ready` | 初始化会话选择、模型目录 | Webview 加载完成 |
| `send` | 组装 prompt → `controller.run()` | 含 editor-context 追加 |
| `queue` | `controller.queueMessage()` | 运行中排队 |
| `steer` | `controller.steerQueued()` | 停止当前并执行排队消息 |
| `stop` | `controller.stop()` | 停止指定 Session |
| `resend` | 预览恢复 → 确认 → `controller.resendFromHistory()` | 历史回滚重发 |
| `undoRestore` | `controller.undoRestore()` | 撤销代码恢复 |
| `new` | `controller.newSession()` | 新建会话 |
| `sessionSelect` | `controller.selectSession()` | 切换会话 |
| `sessionDelete` | `controller.deleteSession()` | 删除会话 |
| `modelCatalog` | 加载模型目录 | 异步，防重复 |
| `modelRoute` | 保存模型选择 | 写入 Workspace 设置 |
| `permissionMode` | `controller.setPermissionMode()` | 权限切换 |
| `fileList` | 返回工作区文件列表 | @ 引用补全 |
| `readFileForImage` | 读取图片文件为 base64 | VS Code 资源管理器拖拽 |
| `resolveImage` | 解析工作区图片路径为 Webview URI | markdown 图片渲染 |
| `openContext` | 打开编辑器引用 | 点击上下文标签 |
| `openDiff` | 打开文件对比 | 检查点基线或 Git |
| `openLocation` | 打开文件位置 | 测试失败定位 |
| `rerunTests` | `controller.rerunVerification()` | 重跑失败测试 |
| `answerQuestions` | `controller.answerQuestions()` | DSH 结构化提问回答 |
| `approvalResponse` | 审批结果 | 单次允许/拒绝 |
| `manageTrust` | 打开 VS Code 信任对话框 | 工作区信任 |
| `discoverModels` / `testModel` / `saveCustomProvider` / `deleteCustomProvider` / `providerConfig` | 模型管理 | 见 MODEL_ONBOARDING.md |

## 3. 关键状态

```typescript
let activeWebview: vscode.Webview | undefined  // 当前活跃 Webview
let catalogRequest = 0                          // 模型目录请求序号（防竞态）
let catalogLoading = false                      // 目录加载中
let sessionRequest = 0                          // 会话列表请求序号
let sessionLoading = false                      // 会话列表加载中
let fileRequest = 0                             // 文件列表请求序号
let indexedFiles: FileReference[] = []          // 工作区文件索引缓存
```

## 4. 不可破坏的约束

1. **CSP 严格**：只允许受控脚本/样式/图片，禁止内联脚本（除样式）
2. **工作区限制**：单项目工作区，不支持多根
3. **信任边界**：未受信任工作区只注册界面，不启动 DSH、不索引文件、不恢复会话
4. **Controller 存活**：Webview 销毁 ≠ Controller 销毁，后台任务继续
5. **消息验证**：所有 Webview 消息必须验证 `type` 和字段类型

## 5. 与其他模块的关系

```
extension.ts
    ├── 创建 AgentController ──► agentController.ts
    ├── 生成 HTML ──► media/webview.js
    ├── 调用 context.ts（编辑器上下文）
    ├── 调用 checkpoints.ts（confirmRestore）
    ├── 调用 approval.ts（confirmFullAccess）
    └── 调用 modelRouting.ts（路由迁移）
```

## 6. 调试技巧

- **输出通道**：`Coding Agent` 输出通道记录所有 Agent 事件
- **消息日志**：`output.appendLine(`Agent event: ${message.type}`)`
- **Webview 开发者工具**：命令面板 → `Developer: Open Webview Developer Tools`
