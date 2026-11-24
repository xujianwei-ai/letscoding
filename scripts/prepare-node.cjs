const assert = require('node:assert/strict')
const { spawnSync } = require('node:child_process')
const { createHash } = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')
const { baselinePath, validateLock } = require('./runtime-baseline.cjs')

const root = path.resolve(__dirname, '..')

function download(url, destination) {
  if (fs.existsSync(destination)) return
  fs.mkdirSync(path.dirname(destination), { recursive: true })
  const result = spawnSync('curl', ['--fail', '--show-error', '--location', '--proto', '=https', '--max-time', '180', '--output', destination, url], { stdio: ['ignore', 'inherit', 'inherit'] })
  if (result.error || result.status !== 0) throw new Error(`Node 下载失败 ${url}: ${result.error?.message ?? `curl 退出码 ${result.status}`}`)
}

function verifiedDownload(url, expected, destination) {
  if (!fs.existsSync(destination) || createHash('sha256').update(fs.readFileSync(destination)).digest('hex') !== expected) {
    const temporary = `${destination}.download`
    fs.rmSync(temporary, { force: true })
    download(url, temporary)
    const actual = createHash('sha256').update(fs.readFileSync(temporary)).digest('hex')
    if (actual !== expected) {
      fs.rmSync(temporary, { force: true })
      throw new Error(`下载文件 SHA-256 不匹配: ${url}；期望 ${expected}，实际 ${actual}`)
    }
    fs.mkdirSync(path.dirname(destination), { recursive: true })
    fs.renameSync(temporary, destination)
  }
}

function prepareNode(lockFile = baselinePath, outputRoot = path.join(root, '.runtime-build')) {
  const lock = validateLock(JSON.parse(fs.readFileSync(lockFile, 'utf8')))
  const origin = new URL(`v${lock.node.version}/`, lock.node.origin)
  const archives = path.join(outputRoot, 'downloads')
  const checksums = path.join(archives, `node-v${lock.node.version}-SHASUMS256.txt`)
  const archive = path.join(archives, lock.node.archive)
  verifiedDownload(new URL(lock.node.checksumManifest, origin).href, lock.node.checksumsSha256, checksums)
  const entries = fs.readFileSync(checksums, 'utf8').split('\n').filter(Boolean).map(line => line.match(/^([a-f0-9]{64})  (\S+)$/))
  assert.ok(entries.every(Boolean), 'Node 官方校验文件格式无效')
  const expected = new Map(entries.map(match => [match[2], match[1]]))
  assert.equal(expected.get(lock.node.archive), lock.node.sha256, '锁定 SHA-256 与 Node 官方 SHASUMS256.txt 不一致')
  verifiedDownload(new URL(lock.node.archive, origin).href, lock.node.sha256, archive)
  const target = path.join(outputRoot, 'node')
  const manifestPath = path.join(target, 'runtime-node.json')
  const executable = path.join(target, lock.node.executable)
  const installed = fs.existsSync(manifestPath) ? JSON.parse(fs.readFileSync(manifestPath, 'utf8')) : undefined
  if (installed?.version !== lock.node.version || installed?.sha256 !== lock.node.sha256 || !fs.existsSync(executable)) {
    fs.rmSync(target, { recursive: true, force: true })
    const staging = `${target}.staging`
    fs.rmSync(staging, { recursive: true, force: true })
    fs.mkdirSync(staging, { recursive: true })
    const extraction = spawnSync('tar', ['-xJf', archive, '--strip-components=1', `node-v${lock.node.version}-linux-x64/bin/node`, `node-v${lock.node.version}-linux-x64/LICENSE`], { cwd: staging, encoding: 'utf8' })
    if (extraction.error || extraction.status !== 0) {
      fs.rmSync(staging, { recursive: true, force: true })
      throw new Error(`Node 解压失败: ${extraction.error?.message ?? extraction.stderr}`)
    }
    fs.writeFileSync(path.join(staging, 'runtime-node.json'), `${JSON.stringify({ version: lock.node.version, platform: lock.platform, archive: lock.node.archive, sha256: lock.node.sha256, origin: origin.href }, null, 2)}\n`)
    fs.renameSync(staging, target)
  }
  const probe = spawnSync(executable, ['-p', 'JSON.stringify({version:process.version,electron:process.versions.electron ?? null,sqlite:typeof process.getBuiltinModule("node:sqlite").DatabaseSync})'], { encoding: 'utf8' })
  if (probe.error || probe.status !== 0) throw new Error(`内置 Node 启动检查失败: ${probe.error?.message ?? probe.stderr}`)
  const actual = JSON.parse(probe.stdout)
  assert.equal(actual.version, `v${lock.node.version}`, '内置 Node 实际版本与锁定版本不一致')
  assert.equal(actual.electron, null, '内置 Node 不得是 Electron')
  assert.equal(actual.sqlite, 'function', '内置 Node 必须支持 node:sqlite DatabaseSync')
  assert.ok(fs.statSync(executable).mode & 0o100, '内置 Node 必须保留可执行权限')
  assert.ok(fs.statSync(path.join(target, lock.node.license)).isFile(), 'Node LICENSE 缺失')
  console.log(`Node prepared: ${executable}`)
  console.log(`Verified ${actual.version}, Electron=${actual.electron}, DatabaseSync=${actual.sqlite}, sha256=${lock.node.sha256}`)
  return { executable, ...actual }
}

if (require.main === module) {
  try { prepareNode() } catch (error) { console.error(error instanceof Error ? error.message : error); process.exitCode = 1 }
}

module.exports = { verifiedDownload, prepareNode }
