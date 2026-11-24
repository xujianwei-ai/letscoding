const assert = require('node:assert/strict')
const { spawnSync } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { run, walk } = require('./vsix-package.cjs')
const { runTests } = require('@vscode/test-electron')

function credentialValues(document) {
  const values = []
  const visit = value => {
    if (Array.isArray(value)) { value.forEach(visit); return }
    if (value === null || typeof value !== 'object') return
    for (const [key, child] of Object.entries(value)) {
      if (/(?:token|secret|api[_-]?key|cookie|authorization|password|credential)/i.test(key)
        && typeof child === 'string' && child.length >= 8) values.push(child)
      else visit(child)
    }
  }
  visit(document)
  return [...new Set(values)]
}

function containsCredential(file, secrets) {
  const content = fs.readFileSync(file)
  return secrets.some(secret => content.includes(secret))
}

function securityAudit(work, directories, credentialsPath, archive, archiveName) {
  const { load } = require('js-yaml')
  const secrets = credentialValues(load(fs.readFileSync(credentialsPath, 'utf8')))
  assert.ok(secrets.length > 0, '凭据安全审计未找到可验证的授权值')
  const scannerProbe = path.join(work, 'credential-scanner-probe')
  fs.writeFileSync(scannerProbe, secrets[0], { mode: 0o600, flag: 'wx' })
  assert.ok(containsCredential(scannerProbe, secrets), '凭据扫描器自检失败')
  fs.rmSync(scannerProbe)
  const scannedFiles = []
  for (const directory of directories) {
    for (const file of walk(directory)) {
      const absolute = path.join(directory, file.path)
      if (path.resolve(absolute) === path.resolve(credentialsPath)) continue
      assert.ok(!containsCredential(absolute, secrets), `产物或日志包含授权材料：${file.path}`)
      scannedFiles.push(file.path)
    }
  }
  assert.ok(!containsCredential(archive, secrets), 'VSIX 归档包含授权材料')
  return { schemaVersion: 1, status: 'passed', archive: archiveName, credentialValueCount: secrets.length, scannedFileCount: scannedFiles.length,
    scopes: ['VSIX 归档与安装树', 'VS Code 用户数据与日志', 'globalStorage', '工作区', '除显式凭据文件外的隔离 DSH Home'],
    credentialValuesRecorded: false, logContentsRecorded: false }
}

async function main() {
  const args = process.argv.slice(2)
  assert.ok(args.every(flag => ['--with-model', '--keep'].includes(flag)), `未知参数：${args.join(' ')}`)
  const reportPath = path.resolve(__dirname, '../build/vsix-package.json')
  const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'))
  const archive = path.resolve(__dirname, '..', report.name)
  assert.ok(fs.existsSync(archive), '先执行 npm run vsix:package')
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'coding-agent-accept-'))
  const unpacked = path.join(work, 'unpacked')
  const extensions = path.join(work, 'extensions')
  fs.mkdirSync(unpacked)
  fs.mkdirSync(extensions)
  const testBootstrap = path.join(work, 'test-bootstrap')
  fs.mkdirSync(testBootstrap)
  fs.writeFileSync(path.join(testBootstrap, 'package.json'), JSON.stringify({ name: 'vsix-test-bootstrap', publisher: 'local', version: '0.0.0', main: './index.cjs', engines: { vscode: '^1.105.0' } }))
  fs.writeFileSync(path.join(testBootstrap, 'index.cjs'), 'exports.activate = () => {}\nexports.deactivate = () => {}\n')
  run('unzip', ['-q', archive, '-d', unpacked])
  const source = path.join(unpacked, 'extension')
  assert.ok(fs.existsSync(path.join(source, 'out/extension.js')), 'VSIX 缺少扩展入口')
  const manifest = JSON.parse(fs.readFileSync(path.join(source, 'package.json'), 'utf8'))
  assert.equal(manifest.capabilities?.untrustedWorkspaces?.supported, 'limited', 'VSIX 必须在未受信任工作区注册 Agent 界面')
  const actualFiles = walk(source).map(file => ({ ...file, path: file.path }))
  const expectedFiles = report.files.map(file => ({ ...file, path: file.path }))
  assert.deepEqual(actualFiles, expectedFiles, 'VSIX 解包文件、权限或哈希与打包清单不一致')
  const home = args.includes('--with-model') ? path.join(work, 'home', '.dsh') : path.join(work, 'home')
  const storage = path.join(work, 'storage')
  const workspace = path.join(work, 'workspace')
  const userData = path.join(work, 'user-data')
  for (const directory of [home, storage, workspace, userData]) fs.mkdirSync(directory, { recursive: true, mode: 0o700 })
  if (!args.includes('--with-model')) {
    const catalogPatch = path.join(home, 'offline-catalog.yml')
    fs.writeFileSync(catalogPatch, '- id: llm-deepseek\n  config:\n    baseURL: http://127.0.0.1:1/anthropic\n    models:\n      - id: vsix-offline-catalog\n', { mode: 0o600, flag: 'wx' })
    process.env.VSCODE_ACCEPT_OFFLINE_CATALOG = catalogPatch
  }
  if (args.includes('--with-model')) {
    const sourceHome = process.env.DSH_TEST_CREDENTIAL_SOURCE === undefined ? undefined : path.resolve(process.env.DSH_TEST_CREDENTIAL_SOURCE)
    assert.ok(sourceHome !== undefined, '真实模型验收必须显式提供 DSH_TEST_CREDENTIAL_SOURCE')
    const { load, dump } = require('js-yaml')
    const credentials = load(fs.readFileSync(path.join(sourceHome, '.credentials.yaml'), 'utf8'))
    const records = Object.fromEntries(Object.entries(credentials?.records ?? {}).filter(([key]) => ['deepseek-account-platform/default', 'deepseek-account-platform/device'].includes(key)))
    assert.ok(Object.keys(records).length > 0, '显式凭据源没有 DeepSeek 账户授权')
    fs.mkdirSync(home, { recursive: true, mode: 0o700 })
    fs.writeFileSync(path.join(home, '.credentials.yaml'), dump({ version: 1, records }), { mode: 0o600, flag: 'wx' })
    const models = path.join(sourceHome, 'profiles/web/cordis.patch.yml')
    if (fs.existsSync(models)) {
      fs.mkdirSync(path.join(home, 'profiles/web'), { recursive: true, mode: 0o700 })
      fs.copyFileSync(models, path.join(home, 'profiles/web/cordis.patch.yml'), fs.constants.COPYFILE_EXCL)
    }
  }
  const installation = spawnSync('/usr/bin/code', [
    '--user-data-dir=' + userData, '--extensions-dir=' + extensions,
    '--install-extension', archive, '--force', '--verbose',
  ], { encoding: 'utf8', timeout: 120_000 })
  assert.equal(installation.status, 0, `VS Code 安装 VSIX 失败：${installation.error?.message ?? installation.stdout + installation.stderr}`)
  const installed = path.join(extensions, `${manifest.publisher}.${manifest.name}-${manifest.version}`)
  assert.ok(fs.existsSync(path.join(installed, 'out/extension.js')), 'VS Code 未安装指定 VSIX')
  assert.ok(fs.statSync(path.join(installed, '.runtime-build/node/bin/node')).mode & 0o100, 'VSIX 安装后 Node 缺少执行位')
  const evidence = path.join(work, 'evidence.json')
  if (args.includes('--with-model')) delete process.env.DSH_AGENT_HOME
  else process.env.DSH_AGENT_HOME = home
  process.env.VSCODE_AGENT_DEBUG = '1'
  process.env.VSCODE_ACCEPT_ROOT = installed
  process.env.VSCODE_ACCEPT_STORAGE = storage
  process.env.VSCODE_ACCEPT_EVIDENCE = evidence
  process.env.VSCODE_ACCEPT_WORKSPACE = workspace
  process.env.VSCODE_ACCEPT_EXTENSION_ID = `${manifest.publisher}.${manifest.name}`
  delete process.env.ELECTRON_RUN_AS_NODE
  delete process.env.DSH_NODE_PATH
  try {
    const testArgs = [
      '--new-window',
      '--user-data-dir=' + userData,
      '--extensions-dir=' + extensions,
      '--extensionDevelopmentPath=' + testBootstrap,
      '--disable-extension=local.vsix-test-bootstrap',
      '--no-sandbox', '--disable-gpu-sandbox', '--disable-updates',
      '--skip-welcome', '--skip-release-notes', '--no-cached-data', workspace,
    ]
    await runTests({
      vscodeExecutablePath: '/usr/share/code/code',
      extensionDevelopmentPath: testBootstrap,
      extensionTestsPath: path.resolve(__dirname, 'vsix-accept-suite.cjs'),
      launchArgs: ['/usr/share/code/resources/app/out/main.js', ...testArgs],
      extensionTestsEnv: { ...process.env,
        PATH: '/usr/bin:/bin',
        HOME: path.dirname(home),
        DSH_AGENT_HOME: args.includes('--with-model') ? undefined : home,
        VSCODE_AGENT_DEBUG: '1',
        VSCODE_ACCEPT_ROOT: installed,
        VSCODE_ACCEPT_STORAGE: storage,
        VSCODE_ACCEPT_EVIDENCE: evidence,
        VSCODE_ACCEPT_WORKSPACE: workspace,
        VSCODE_ACCEPT_EXTENSION_ID: process.env.VSCODE_ACCEPT_EXTENSION_ID,
        VSCODE_ACCEPT_WITH_MODEL: args.includes('--with-model') ? '1' : '0',
        VSCODE_ACCEPT_OFFLINE_CATALOG: process.env.VSCODE_ACCEPT_OFFLINE_CATALOG,
      },
    })
    const result = JSON.parse(fs.readFileSync(evidence, 'utf8'))
    assert.equal(result.status, 'passed')
    assert.ok(result.checks.includes('installed manifest declares limited untrusted workspace support; test runner forces trust'))
    const withModel = args.includes('--with-model')
    if (withModel) assert.ok(result.checks.includes('single-use approval allow and reject'), '真实模型验收不得静默跳过')
    result.package = { name: report.name, version: report.version, bytes: report.bytes, sha256: report.sha256, fileCount: report.fileCount }
    result.mode = withModel ? 'live-model' : 'offline'
    if (withModel) result.security = securityAudit(work, [installed, userData, storage, workspace, home], path.join(home, '.credentials.yaml'), archive, report.name)
    fs.writeFileSync(path.resolve(__dirname, `../build/vsix-acceptance${withModel ? '-model' : '-offline'}.json`), JSON.stringify(result, null, 2) + '\n')
    console.log('VSIX installed-artifact acceptance passed:', JSON.stringify(result))
  } finally {
    if (!args.includes('--keep')) fs.rmSync(work, { recursive: true, force: true })
    else console.log('Preserved acceptance sandbox:', work)
  }
}
if (require.main === module) main().catch(error => { console.error(error.stack); process.exitCode = 1 })
module.exports = { credentialValues, securityAudit }
