# 模型管理模块开发文档

> 本文档覆盖 `model-onboarding` 和 `model-routing` 两个功能的实现细节。功能索引见 [FEATURE_INDEX.md](FEATURE_INDEX.md)。

## 1. 模块边界

模型管理横跨 3 个文件，职责清晰：

| 文件 | 职责 | 关键符号 |
|------|------|---------|
| `media/webview.js` | 全部 UI 交互与临时状态 | `amo*` 函数群、`handleAmoMessage` |
| `src/extension.ts` | HTML 模板、消息路由、`selectModel` 验证 | `html()`、`selectModel()` |
| `src/agentController.ts` | DSH SDK 方法透传（5 个方法） | `discoverModels` / `testModel` / `saveProvider` / `deleteProvider` / `providerConfig` |

## 2. 核心状态机

Webview 端全局状态对象 `amo`：

```javascript
const amo = {
  view: 'chat',           // 当前视图：chat / providers / config / manage
  provider: undefined,    // 当前选中的 preset 对象
  models: [],             // discoverModels 返回的模型列表
  selected: [],           // 用户勾选的索引数组（必须是数组）
  busy: false,
  saved: false,
  requestId: 0,
  discoverTimer: undefined,
  hasCredential: false,
  connection: undefined,
  backToManage: false,    // 保存后回 manage 还是 providers
  presets: [...]          // 17 个内置厂商预设
}
```

**关键约束**：`amo.selected` 必须是数组 `number[]`，禁止标量赋值。历史 bug：`amo.selected = index` 导致 `includes` 报错。

## 3. 视图流转

```
chat（会话页）
  └─ 点击"添加模型" → providers（厂商选择页）
       └─ 点击厂商 → config（配置页：填 Key/URL/选模型）
            ├─ 保存成功 → chat
            └─ 返回 → providers 或 manage（取决于 backToManage）
  └─ 点击"管理模型" → manage（管理页：编辑/删除已有服务）
       └─ 编辑 → config（编辑模式）
       └─ 返回 → chat
```

`amoShow(view)` 控制 4 个 section 的 `hidden` 属性，同时处理：
- 隐藏/显示 `#conversation` 和 `#sticky-prompt`
- 清理 body 上遗留的 `.amo-model-submenu`
- 滚动到顶部

## 4. 消息协议

| Webview → 扩展 | 扩展 → Webview | 用途 |
|---------------|---------------|------|
| `discoverModels` | `discoverModelsResult` | 临时发现模型，不写配置 |
| `testModel` | `testModelResult` | 最小推理测试连接 |
| `saveCustomProvider` | `saveCustomProviderResult` | 原子保存配置+凭据 |
| `deleteCustomProvider` | `deleteCustomProviderResult` | 删除自定义 provider |
| `providerConfig` | `providerConfigResult` | 读取已有配置（不含密钥） |

**requestId 配对**：`amoRequest()` 自增生成 `requestId`，`handleAmoMessage` 中校验 `message.requestId === amo.xxxRequest`，防止过期响应覆盖新状态。

## 5. 关键函数清单

| 函数 | 职责 | 依赖 |
|------|------|------|
| `amoRenderProviders()` | 渲染厂商网格，标记"已配置" | `modelGroups`, `amo.presets` |
| `amoOpenProvider(preset, edit)` | 打开配置页，区分新增/编辑 | `amo.presets` |
| `amoDiscover()` | 调用 DSH `discoverModels` | `amoDraft()` |
| `amoRenderModels()` | 渲染模型复选框列表 | `amo.models`, `amo.selected` |
| `amoToggleModel()` / `amoSelectAllModels()` | 勾选/全选 | `amo.selected` |
| `amoSave()` | 保存 provider + 选中模型 | `amoDraft()`, `amo.selected` |
| `amoRenderManage()` | 渲染管理列表（编辑/删除按钮） | `modelGroups` |
| `amoRenderMenu()` | 渲染右下角模型下拉菜单（两级） | `modelGroups` |
| `handleAmoMessage()` | 处理 5 种 DSH 结果消息 | `amo.*` |

## 6. DeepSeek 家族合并逻辑

DSH 内置注册 `deepseek-account` 和 `deepseek-official`（显示名都是 "DeepSeek"），用户通过预设 `deepseek` 添加后会产生重复。合并规则：

```javascript
const DEEPSEEK_FAMILY = ['deepseek', 'deepseek-account', 'deepseek-official']
// 有自定义 deepseek 时，只显示自定义的模型列表
const custom = family.find(g => g.id === 'deepseek')
const models = custom ? custom.models : family[0].models
const representative = custom ? 'deepseek' : family[0].id
```

- **代表 ID**：优先用 `deepseek`（可删除），否则用 `deepseek-account`
- **模型列表**：有自定义时只显示自定义保存的模型，否则显示内置模型
- **删除**：只删 `deepseek`，内置 `deepseek-account`/`deepseek-official` 受 DSH 保护

## 7. 二级菜单实现

`amoRenderMenu()` 为每个厂商创建：
- `providerEntry`：一级条目，含左箭头 `‹` + 厂商名
- `subMenu`：二级菜单，`position: fixed`，初始 `display:none`

**定位策略**（hover 时计算）：
1. `subMenu` 挂到 `document.body`，避免父级 overflow 裁剪
2. `left = providerEntry.rect.left - subWidth - 4`（4px 间距，无重叠）
3. `top = providerEntry.rect.top`（与条目顶部对齐）
4. 视口边界检查：左侧不足时贴右边缘，底部超出时上移

**鼠标过渡**：
- 全局 `activeSubMenu` / `activeProviderEntry` / `closeTimer` 管理
- 离开条目启动 200ms 定时器；进入子菜单取消定时器
- 打开新子菜单时**立即关闭**旧的，无延迟

**点击模型**：
```javascript
selectedRoute = { provider: group.provider, model: option.id }
model.dataset.value = JSON.stringify([group.provider, option.id])
model.dispatchEvent(new Event('change'))
subMenu.style.display = 'none'  // 立即关闭
amoById('model-menu').hidden = true
```

## 8. 外部耦合点

| 耦合点 | 说明 | 风险 |
|--------|------|------|
| `modelGroups` | 全局变量，`modelCatalog` 消息填充 | **高** — 菜单、管理、厂商标记共用 |
| `currentRoute` | 当前选中的 provider/model | 中 — 保存后需同步 |
| `selectedRoute` | 下拉菜单临时选择 | 中 |
| `trusted` / `running` | 工作区信任和运行状态 | 低 — 只影响按钮 disabled |
| `amo.presets` | 17 个内置厂商预设 | **高** — 新增厂商需改这里 |

## 9. 持久化与状态

- `<dshHome>/settings` 的 `llm-pi-ai.providers.<route>`：非私密配置（baseURL、api、models）
- `<dshHome>/.credentials.yaml`：API Key 由 DSH 凭据服务管理，Webview 不读取明文
- Workspace `privateCodingAgent.provider/model`：下一次请求的路由

## 10. 不可破坏的约束

- 发现与测试不创建 Session，不写持久配置；密钥仅单向进入 DSH
- 保存后清空 Webview 密钥；编辑留空保留已有凭据
- 删除不删除历史会话；删除最后一个服务重新打开引导
- 目录为空不得伪造默认模型或允许发送
- 未受信任工作区不启动 DSH 或发送配置请求

## 11. 测试

| 测试 | 命令 | 覆盖 |
|------|------|------|
| `quick-webview` | `node scripts/webview-suite.cjs` | linkedom DOM 交互、模型选择、会话菜单 |
| `runtime-sdk` | `node scripts/runtime-sdk-suite.cjs --controlled-mock` | 离线模型目录、Session 隔离 |
| `vsix` | `npm run vsix:package && npm run vsix:accept` | 真实 VSIX 安装、模型目录、错误分类 |

## 12. 后续修改指南

| 需求 | 修改位置 |
|------|---------|
| 新增厂商 | `amo.presets` 数组 + `src/extension.ts` HTML 下拉菜单 |
| 改模型选择交互 | `amoRenderModels` / `amoToggleModel` / `amoSelectAllModels` |
| 改保存逻辑 | `amoSave` + `handleAmoMessage('saveCustomProviderResult')` |
| 改菜单样式 | `amoRenderMenu` + CSS |
| 改 DeepSeek 合并 | `modelCatalog` 消息处理里的 `DEEPSEEK_FAMILY` 逻辑 |
| 改视图流转 | `amoShow` + `amoReturnToProviders` |
