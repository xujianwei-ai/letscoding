import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'

const consumer = process.env.DSH_RUNTIME_ROOT
assert.ok(consumer && path.isAbsolute(consumer))
const require = createRequire(path.join(consumer, 'package.json'))
const { launcherPath, grantArgs, probe } = await import(require.resolve('@deepseek-ai/node-addon-system/landlock-run'))
const { tryLockExclusive } = await import(require.resolve('@deepseek-ai/node-addon-system/flock'))

assert.equal(process.version, process.env.DSH_EXPECT_NODE_VERSION)
assert.equal(process.versions.electron, undefined, '安装后的固定 Node 不得是 Electron')
assert.equal(process.env.ELECTRON_RUN_AS_NODE, undefined)
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-native-installed-probe-'))
const descriptors = []
try {
  const file = path.join(work, 'lock')
  const owner = fs.openSync(file, 'wx+', 0o600)
  const contender = fs.openSync(file, 'r+')
  descriptors.push(owner, contender)
  await tryLockExclusive(owner)
  await assert.rejects(tryLockExclusive(contender), { code: 'EAGAIN', syscall: 'flock' })
  fs.closeSync(owner)
  await tryLockExclusive(contender)

  const launcher = launcherPath()
  const enforcement = probe(launcher)
  assert.notEqual(enforcement, 'unusable', '安装后的 Landlock 必须可执行且内核可强制')
  fs.accessSync(launcher, fs.constants.X_OK)
  const denied = path.join(work, 'denied.txt')
  const deniedRun = spawnSync(launcher, [...grantArgs({ readOnly: ['/'] }), '--', '/bin/sh', '-c', `echo denied > "${denied}"`], { encoding: 'utf8', timeout: 10000 })
  assert.notEqual(deniedRun.status, 0, deniedRun.stderr)
  assert.equal(fs.existsSync(denied), false)
  const granted = path.join(work, 'granted.txt')
  const grantedRun = spawnSync(launcher, [...grantArgs({ readOnly: ['/'], readWrite: [work] }), '--', '/bin/sh', '-c', `printf granted > "${granted}"`], { encoding: 'utf8', timeout: 10000 })
  assert.equal(grantedRun.status, 0, grantedRun.stderr)
  assert.equal(fs.readFileSync(granted, 'utf8'), 'granted')
  console.log(JSON.stringify({ node: { version: process.version, electron: null, glibc: process.report.getReport().header.glibcVersionRuntime }, flock: { contention: true, closeRelease: true }, landlock: { enforcement, deniedWrite: true, grantedWrite: true } }))
} finally {
  for (const fd of descriptors) { try { fs.closeSync(fd) } catch (error) { if (error.code !== 'EBADF') throw error } }
  fs.rmSync(work, { recursive: true, force: true })
}
