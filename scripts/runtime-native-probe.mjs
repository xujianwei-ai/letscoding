import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const driverPath = fileURLToPath(import.meta.url)
const runtimeRoot = process.env.DSH_RUNTIME_ROOT
assert.ok(runtimeRoot && path.isAbsolute(runtimeRoot), '探针必须指定运行时根目录')
const require = createRequire(path.join(runtimeRoot, 'package.json'))
const { launcherPath, grantArgs, probe } = await import(require.resolve('@deepseek-ai/node-addon-system/landlock-run'))
const { tryLockExclusive } = await import(require.resolve('@deepseek-ai/node-addon-system/flock'))
const sqlitePackage = path.dirname(require.resolve('@deepseek-ai/dsh-session-query-sqlite/package.json'))
const { SESSION_QUERY_SQLITE_APPLICATION_ID, SESSION_QUERY_SQLITE_SCHEMA_VERSION } = await import(path.join(sqlitePackage, 'lib/index.js'))
const { Context } = await import(require.resolve('@deepseek-ai/cordis'))
const { DatabaseSync } = await import('node:sqlite')
const digest = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex')
const expectedVersion = process.env.DSH_EXPECT_NODE_VERSION
if (expectedVersion !== undefined) assert.equal(process.version, expectedVersion, '固定 Node 版本不匹配')
assert.equal(process.versions.electron, undefined, '运行时不得是 Electron')
assert.equal(process.env.ELECTRON_RUN_AS_NODE, undefined, '不得通过 Electron 环境变量运行探针')
assert.equal(process.platform, 'linux', 'B2 首批仅支持 Linux')
assert.equal(process.arch, 'x64', 'B2 首批仅支持 x64')
const glibc = process.report.getReport().header.glibcVersionRuntime
assert.equal(typeof glibc, 'string', '首批运行时必须使用 glibc')

const work = process.env.DSH_PROBE_WORK
assert.ok(work && path.isAbsolute(work), '探针必须指定独立的绝对临时目录')
fs.mkdirSync(work, { recursive: true })
const expectedHashes = process.env.DSH_EXPECT_NODE_HASH === undefined ? undefined : new Map(Object.entries(JSON.parse(process.env.DSH_EXPECT_NODE_HASH)))
function binary(file, executable = false) {
  assert.ok(path.isAbsolute(file), '原生路径必须绝对定位')
  assert.ok(file.startsWith(path.join(runtimeRoot, 'node_modules') + path.sep) || file === process.execPath, '原生文件必须属于当前暂存树或已安装 Node')
  const stat = fs.lstatSync(file)
  assert.ok(stat.isFile() && !stat.isSymbolicLink(), `原生文件必须是常规文件: ${file}`)
  const hash = digest(file)
  if (expectedHashes !== undefined && file === process.execPath) assert.equal(hash, expectedHashes.get(file), `安装后 Node 哈希不一致: ${file}`)
  if (executable) fs.accessSync(file, fs.constants.X_OK)
  return { file, sha256: hash, mode: (stat.mode & 0o777).toString(8) }
}

const sqlitePath = path.join(work, 'session-search.sqlite')
const sqliteContext = new Context()
await sqliteContext.plugin((await import(require.resolve('@deepseek-ai/dsh-session'))).default)
await sqliteContext.plugin((await import(require.resolve('@deepseek-ai/dsh-session-projection'))).default)
const sqliteFiber = await sqliteContext.plugin((await import(require.resolve('@deepseek-ai/dsh-session-query-sqlite'))).default, { path: sqlitePath, openAt: 'startup', journalMode: 'wal' })
await sqliteFiber.dispose()
const sqlite = new DatabaseSync(sqlitePath)
try {
  assert.equal(sqlite.prepare('PRAGMA application_id').get().application_id, SESSION_QUERY_SQLITE_APPLICATION_ID)
  assert.equal(sqlite.prepare('PRAGMA user_version').get().user_version, SESSION_QUERY_SQLITE_SCHEMA_VERSION)
  sqlite.exec('BEGIN')
  sqlite.prepare('INSERT INTO persisted_docs (text, session_id, seq, type, time, surface, codepoint_length) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run('native sqlite verification', 'probe-session', 1, 'message', 1, 'user', 28)
  sqlite.exec('COMMIT')
  const row = sqlite.prepare("SELECT text, session_id AS sessionId FROM persisted_docs WHERE persisted_docs MATCH 'sqlite'").get()
  assert.equal(row.text, 'native sqlite verification')
  assert.equal(row.sessionId, 'probe-session')
} finally { sqlite.close() }
const reopened = new DatabaseSync(sqlitePath)
try { assert.equal(reopened.prepare('SELECT count(*) AS count FROM persisted_docs').get().count, 1) } finally { reopened.close() }
const lockPath = path.join(work, 'session.lock')
const owner = fs.openSync(lockPath, 'wx+', 0o600)
const contender = fs.openSync(lockPath, 'r+')
try {
  await tryLockExclusive(owner)
  await assert.rejects(tryLockExclusive(contender), error => ['EAGAIN', 'EWOULDBLOCK'].includes(error.code) && error.syscall === 'flock')
  fs.closeSync(owner)
  await tryLockExclusive(contender)
} finally {
  for (const fd of [owner, contender]) { try { fs.closeSync(fd) } catch (error) { if (error.code !== 'EBADF') throw error } }
}

const launcher = launcherPath()
const landlock = probe(launcher)
assert.notEqual(landlock, 'unusable', 'Landlock 缺失或当前内核不强制；不能把交付能力标记为可用')
const denied = path.join(work, 'denied.txt')
const deniedRun = spawnSync(launcher, [...grantArgs({ readOnly: ['/'] }), '--', '/bin/sh', '-c', `/bin/sh -c 'echo denied > "${denied}"'; exit 0`], { encoding: 'utf8', timeout: 10000 })
assert.equal(deniedRun.status, 0, deniedRun.stderr)
assert.equal(fs.existsSync(denied), false, 'Landlock 必须阻止子进程越权写入')
const granted = path.join(work, 'granted.txt')
const grantedRun = spawnSync(launcher, [...grantArgs({ readOnly: ['/'], readWrite: [work] }), '--', '/bin/sh', '-c', 'printf granted > "$1"', 'probe', granted], { encoding: 'utf8', timeout: 10000 })
assert.equal(grantedRun.status, 0, grantedRun.stderr)
assert.equal(fs.readFileSync(granted, 'utf8'), 'granted')
const failure = path.join(work, 'fail-closed.txt')
const failureRun = spawnSync(launcher, ['--ro', path.join(work, 'missing-grant'), '--', '/bin/sh', '-c', `printf unexpected > "${failure}"`], { encoding: 'utf8', timeout: 10000 })
assert.equal(failureRun.status, 125)
assert.match(failureRun.stderr, /^landlock-run: /)
assert.equal(fs.existsSync(failure), false, '无效授权路径必须拒绝执行命令')

const platform = `@deepseek-ai/node-addon-system-${process.platform}-${process.arch}`
const native = path.join(runtimeRoot, 'node_modules', ...platform.split('/'), 'bin')
const report = {
  schemaVersion: 1,
  runtimeRoot,
  driver: path.basename(driverPath),
  node: { version: process.version, electron: process.versions.electron ?? null, napi: process.versions.napi, glibc, executable: binary(process.execPath, true) },
  sqlite: { schemaVersion: SESSION_QUERY_SQLITE_SCHEMA_VERSION, fts5: true, persistent: true },
  flock: { contention: true, closeRelease: true },
  landlock: { enforcement: landlock, deniedWrite: true, grantedWrite: true, childConfinement: true, failClosed: true },
  binaries: [binary(launcher, true), binary(path.join(native, 'glibc/system.node')), binary(path.join(native, 'musl/system.node'))],
}
const expectedNative = process.env.DSH_EXPECT_NATIVE_HASH
if (expectedNative !== undefined) {
  const expected = JSON.parse(expectedNative)
  assert.equal(expected.length, report.binaries.length)
  for (const [index, item] of expected.entries()) {
    assert.equal(report.binaries[index].file, path.join(runtimeRoot, path.relative(process.env.DSH_PROBE_SOURCE, item.file)), '安装后的原生路径发生变化')
    assert.equal(report.binaries[index].sha256, item.sha256, `安装后的原生哈希发生变化: ${item.file}`)
  }
}
process.stdout.write(`${JSON.stringify(report)}\n`)
