# approval · 只读模式与单次工具审批

**风险：high**

## 功能

权限通过 DSH 原生 /permission 命令实时写入当前会话日志并即时生效；只读模式的升级写入经模态确认，只允许一次或拒绝。

## 入口

- `src/approval.ts` — `requestApproval()`
- `src/agent.ts` — `SessionRuntime.setPermissionMode()`, `applyPermissionToSession()`, `start()`
- `src/agentController.ts` — `AgentController.setPermissionMode()`
- `src/extension.ts` — `activate()`
- `media/webview.js` — `busy()`

## 调用链

```
Webview permissionMode → 保存工作区状态 → session/query 发送 /permission <preset> 命令
  → DSH 追加 permission/preset 事件并更新沙箱与审批旋钮
  → DSH approval/request → 单次允许/拒绝
```

## 界面元素

| 选择器 | 处理函数 |
|--------|----------|
| `#permissionMode` | `busy` |

## 消息

- **Webview → 扩展**: `permissionMode`
- **扩展 → Webview**: `config`, `status`, `error`

## 约束

1. 运行中不能修改权限
2. 权限 preset 持久化在会话日志中，resume/rewind 后必须通过 /permission 命令重新对齐
3. rewind 截断日志会丢弃边界后的 permission/preset 事件，rewind 完成后必须重新应用
4. 不把一次许可扩展成整个会话许可
5. 不允许通过 Bash 绕过只读审批
6. 异步设置刷新不应当误判为拒绝

## 测试

`approval`, `integration`
