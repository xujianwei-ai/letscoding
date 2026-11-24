const fs = require('node:fs')
const path = require('node:path')

const root = path.resolve(__dirname, '..')
const catalogPath = path.join(root, 'docs/feature-catalog.json')
const indexPath = path.join(root, 'docs/FEATURE_INDEX.md')
const header = '<!-- GENERATED FROM docs/feature-catalog.json. Edit the JSON, then run npm run index:generate. -->\n'
const commands = {
  toExtension: ['ready', 'fileList', 'sessionList', 'sessionSelect', 'sessionDelete', 'renameSession', 'exportSession', 'modelCatalog', 'modelRoute', 'discoverModels', 'testModel', 'saveCustomProvider', 'deleteCustomProvider', 'providerConfig', 'send', 'resend', 'undoRestore', 'stop', 'new', 'openDiff', 'openLocation', 'rerunTests', 'resume', 'answerQuestions', 'permissionMode', 'openContext', 'manageTrust'],
  toWebview: ['status', 'busy', 'cleared', 'error', 'fileList', 'sessionList', 'sessionListStatus', 'sessionDeleted', 'sessionSelected', 'sessionRenamed', 'sessionExported', 'editorContext', 'assistantBoundary', 'assistant', 'assistantDelta', 'assistantReasoning', 'messageSeq', 'messageCheckpoint', 'checkpointRestored', 'user', 'modelRoute', 'modelConfig', 'modelCatalog', 'modelCatalogStatus', 'discoverModelsResult', 'testModelResult', 'saveCustomProviderResult', 'deleteCustomProviderResult', 'providerConfigResult', 'config', 'tool', 'toolResult', 'testResult', 'verificationReport', 'questions', 'conflict', 'workspaceTrust'],
  dshEvents: ['request/header', 'llm/retry-started', 'turn/start', 'turn/end', 'user/message', 'assistant/attempt', 'assistant/message', 'tool/call', 'tool/result'],
}

function loadCatalog(file = catalogPath) {
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}

function readSource(relative, projectRoot = root) {
  const absolute = path.resolve(projectRoot, relative)
  const contained = absolute === projectRoot || absolute.startsWith(projectRoot + path.sep)
  const discoveryGuide = relative === '../AGENTS.md' || relative === '../.cursor/rules/feature-index.mdc'
  if (!contained && !discoveryGuide && !relative.startsWith('../dsh-learning/deepseek-harness/')) throw new Error(`路径超出允许的项目或 DSH 范围: ${relative}`)
  if (!fs.existsSync(absolute) || !fs.statSync(absolute).isFile()) throw new Error(`索引路径不存在: ${relative}`)
  return fs.readFileSync(absolute, 'utf8')
}

function methodAnchor(source, owner, name) {
  const declaration = new RegExp(`(?:async )?${name}\\(`)
  if (declaration.test(source)) return
  if (new RegExp(`(?:readonly )?${name}(?::|\\s*=)`).test(source)) return
  throw new Error(`索引方法锚点不存在: ${owner}.${name}`)
}

function validateAnchor(relative, symbol, projectRoot) {
  const source = readSource(relative, projectRoot)
  const parts = symbol.split('.')
  if (parts.length === 2 && /^[A-Z]/.test(parts[0])) {
    if (!new RegExp(`class ${parts[0]}\\b`).test(source)) throw new Error(`索引类锚点不存在: ${relative} ${parts[0]}`)
    methodAnchor(source, parts[0], parts[1])
    return
  }
  const candidates = symbol === 'main' && relative === 'package.json' ? ['"main"'] : [symbol, `'${symbol}'`, `"${symbol}"`]
  if (!candidates.some(candidate => source.includes(candidate))) throw new Error(`索引符号/锚点不存在: ${relative} -> ${symbol}`)
}

function validateCatalog(catalog, projectRoot = root) {
  const errors = []
  const check = (condition, message) => { if (!condition) errors.push(message) }
  check(catalog.schemaVersion === 1, 'schemaVersion 必须为 1')
  for (const key of ['project', 'architecture', 'integrations', 'tests', 'features']) check(catalog[key] !== undefined, `缺少 ${key}`)
  if (errors.length > 0) return errors
  const unique = (items, label) => {
    const ids = items.map(item => item.id)
    check(new Set(ids).size === ids.length, `${label} id 必须唯一`)
    check(ids.every(id => typeof id === 'string' && /^[a-z][a-z0-9-]+$/.test(id)), `${label} id 必须使用 kebab-case`)
  }
  unique(catalog.features, '功能')
  unique(catalog.tests, '测试')
  unique(catalog.integrations, '外部接口')
  const featureIds = new Set(catalog.features.map(item => item.id))
  const testIds = new Set(catalog.tests.map(item => item.id))
  const integrationIds = new Set(catalog.integrations.map(item => item.id))
  const sources = new Map()
  for (const feature of catalog.features) {
    for (const key of ['domain', 'name', 'summary', 'risk', 'entry', 'flow', 'invariants', 'tests', 'dependsOn', 'dsh']) check(feature[key] !== undefined, `${feature.id}: 缺少 ${key}`)
    check(['low', 'medium', 'high'].includes(feature.risk), `${feature.id}: 无效风险级别`)
    check(Array.isArray(feature.flow) && feature.flow.length > 0, `${feature.id}: 缺少调用链`)
    check(Array.isArray(feature.invariants) && feature.invariants.length > 0, `${feature.id}: 缺少修改约束`)
    for (const item of [feature.entry, ...feature.modules ?? []]) {
      check(typeof item.path === 'string' && Array.isArray(item.symbols), `${feature.id}: 无效模块`)
      if (typeof item.path === 'string') sources.set(item.path, new Set([...sources.get(item.path) ?? [], ...item.symbols ?? []]))
    }
    check(Array.isArray(feature.outbound) && feature.outbound.every(message => commands.toExtension.includes(message)), `${feature.id}: outbound 必须属于已登记的 Webview→扩展消息`)
    check(Array.isArray(feature.inbound) && feature.inbound.every(message => commands.toWebview.includes(message)), `${feature.id}: inbound 必须属于已登记的扩展→Webview 消息`)
    for (const item of feature.dom ?? []) {
      check(typeof item.selector === 'string' && typeof item.function === 'string', `${feature.id}: DOM 条目需要 selector 和 function`)
      for (const selector of item.selector.split(',').map(value => value.trim())) {
        const anchor = selector.match(/^#[A-Za-z][\w-]*/)?.[0] ?? selector.match(/^\.[A-Za-z][\w-]*/)?.[0]
        check(anchor !== undefined && (readSource('src/extension.ts').includes(anchor.slice(1)) || readSource('media/webview.js').includes(anchor.slice(1))), `${feature.id}: DOM 锚点不存在 ${selector}`)
      }
      check(readSource('media/webview.js').includes(item.function) || readSource('src/extension.ts').includes(item.function), `${feature.id}: DOM 处理函数不存在 ${item.function}`)
    }
    for (const id of feature.tests) check(testIds.has(id), `${feature.id}: 未登记测试 ${id}`)
    for (const id of feature.dependsOn) check(featureIds.has(id), `${feature.id}: 未登记依赖 ${id}`)
    for (const id of feature.dsh) check(integrationIds.has(id), `${feature.id}: 未登记 DSH 接口 ${id}`)
  }
  for (const [file, symbols] of sources) {
    try { for (const symbol of symbols) validateAnchor(file, symbol, projectRoot) } catch (error) { errors.push(error.message) }
  }
  for (const integration of catalog.integrations) {
    try { for (const symbol of integration.symbols) validateAnchor(integration.path, symbol, projectRoot) } catch (error) { errors.push(error.message) }
  }
  for (const test of catalog.tests) {
    check(test.command.includes(path.basename(test.path)), `${test.id}: 测试命令必须显式包含 ${path.basename(test.path)}`)
    check(['quick', 'integration', 'e2e', 'probe'].includes(test.level), `${test.id}: 无效测试级别`)
    try { readSource(test.path, projectRoot) } catch (error) { errors.push(error.message) }
  }
  try {
    for (const file of fs.readdirSync(path.join(projectRoot, 'src')).filter(file => file.endsWith('.ts'))) {
      const relative = `src/${file}`
      check(sources.has(relative), `生产模块未归属任何功能: ${relative}`)
    }
    const extension = readSource('src/extension.ts', projectRoot)
    const webview = readSource('media/webview.js', projectRoot)
    const agent = readSource('src/agent.ts', projectRoot)
    const incoming = new Set([...extension.matchAll(/message\.type === '([^']+)'/g)].map(match => match[1]))
    const outgoing = new Set([...webview.matchAll(/message\.type === '([^']+)'/g)].map(match => match[1]))
    for (const message of commands.toExtension) check(incoming.has(message), `Webview→扩展协议未在 extension.ts 处理: ${message}`)
    for (const message of commands.toWebview) check(outgoing.has(message), `扩展→Webview 协议未在 webview.js 处理: ${message}`)
    for (const message of commands.dshEvents) check(agent.includes(`'${message}'`), `DSH 事件未在 agent.ts 处理: ${message}`)
    const manifest = JSON.parse(readSource('package.json', projectRoot))
    for (const file of ['src/extension.ts', ...new Set(catalog.features.map(feature => feature.entry.path))]) {
      if (file.endsWith('.ts') && file.startsWith('src/')) {
        const source = readSource(file, projectRoot)
        for (const match of source.matchAll(/config\.get(?:<[^>]+>)?\('([^']+)'\)/g)) {
          check(manifest.contributes.configuration.properties[`privateCodingAgent.${match[1]}`] !== undefined, `代码读取未声明的配置: ${match[1]}`)
        }
      }
    }
    for (const script of ['index:generate', 'index:check', 'test:index', 'test:quick']) check(typeof manifest.scripts[script] === 'string', `package.json 缺少脚本 ${script}`)
    for (const relative of ['AGENTS.md', '.cursor/rules/feature-index.mdc']) {
      const guide = readSource(path.posix.join('..', relative))
      check(guide.includes('vscode-coding-agent/docs/FEATURE_INDEX.md'), `${relative}: 缺少功能索引自动发现入口`)
      check(guide.includes('docs/feature-catalog.json'), `${relative}: 缺少功能数据源维护入口`)
    }
    for (const relative of ['docs/FEATURE_INDEX_MAINTENANCE.md', 'docs/RUNTIME_DELIVERY_PLAN.md', 'docs/RUNTIME_BASELINE.md', ...new Set(catalog.tests.map(test => test.path))]) {
      for (const match of readSource(relative, projectRoot).matchAll(/\]\(([^)#]+?)(?:#[^)]+)?\)/g)) {
        const link = match[1]
        if (/^[a-z]+:/i.test(link)) continue
        const target = path.resolve(path.dirname(path.resolve(projectRoot, relative)), decodeURIComponent(link))
        check(fs.existsSync(target), `${relative}: 文档链接不存在 ${link}`)
      }
    }
  } catch (error) { errors.push(error.message) }
  return errors
}

function code(value) { return `\`${String(value).replaceAll('`', '\\`')}\`` }
function refs(items) { return items.length === 0 ? '—' : items.map(item => code(item)).join('<br>') }
function featureLink(id) { return `[${id}](#${id})` }
function moduleLink(module) {
  const symbols = module.symbols.length === 0 ? '' : `<br>${module.symbols.map(symbol => code(symbol)).join('<br>')}`
  const link = path.posix.relative('docs', module.path)
  return `[\`${module.path}\`](${link.split('/').map(encodeURIComponent).join('/')})${symbols}`
}
function table(headers, rows) {
  return `| ${headers.join(' | ')} |\n| ${headers.map(() => '---').join(' | ')} |\n${rows.map(row => `| ${row.join(' | ')} |`).join('\n')}\n`
}

function renderIndex(catalog) {
  const lines = [header.trimEnd(), '', '# 工程功能索引', '', '> 本文档由 `docs/feature-catalog.json` 生成。功能增删或结构调整时修改数据源，运行 `npm run index:generate`；提交前运行 `npm run index:check`。不要手工编辑本文件。', '',
    '## 1. 快速使用', '',
    '**开发工具自动发现**：工作区根目录 `AGENTS.md` 和 `.cursor/rules/feature-index.mdc` 会把 Coding 工具引导到本文档。开发时先按本文档定位功能；新增/删除功能时再读 [维护指南](FEATURE_INDEX_MAINTENANCE.md)；修改 DSH 时同时遵守其 `AGENTS.md`。', '',
    '- **按需求定位**：在下一节搜索用户可见功能，进入功能 ID，查看入口、调用链、约束与回归命令。',
    '- **按文件定位**：搜索 `src/...` 或 `media/webview.js`，找到拥有它的功能；先看“不可破坏的约束”再修改。',
    '- **按界面定位**：搜索 `#sticky-prompt`、`.history-edit`、`#model` 等选择器；各功能登记对应 DOM 与处理函数。',
    '- **目录导航**：§3 总目录 → §4 功能详情 → §5 协议 → §6 DSH → §7 测试 → §8 已知覆盖缺口。',
    '- **当前阶段**：独立运行时与一键安装优先，暂缓新增业务功能。Node、DSH、VSIX 或干净环境安装任务先读 [阶段开发计划](RUNTIME_DELIVERY_PLAN.md)，再阅读关联功能约束。',
    '- **新增功能**：先阅读 [维护指南](FEATURE_INDEX_MAINTENANCE.md)，稳定分配功能 ID，再写实现、协议、测试和索引。',
    '- **删除功能**：不能只删按钮；按依赖反向检查消息、Host 生命周期、持久化、测试与外部接口。',
    '- **排查问题**：模型与 Host 从 `host-launch` / `diagnostics` 开始；会话错乱从 `session-lifecycle` 开始；回滚和 Diff 从 `checkpoints` / `diff-review` 开始。', '',
    '### 修改范围速查', '',
    table(['需求', '首先阅读', '常见联动', '最低验证'], [
      ['独立安装/Node/DSH 打包', '[阶段开发计划](RUNTIME_DELIVERY_PLAN.md)、' + featureLink('host-launch'), '运行时物料、启动模式、原生组件与 VSIX 隔离验收', '`npm run test:quick`；最终必须执行真实 VSIX 安装验收'],
      ['发送/切换模型无响应', featureLink('host-launch') + '、' + featureLink('model-routing') + '、' + featureLink('diagnostics'), '实际 route、普通 Node、代理与重试', '`npm run test:quick`；真实连接用 `npm run test:sdk`'],
      ['历史选择/后台任务错乱', featureLink('session-lifecycle'), '目标 sessionId、读写 Host、视图投影', '`node scripts/session-runtime-suite.cjs` + `npm run test:vscode`'],
      ['吸顶/滚动/编辑交互', featureLink('conversation-reading'), 'Webview DOM/CSS、`resend` 消息、迟到 seq', '`node scripts/webview-suite.cjs`'],
      ['历史重发/撤销', featureLink('history-resend') + '、' + featureLink('checkpoints'), 'rewind、手工修改、文件范围、模型路由', '`npm run test:quick` + `npm run test:vscode`'],
      ['工具与测试报告', featureLink('verification') + '、' + featureLink('event-projection'), '真实 Bash 输出、退出码、终端事件', '`node scripts/webview-suite.cjs` + `npm run test:workbench-e2e`'],
      ['权限与网络安全', featureLink('approval') + '、' + featureLink('host-launch'), 'Host 重建、凭据、沙箱、单次审批', '`npm run test:approval`'],
    ]), '',
    '## 2. 系统边界与状态归属', '',
    '```text', 'media/webview.js  交互与临时视图状态', '       │ postMessage（本目录 §5）', 'src/extension.ts  消息校验、HTML、设置、VS Code 集成', '       │ AgentController：按 sessionId 路由与选择', 'src/agent.ts      每个 Session 的写 Host、事件、检查点和 Diff', '       │ src/runtime.ts：普通 Node / 网络环境 / stdio JSON-RPC', '../dsh-learning/deepseek-harness  模型、工具、会话持久化', '```', '',
    table(['层', '拥有者', '职责', '边界'], catalog.architecture.map(item => [code(item.id), code(item.owner), item.responsibility, item.boundary])), '',
    '**权威数据**：DSH 的 Session 日志是历史事实来源；`AgentController.liveViews` 是内存投影；`CheckpointStore` 是扩展自己的文件恢复事实来源；Webview 不是这些数据的权威存储。', '',
    '## 3. 功能总目录', '',
    table(['功能 ID', '领域 / 功能', '风险', '主要入口', '测试'], catalog.features.map(feature => [featureLink(feature.id), `${feature.domain} / ${feature.name}`, feature.risk, moduleLink(feature.entry), feature.tests.map(code).join('<br>')])), '']
  const domains = [...new Set(catalog.features.map(feature => feature.domain))]
  for (const [index, domain] of domains.entries()) {
    lines.push(`## 4.${index + 1} ${domain}`, '')
    for (const feature of catalog.features.filter(item => item.domain === domain)) {
      lines.push(`### ${feature.id} · ${feature.name}`, '', `**风险：${feature.risk}**。${feature.summary}`, '',
        '**代码与符号**', '', ...[feature.entry, ...feature.modules].map(item => `- ${moduleLink(item)}`), '',
        '**调用链**', '', ...feature.flow.map(flow => `- ${flow}`), '')
      if (feature.dom !== undefined) lines.push('**界面元素与处理函数**', '', table(['选择器', '处理函数'], feature.dom.map(item => [code(item.selector), code(item.function)])))
      lines.push(`**Webview → 扩展**：${refs(feature.outbound)}  `, `**扩展 → Webview**：${refs(feature.inbound)}`, '')
      if (feature.storage !== undefined) lines.push('**持久化与状态**', '', ...feature.storage.map(item => `- ${item}`), '')
      lines.push('**不可破坏的约束**', '', ...feature.invariants.map(item => `- ${item}`), '',
        `**功能依赖**：${feature.dependsOn.length === 0 ? '—' : feature.dependsOn.map(featureLink).join('、')}  `,
        `**DSH 接口**：${feature.dsh.length === 0 ? '—' : feature.dsh.map(code).join('、')}  `,
        `**回归测试**：${feature.tests.map(id => code(id)).join('、')}（命令见 §7）`, '')
    }
  }
  lines.push('## 5. 消息与事件协议清单', '',
    '以下为方向性清单，字段以生产代码中的实际对象为准；新增/删除/改名字段时同时检查生产端、消费端和 DOM 测试。扩展与 Webview 消息不是 DSH JSON-RPC 方法，不能混用。', '',
    table(['方向', '类型', '拥有者/消费位置'], [
      ...commands.toExtension.map(type => ['Webview → 扩展', code(type), '`src/extension.ts:onDidReceiveMessage`']),
      ...commands.toWebview.map(type => ['扩展 → Webview', code(type), '`media/webview.js:message listener`']),
      ...commands.dshEvents.map(type => ['DSH → SessionRuntime', code(type), '`src/agent.ts:onNotification`']),
    ]), '',
    '**协议修改检查**：验证不可信 Webview 数据；目标操作携带 `sessionId`；保留事件顺序和 delta 边界；历史回放不执行实时副作用；模型/权限/网络变更遵守 Host 边界。', '',
    '## 6. DSH 外部接口登记', '',
    '仅登记扩展实际依赖的接口，而不是复制 DSH 全项目目录。修改 DSH 时遵守其 `AGENTS.md`、构建与持久化兼容规范。', '')
  for (const item of catalog.integrations) lines.push(`### ${item.id}`, '', `- **位置**：${moduleLink(item)}`, `- **用途**：${item.usage}`, `- **修改边界**：${item.owner}`, '')
  lines.push('## 7. 测试矩阵', '',
    '先 `npm run compile`，然后按修改面选择测试。`quick` 不需要模型或 VS Code；`integration/e2e/probe` 的副作用以表中标记及测试脚本为准。', '',
    table(['ID', '级别', '模型', 'VS Code', '覆盖与副作用', '命令'], catalog.tests.map(test => [code(test.id), test.level, test.requiresModel ? '是' : '否', test.requiresVSCode ? '是' : '否', test.covers, code(test.command)])), '',
    '## 8. 已知覆盖缺口与维护', '',
    '以下是索引所反映的当前测试边界，不代表已修复问题，也不赋予测试通过超出实际覆盖范围的含义：', '',
    '- **真实 Webview 消息桥未联通验收**：`webview-suite` 使用 linkedom，`vscode-suite` 直接调用 Controller，`workbench-e2e` 仍是模拟 DOM。`extension.ts:onDidReceiveMessage` 中的 send/resend/权限/删除/问题分发需专门测试。',
    '- **结构化提问**：`QuestionBroker`、Webview 表单和校验没有直接快速测试；`question-fixture.mts` 只是真实 SDK 场景，预设回答不断言具体内容。',
    '- **审批 UI**：真实沙箱测试替换客户端请求处理；DSH→SessionRuntime→VS Code 模态框的允许、拒绝、取消需要单独覆盖。',
    '- **历史与 Diff 跨边界**：Webview 的 `resend.hasCheckpoint` 和 `modelRoute.catalog` 不由扩展消费，扩展必须重新计算权威状态；工具 Diff 未携带前端 activeSessionId，修改时重点检查源 Session 归属与真实桥测试。',
    '- **可恢复状态**：Webview 草稿、未确认模型选择、历史编辑状态、文件引用和滚动位置在真实重载后不恢复；这是当前设计边界，不是持久化能力。',
    '- **其他缺口**：真实代理实现矩阵、Webview 键盘/视觉截图、扩展请求缓存与失效监听、不可信消息载荷和 CSP 的直接测试尚未覆盖。', '',
    '**覆盖规则**：`src/` 的生产模块必须至少归属一个功能；跨功能模块以各自符号区分职责。',
    '- 功能 ID 和测试 ID 是稳定引用；重命名文件时更新路径，不随意更换 ID。',
    '- 删除功能时同时处理反向依赖、消息、存储迁移/清理、测试与 DSH 修改，详见 [维护指南](FEATURE_INDEX_MAINTENANCE.md)。',
    '- `npm run index:check` 校验数据、路径、符号、协议、设置声明和本文档是否同步；它不替代行为测试。',
    '- 索引中不登记密钥、会话正文、绝对用户路径或临时运行数据。', '')
  return lines.join('\n')
}

function main(args = process.argv.slice(2), paths = { catalogPath, indexPath }) {
  const check = args.includes('--check')
  const catalog = loadCatalog(paths.catalogPath)
  const errors = validateCatalog(catalog)
  const expected = renderIndex(catalog)
  if (check && (!fs.existsSync(paths.indexPath) || fs.readFileSync(paths.indexPath, 'utf8') !== expected)) errors.push('docs/FEATURE_INDEX.md 已过期，请运行 npm run index:generate')
  if (errors.length > 0) throw new Error(`功能索引校验失败:\n${errors.map(error => `- ${error}`).join('\n')}`)
  if (!check) fs.writeFileSync(paths.indexPath, expected)
  console.log(`Feature index ${check ? 'validated' : 'generated'}: ${catalog.features.length} features, ${catalog.tests.length} test entries, ${catalog.integrations.length} DSH integrations`)
}

if (require.main === module) {
  try { main() } catch (error) { console.error(error.message); process.exitCode = 1 }
}

module.exports = { commands, loadCatalog, validateCatalog, renderIndex, main, catalogPath, indexPath }
