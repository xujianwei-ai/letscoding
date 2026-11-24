const assert = require('node:assert/strict')
const { spawnSync } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { prepareNode } = require('./prepare-node.cjs')
const { root, readJson, sha256 } = require('./runtime-closure.cjs')

function cleanEnvironment(overrides = {}) {
  return Object.fromEntries(Object.entries({ ...process.env, ...overrides }).filter(([, value]) => value !== undefined))
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', timeout: options.timeout ?? 120000, ...options })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} 失败 (${result.status}): ${result.stderr || result.stdout}`)
  return result.stdout.trim()
}

function nativeProbe(options = {}) {
  const config = readJson(options.baselinePath ?? path.join(root, 'config/runtime-baseline.json'))
  const node = options.node ?? prepareNode(options.baselinePath).executable
  const staging = options.staging ?? path.join(root, config.dsh.productionClosure.stagingDirectory)
  const closure = readJson(path.join(root, 'build/dsh-production-closure.json'))
  assert.equal(closure.status, 'artifact-inventory-complete', '原生验证需要 B1 的实际暂存清单')
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-native-probe-'))
  const driver = path.join(work, 'runtime-native-probe.mjs')
  const expectedNode = {
    [node]: sha256(fs.readFileSync(node)),
  }
  try {
    fs.copyFileSync(path.join(__dirname, 'runtime-native-probe.mjs'), driver)
    const output = run(node, [driver], {
      cwd: staging,
      env: cleanEnvironment({
        DSH_EXPECT_NODE_VERSION: `v${config.node.version}`,
        DSH_PROBE_WORK: work,
        DSH_RUNTIME_ROOT: staging,
        DSH_PROBE_SOURCE: staging,
        DSH_EXPECT_NODE_HASH: JSON.stringify(expectedNode),
        DSH_EXPECT_NATIVE_HASH: JSON.stringify(closure.native.payloads.map(item => ({ file: path.join(staging, 'node_modules', ...closure.native.package.split('/'), item.path), sha256: item.sha256 }))),
        ELECTRON_RUN_AS_NODE: undefined,
      }),
    })
    const report = JSON.parse(output)
    assert.equal(report.node.electron, null)
    assert.equal(report.node.version, `v${config.node.version}`)
    assert.equal(report.sqlite.fts5, true)
    assert.ok(['full', 'partial'].includes(report.landlock.enforcement))
    return report
  } finally {
    fs.rmSync(work, { recursive: true, force: true })
  }
}

function packedInstall(options = {}) {
  const repository = options.repository ?? path.resolve(root, './dsh-learning/deepseek-harness')
  const source = path.join(repository, 'native/system/packages/entry/node_modules/@deepseek-ai/node-addon-system-linux-x64')
  const entry = path.join(repository, 'native/system/packages/entry')
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-native-install-'))
  try {
    const packages = path.join(work, 'packages')
    fs.mkdirSync(packages)
    const platformArchive = run('npm', ['pack', source, '--ignore-scripts', '--json', '--pack-destination', packages], { cwd: repository })
    const platformName = JSON.parse(platformArchive)[0].filename
    const entryArchive = run(process.execPath, [path.join(repository, 'node_modules/pnpm/bin/pnpm.cjs'), 'pack', '--config.ignore-scripts=true', '--json', '--pack-destination', packages], { cwd: entry })
    const entryName = JSON.parse(entryArchive).filename
    const consumer = path.join(work, 'consumer')
    const manifest = readJson(path.join(entry, 'package.json'))
    const dependencies = Object.fromEntries([entryName, platformName].map(file => {
      const tarball = path.resolve(packages, file)
      assert.ok(tarball.startsWith(packages + path.sep) && fs.statSync(tarball).isFile(), 'tarball 必须位于本次安装目录')
      return [file.includes('linux-x64') ? `${manifest.name}-linux-x64` : manifest.name, `file:${tarball}`]
    }))
    fs.mkdirSync(consumer)
    fs.writeFileSync(path.join(consumer, 'package.json'), JSON.stringify({ name: 'native-install-check', version: '0.0.0', private: true, type: 'module', dependencies }))
    const node = prepareNode().executable
    run('npm', ['install', '--offline', '--ignore-scripts', '--no-audit', '--no-fund', '--package-lock=false'], { cwd: consumer, env: cleanEnvironment({ npm_config_cache: path.join(work, 'npm-cache') }) })
    const platform = path.join(consumer, 'node_modules', '@deepseek-ai/node-addon-system-linux-x64')
    const staged = path.join(root, '.runtime-build/dsh')
    const expected = []
    for (const relative of ['bin/landlock-run', 'bin/glibc/system.node', 'bin/musl/system.node']) {
      const sourceFile = path.join(staged, 'node_modules', '@deepseek-ai/node-addon-system-linux-x64', relative)
      const targetFile = path.join(platform, relative)
      const hash = sha256(fs.readFileSync(targetFile))
      assert.equal(hash, sha256(fs.readFileSync(sourceFile)), `安装包与暂存区不一致: ${relative}`)
      fs.accessSync(targetFile, fs.constants.X_OK)
      expected.push({ file: sourceFile, sha256: hash })
    }
    const installedNode = path.join(work, 'node/bin/node')
    fs.mkdirSync(path.dirname(installedNode), { recursive: true })
    fs.copyFileSync(node, installedNode)
    fs.accessSync(installedNode, fs.constants.X_OK)
    const config = readJson(path.join(root, 'config/runtime-baseline.json'))
    const driver = path.join(work, 'runtime-native-install-probe.mjs')
    fs.copyFileSync(path.join(__dirname, 'runtime-native-install-probe.mjs'), driver)
    const output = run(installedNode, [driver], {
      cwd: consumer,
      env: cleanEnvironment({ DSH_EXPECT_NODE_VERSION: `v${config.node.version}`, DSH_PROBE_WORK: path.join(work, 'probe'), DSH_RUNTIME_ROOT: consumer, DSH_PROBE_SOURCE: staged, DSH_EXPECT_NODE_HASH: JSON.stringify({ [installedNode]: sha256(fs.readFileSync(installedNode)) }), DSH_EXPECT_NATIVE_HASH: JSON.stringify(expected), ELECTRON_RUN_AS_NODE: undefined }),
    })
    const report = JSON.parse(output)
    report.install = { layout: 'native-tarball-offline-npm', packageCount: 2, lifecycleScripts: false, nodeExecutable: true, nativeExecutable: true, binaries: expected }
    return report
  } finally { fs.rmSync(work, { recursive: true, force: true }) }
}

if (require.main === module) {
  try {
    const install = process.argv.includes('--install-check')
    assert.ok(process.argv.slice(2).every(arg => ['--install-check'].includes(arg)), '仅支持 --install-check')
    const report = install ? packedInstall() : nativeProbe()
    console.log(`Native runtime: Node ${report.node.version}${report.node.glibc === undefined ? '' : `, glibc ${report.node.glibc}`}${report.sqlite === undefined ? '' : ', SQLite FTS5'}, flock exclusion/release`)
    console.log(`Landlock: ${report.landlock.enforcement}; ${report.landlock.failClosed === undefined ? 'denied/granted' : 'denied/granted/child/fail-closed'} verified`)
    if (report.install) console.log('Native tarballs and copied Node retained hashes and executable permissions')
    const destination = path.join(root, 'build', install ? 'runtime-install-report.json' : 'runtime-native-report.json')
    fs.mkdirSync(path.dirname(destination), { recursive: true })
    fs.writeFileSync(destination, `${JSON.stringify(report, null, 2)}\n`)
    console.log(`Report: ${destination}`)
  } catch (error) { console.error(error instanceof Error ? error.stack : error); process.exitCode = 1 }
}

module.exports = { nativeProbe, packedInstall, run, cleanEnvironment }
