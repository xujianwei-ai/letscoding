const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

async function run() {
  const vscode = require('vscode')
  const { harnessLaunchOptions } = await import('../out/runtime.js')
  const home = process.env.DSH_AGENT_HOME
  const workspace = vscode.workspace.workspaceFolders[0].uri.fsPath
  assert.ok(process.versions.electron, 'B4 必须在真实 Electron Extension Host 中执行')
  const launch = harnessLaunchOptions({
    runtimeMode: 'bundled', extensionRoot: path.resolve(__dirname, '..'), runtimeStorage: path.join(home, 'patches'),
    dshHome: home, cwd: workspace, approvalRequests: false, provider: 'kimi-coding', model: 'k3',
    initializeTimeoutMs: 60_000, requestTimeoutMs: 20_000,
  })
  const catalogPatch = path.join(home, 'offline-catalog.yml')
  fs.writeFileSync(catalogPatch, '- id: llm-deepseek\n  config:\n    baseURL: http://127.0.0.1:1/anthropic\n    models:\n      - id: b4-offline-catalog\n', { mode: 0o600 })
  const { DeepSeekHarness } = await import('@deepseek-ai/dsh-sdk-client')
  const harness = new DeepSeekHarness({
    ...launch,
    patches: [catalogPatch],
    // The API-key adapter remains dormant without a credential reference. This
    // dummy value never contacts a provider: the patch uses a refused local port.
    env: { ...launch.env, DEEPSEEK_API_KEY: 'b4-offline-probe' },
  })
  fs.writeFileSync(path.join(home, 'b4-launch.json'), JSON.stringify(harness.client.runtime, (key, value) => typeof value === 'function' ? value() : value))
  try {
    assert.equal(process.versions.electron !== undefined, true)
    assert.notEqual(launch.nodePath, process.execPath, 'Electron 绝不能作为 DSH Host')
    assert.equal(path.basename(launch.nodePath), 'node')
    assert.equal(launch.env.NODE, undefined, 'Electron NODE 注入不能让 Cordis 重新启动 VS Code')
    assert.equal(launch.env.ELECTRON_RUN_AS_NODE, undefined)
    assert.equal(launch.env.NODE_DISABLE_COMPILE_CACHE, '1')
    assert.equal(fs.realpathSync(launch.nodePath), fs.realpathSync(path.resolve(__dirname, '../.runtime-build/node/bin/node')))
    assert.ok(fs.existsSync(launch.dshBin), '发布模式必须启动随包 DSH 编译入口')
    assert.ok(!launch.dshBin.includes('/src/bin.ts'), '发布模式不得加载 TypeScript 源码')
    assert.ok(!(launch.patches ?? []).some(file => file.includes('/src/')), '发布模式不得加载源码补丁')
    assert.equal(harness.client.runtime.command, launch.nodePath, '实际 SDK resolveDshLaunch 必须尊重普通 Node，而不是旧产物的 process.execPath')
    await harness.start()
    assert.deepEqual(await harness.listSessions(), { sessions: [] }, '无凭据隔离 Home 不应包含会话')
    const catalog = await harness.listModels()
    console.log('Bundled model groups:', catalog.groups.map(group => group.id))
    assert.ok(catalog.groups.some(group => group.id === 'deepseek-official' && group.models.some(model => model.id === 'b4-offline-catalog')), '显式模型配置必须经 SDK profile 返回目录')
    console.log('B4 Electron uses the SDK public nodePath with bundled DSH and preserves stdio close')
  } finally { await harness.client.close() }
  await assert.rejects(harness.client.listSessions(), /closed/)
}
module.exports = { run }
