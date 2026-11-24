const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

async function main() {
  const { harnessLaunchOptions, createHarness, CATALOG_BOOTSTRAP_ROUTE, defaultDshHome, webProviderPatch } = await import('../out/runtime.js')
  const { migrateRemovedBuiltinRoute } = await import('../out/modelRouting.js')
  const { hostError } = await import('../out/diagnostics.js')
  const os = await import('node:os')
  assert.equal(defaultDshHome({}), path.join(os.homedir(), '.dsh'))
  assert.equal(defaultDshHome({ DSH_HOME: '/tmp/explicit-dsh-home' }), '/tmp/explicit-dsh-home')
  const settings = new Map([['provider', 'kimi-coding'], ['model', 'k3']])
  const catalog = { groups: [{ id: 'deepseek-account', name: 'DeepSeek', models: [{ id: 'deepseek-flash', name: 'DeepSeek Flash' }] }], failures: [] }
  assert.deepEqual(await migrateRemovedBuiltinRoute({ provider: 'kimi-coding', model: 'k3' }, catalog,
    async (key, value) => { settings.set(key, value) }), { provider: 'deepseek-account', model: 'deepseek-flash' })
  assert.equal(settings.get('model'), 'deepseek-flash', 'Removed built-in routes recover to a catalog model')
  const custom = new Map([['provider', 'custom-provider'], ['model', 'offline']])
  assert.equal(await migrateRemovedBuiltinRoute({ provider: 'custom-provider', model: 'offline' }, catalog,
    async (key, value) => { custom.set(key, value) }), undefined, 'A custom unavailable provider is never silently replaced')
  assert.equal(custom.get('provider'), 'custom-provider')
  assert.equal(await migrateRemovedBuiltinRoute({ provider: 'kimi-coding', model: 'k3' }, { groups: [], failures: [] },
    async () => { throw new Error('An empty catalog must not overwrite a saved route') }), undefined)
  assert.equal(CATALOG_BOOTSTRAP_ROUTE.provider, 'deepseek-official')
  const root = path.resolve(__dirname, '..')
  const dsh = path.join(root, '.runtime-build/dsh')
  const staging = JSON.parse(fs.readFileSync(path.join(dsh, 'runtime-staging.json'), 'utf8'))
  const node = JSON.parse(fs.readFileSync(path.join(root, '.runtime-build/node/runtime-node.json'), 'utf8'))
  const launch = harnessLaunchOptions({ dshHome: '/tmp/private-home', cwd: root })
  assert.equal(launch.nodePath, path.join(root, '.runtime-build/node/bin/node'))
  assert.equal(launch.dshBin, path.join(dsh, 'node_modules/@deepseek-ai/dsh/lib/bin.js'))
  assert.equal(launch.processCwd, dsh)
  assert.equal(launch.patches, undefined, 'Built profile must not receive the source-only patch')
  assert.equal(staging.entry, 'node_modules/@deepseek-ai/dsh/lib/bin.js')
  assert.equal(node.version, '24.9.0')
  const missingRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-missing-'))
  fs.rmSync(missingRoot, { recursive: true, force: true })
  assert.throws(() => harnessLaunchOptions({
    dshHome: root, cwd: root, extensionRoot: missingRoot,
    dshRepository: path.resolve(root, '../dsh-learning/deepseek-harness'),
    nodePath: path.join(root, '.runtime-build/node/bin/node'),
    processEnv: { DSH_NODE_PATH: path.join(root, '.runtime-build/node/bin/node') },
  }), /内置运行时.*缺少文件.*不会回退到开发环境/s)
  const isolated = harnessLaunchOptions({
    dshHome: root, cwd: root, extensionRoot: root, processEnv: {},
  })
  assert.equal(isolated.nodePath, path.join(root, '.runtime-build/node/bin/node'), '空 PATH 不能改变 bundled Node')
  const isolatedHarness = new (await import(path.join(dsh, 'node_modules/@deepseek-ai/dsh-sdk-client/lib/index.js'))).DeepSeekHarness(isolated)
  assert.equal(isolatedHarness.client.runtime.command, isolated.nodePath)
  assert.equal(isolatedHarness.client.runtime.args[0], isolated.dshBin, '空 PATH 不能回退到源码入口')
  assert.throws(() => harnessLaunchOptions({ dshHome: root, cwd: root, extensionRoot: missingRoot, runtimeMode: 'source', nodePath: '/missing/node', processEnv: {} }), /源码模式需要普通 Node/)
  assert.throws(() => harnessLaunchOptions({ dshHome: root, cwd: root, runtimeMode: 'source', dshRepository: '/tmp/source-missing', processEnv: { DSH_NODE_PATH: '/missing/node', PATH: '/missing' } }), /源码模式需要普通 Node/)
  assert.throws(() => harnessLaunchOptions({ dshHome: root, cwd: root, runtimeMode: 'source', dshRepository: '/tmp/source-missing', nodePath: path.join(root, '.runtime-build/node/bin/node'), processEnv: { PATH: '/missing' } }), /源码运行时.*apps\/cli\/lib\/bin\.js/)
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-launch-options-'))
  try {
    const brokenDsh = path.join(temporary, 'broken-dsh.js')
    fs.writeFileSync(brokenDsh, 'invalid JavaScript source {\n')
    const harness = new (await import(path.join(dsh, 'node_modules/@deepseek-ai/dsh-sdk-client/lib/index.js'))).DeepSeekHarness({ nodePath: path.join(root, '.runtime-build/node/bin/node'), dshBin: brokenDsh, dshHome: temporary, cwd: temporary, initializeTimeoutMs: 1_000, shutdownTimeoutMs: 50, disposeEofGraceMs: 50, disposeGraceMs: 50 })
    assert.equal(harness.client.options.nodePath, path.join(root, '.runtime-build/node/bin/node'), 'SDK owns the final explicit executable')
    await assert.rejects(harness.start(), /JSON-RPC|Transport|closed|failed to start/)
    await harness.close()
    assert.equal(webProviderPatch(temporary, path.join(temporary, 'storage/patches')), undefined)
    assert.equal(fs.existsSync(path.join(root, '.runtime')), false, 'Normal runtime configuration must not write beside extension code')
    const malformed = path.join(temporary, 'profiles/web')
    fs.mkdirSync(malformed, { recursive: true })
    fs.writeFileSync(path.join(malformed, 'cordis.patch.yml'), "- id: llm-pi-ai\n  name: '@deepseek-ai/dsh-llm-pi-ai'\n  config:\n    providers:\n      test: {}\n")
    const patch = webProviderPatch(temporary, path.join(temporary, 'storage/patches'))
    assert.ok(patch.startsWith(path.join(temporary, 'storage/patches') + path.sep))
    assert.match(fs.readFileSync(patch, 'utf8'), /providers/)
    assert.equal(fs.statSync(patch).mode & 0o077, 0)
    fs.writeFileSync(patch, '- id: replaced\n')
    assert.throws(() => webProviderPatch(temporary, path.join(temporary, 'storage/patches')), /内容不一致/)
  } finally { fs.rmSync(temporary, { recursive: true, force: true }) }
  assert.match(hostError(new Error('Request timed out. [code TIMEOUT]')), /\[模型\]/)
  assert.doesNotMatch(hostError(new Error('Request timed out. [code TIMEOUT]')), /安装 Node|源码路径/)
  assert.match(hostError(new Error('built-in runtime is missing')), /\[Host\]/)
  console.log('Bundled/source separation, corrupt runtime refusal, SDK-owned spawn and private patch storage passed')
}
// The integration launcher starts VS Code through system Node; the DSH probe itself
// still uses the locked Node selected by harnessLaunchOptions().
if (require.main === module) main().catch(error => { console.error(error); process.exitCode = 1 })
