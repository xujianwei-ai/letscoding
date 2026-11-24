# model-onboarding · 模型服务引导与私密凭据

**风险：high**

## 功能

首启或空目录时选择厂商，使用临时草稿发现与测试模型，保存私密凭据并管理已有服务。

## 入口

- `media/webview.js` — `amoOnboarding()`, `amoOpenProvider()`, `amoDiscover()`, `amoSave()`, `handleAmoMessage()`
- `src/extension.ts` — `html()`, `activate()`
- `src/agentController.ts` — `AgentController.discoverModels()`, `testModel()`, `saveProvider()`, `deleteProvider()`, `providerConfig()`

## 调用链

```
Webview 草稿 → 扩展/Controller → DSH 临时模型发现或最小推理
  → 选择模型/别名 → DSH settings + private credentials
  → Workspace provider/model → 刷新目录并回到会话
```

## 界面元素

| 选择器 | 处理函数 |
|--------|----------|
| `#model-onboarding, #amo-provider-view` | `amoRenderProviders` |
| `#amo-config-view, #amo-key` | `amoSave` |
| `#amo-manage-view, #model-menu` | `amoRenderManage` |

## 消息

- **Webview → 扩展**: `discoverModels`, `testModel`, `saveCustomProvider`, `deleteCustomProvider`, `providerConfig`
- **扩展 → Webview**: `discoverModelsResult`, `testModelResult`, `saveCustomProviderResult`, `deleteCustomProviderResult`, `providerConfigResult`

## 存储

- `<dshHome>/settings` — `llm-pi-ai.providers.<route>` 非私密配置
- `<dshHome>/.credentials.yaml` — DSH 凭据服务管理，Webview 不读取明文
- Workspace `privateCodingAgent.provider/model` — 下一次请求的路由

## 约束

1. 发现与测试不创建 Session，不写持久配置
2. 密钥仅单向进入 DSH，结果与配置读取不回显密钥
3. 保存后清空 Webview 密钥；编辑留空保留已有凭据
4. 删除不删除历史会话；删除最后一个服务重新打开引导
5. 目录为空不得伪造默认模型或允许发送

## 测试

`quick-webview`, `runtime-sdk`, `vsix`
