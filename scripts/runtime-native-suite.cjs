const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { nativeProbe, packedInstall, run, cleanEnvironment } = require('./runtime-native.cjs')
const { root, readJson } = require('./runtime-closure.cjs')

const staging = path.join(root, '.runtime-build/dsh')
const config = readJson(path.join(root, 'config/runtime-baseline.json'))
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-native-suite-'))
try {
  const driver = path.join(work, 'runtime-native-probe.mjs')
  fs.copyFileSync(path.join(__dirname, 'runtime-native-probe.mjs'), driver)
  assert.throws(() => run(process.execPath, [driver], {
    env: cleanEnvironment({ DSH_RUNTIME_ROOT: staging, DSH_PROBE_WORK: path.join(work, 'wrong-node'), DSH_EXPECT_NODE_VERSION: 'v0.0.0', ELECTRON_RUN_AS_NODE: undefined }),
  }), /固定 Node 版本不匹配/)

  const copy = path.join(work, 'runtime')
  fs.cpSync(staging, copy, { recursive: true, dereference: true })
  const native = path.join(copy, 'node_modules/@deepseek-ai/node-addon-system-linux-x64/bin')
  const launcher = path.join(native, 'landlock-run')
  const original = fs.readFileSync(launcher)
  const mode = fs.statSync(launcher).mode
  fs.rmSync(launcher)
  assert.throws(() => nativeProbe({ staging: copy, node: process.execPath }), /Landlock 缺失或当前内核不强制/)
  fs.writeFileSync(launcher, original, { mode })
  fs.chmodSync(launcher, 0o644)
  assert.throws(() => nativeProbe({ staging: copy, node: process.execPath }), /Landlock 缺失或当前内核不强制/)
  fs.chmodSync(launcher, mode)
  fs.appendFileSync(path.join(native, 'glibc/system.node'), Buffer.from('corrupt'))
  assert.throws(() => nativeProbe({ staging: copy, node: process.execPath }), /flock|原生/)
  console.log('Runtime native: wrong Node, missing/non-executable Landlock and damaged glibc addon rejected')

  if (process.argv.includes('--with-install')) {
    const report = packedInstall()
    assert.equal(report.install.lifecycleScripts, false)
    assert.equal(report.install.nativeExecutable, true)
    assert.ok(['full', 'partial'].includes(report.landlock.enforcement))
    console.log('Native install: offline tarballs, fixed Node, permissions and behavior passed')
  }
  console.log(`Runtime native suite passed on ${config.node.version}`)
} finally { fs.rmSync(work, { recursive: true, force: true }) }
