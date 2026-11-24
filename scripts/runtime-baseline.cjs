const assert = require('node:assert/strict')
const { spawnSync } = require('node:child_process')
const { createHash } = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')

const root = path.resolve(__dirname, '..')
const baselinePath = path.join(root, 'config/runtime-baseline.json')
const generatedPath = path.join(root, 'build/runtime-baseline.json')

function sha256(content) {
  return createHash('sha256').update(content).digest('hex')
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}

function git(repository, args) {
  const result = spawnSync('git', ['-C', repository, ...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  if (result.error || result.status !== 0) throw new Error(`无法读取 DSH Git 基线: ${result.error?.message ?? result.stderr}`)
  return result.stdout
}

function sourceFiles(repository, excludedPaths = []) {
  const excluded = new Set(excludedPaths.map(file => path.resolve(file)))
  const output = git(repository, ['ls-files', '-z'])
  const untracked = git(repository, ['ls-files', '--others', '--exclude-standard', '-z'])
  const files = [...output.split('\0'), ...untracked.split('\0')].filter(Boolean)
    .filter(file => !excluded.has(path.resolve(repository, file)))
    .filter(file => file.endsWith('/tsdown.config.ts') || !file.includes('__pycache__') && !/(^|\/)\.generated-model-[^/]+\//.test(file))
  return [...new Set(files)].sort()
}

function validateLock(lock) {
  assert.equal(lock.schemaVersion, 1, '运行时锁定文件 schemaVersion 必须为 1')
  assert.deepEqual([lock.platform.os, lock.platform.arch, lock.platform.libc], ['linux', 'x64', 'glibc'], 'A1/A2 仅允许 Linux x64 glibc')
  assert.match(lock.node.version, /^\d+\.\d+\.\d+$/, 'Node 必须使用精确版本')
  assert.equal(lock.node.origin, 'https://nodejs.org/dist/', 'Node 只能使用官方发布地址')
  assert.equal(lock.node.archive, `node-v${lock.node.version}-linux-x64.tar.xz`, 'Node 包名必须与版本和平台一致')
  for (const key of ['sha256', 'checksumsSha256']) assert.match(lock.node[key], /^[a-f0-9]{64}$/, `Node ${key} 必须是 SHA-256`)
  assert.equal(new URL(lock.node.origin).protocol, 'https:', 'Node 下载必须使用 HTTPS')
  assert.equal(lock.dsh.sourceKind, 'local-git-worktree-snapshot', '当前 DSH 基线必须显式记录本地快照来源')
  assert.match(lock.dsh.packageManager, /^pnpm@\d+\.\d+\.\d+$/, 'pnpm 必须使用精确版本')
  assert.equal(lock.dsh.installCommand, 'node node_modules/pnpm/bin/pnpm.cjs install --frozen-lockfile --offline', '安装必须使用 DSH 本地锁定的 pnpm')
  assert.equal(lock.dsh.profile.name, 'sdk', '扩展发布入口必须使用 sdk profile')
  assert.equal(lock.dsh.profile.definition, 'packages/util/official-bundles/src/bundles.ts:PROFILE_TEMPLATES.sdk', 'profile 定义必须明确到官方模板')
  for (const mode of ['bundled', 'source']) {
    assert.equal(lock.dsh.entrypoints.filter(item => item.mode === mode).length, 1, `缺少 ${mode} 启动入口`)
  }
  const bundled = lock.dsh.entrypoints.find(item => item.mode === 'bundled')
  assert.equal(bundled.artifact, 'apps/cli/lib/bin.js', '发布入口必须是 CLI tsdown 的 bin 产物')
  for (const item of [...lock.dsh.packages, ...lock.dsh.entrypoints]) {
    for (const key of ['manifest', 'source', 'config', 'prebuilds']) {
      if (item[key] !== undefined) assert.ok(!path.isAbsolute(item[key]) && !item[key].split('/').includes('..'), `运行时输入必须是仓库内相对路径: ${item[key]}`)
    }
  }
  for (const file of [...lock.dsh.profile.patches, ...lock.dsh.profile.extensionPatches.map(item => item.path)]) {
    assert.ok(!path.isAbsolute(file) && !file.split('/').includes('..'), `profile 补丁必须使用仓库内相对路径: ${file}`)
  }
  return lock
}

function snapshot(repository, output, excludedPaths) {
  const files = sourceFiles(repository, excludedPaths)
  const records = files.map(relative => {
    const absolute = path.resolve(repository, relative)
    assert.ok(absolute.startsWith(repository + path.sep), `DSH 文件超出源码仓库: ${relative}`)
    const stat = fs.lstatSync(absolute)
    const symbolicLink = stat.isSymbolicLink() ? fs.readlinkSync(absolute) : undefined
    const resolved = fs.realpathSync(absolute)
    assert.ok(resolved === repository || resolved.startsWith(repository + path.sep), `DSH 文件或符号链接超出源码仓库: ${relative}`)
    assert.ok(stat.isFile() || symbolicLink !== undefined, `DSH 快照不接受非常规文件: ${relative}`)
    const content = symbolicLink === undefined ? fs.readFileSync(absolute) : Buffer.from(symbolicLink)
    return { path: relative, bytes: content.length, sha256: sha256(content), mode: stat.mode & 0o111 ? '755' : '644', ...symbolicLink === undefined ? {} : { symbolicLink } }
  })
  const tree = { algorithm: 'sha256', files: records }
  const treeSha256 = sha256(JSON.stringify(tree))
  fs.mkdirSync(path.dirname(output), { recursive: true })
  const temporary = `${output}.tmp`
  const archive = spawnSync('tar', [
    '--sort=name', '--format=gnu', '--mtime=@0', '--clamp-mtime', '--owner=0', '--group=0', '--numeric-owner',
    '-czf', temporary, '-C', repository, ...records.map(item => item.path),
  ], { stdio: ['ignore', 'ignore', 'pipe'], encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 })
  if (archive.error || archive.status !== 0) {
    fs.rmSync(temporary, { force: true })
    throw new Error(`DSH 源码快照创建失败: ${archive.error?.message ?? archive.stderr}`)
  }
  fs.renameSync(temporary, output)
  return { ...tree, treeSha256, archiveSha256: sha256(fs.readFileSync(output)), archiveBytes: fs.statSync(output).size }
}

function createBaseline(lock, repository, options = {}) {
  validateLock(lock)
  const absoluteRepository = fs.realpathSync(path.resolve(repository))
  const rootManifest = readJson(path.join(absoluteRepository, 'package.json'))
  assert.equal(rootManifest.version, lock.dsh.version, `DSH 版本与锁定文件不一致: ${rootManifest.version}`)
  assert.equal(rootManifest.packageManager, lock.dsh.packageManager, `DSH 包管理器与锁定文件不一致: ${rootManifest.packageManager}`)
  assert.ok(lock.dsh.installCommand.endsWith('install --frozen-lockfile --offline'), '恢复快照必须离线且冻结 DSH lockfile 安装依赖')
  assert.ok(rootManifest.scripts['build:artifacts'] && rootManifest.scripts['build:check'], 'DSH 根 package.json 缺少登记的构建脚本')
  for (const [key, script] of [['artifactCommand', 'build:artifacts'], ['checkCommand', 'build:check']]) {
    const executable = 'node node_modules/tsx/dist/cli.mjs '
    assert.ok(rootManifest.scripts[script].startsWith('tsx '), `DSH ${script} 必须使用本地 tsx 启动`)
    assert.equal(lock.dsh[key], `${executable}${rootManifest.scripts[script].slice('tsx '.length)}`, `${key} 未与 DSH 根脚本同步: ${rootManifest.scripts[script]}`)
  }
  const localPnpm = readJson(path.join(absoluteRepository, 'node_modules/pnpm/package.json'))
  assert.equal(localPnpm.version, rootManifest.packageManager.slice('pnpm@'.length), '本地 pnpm 必须匹配 DSH packageManager；禁止静默使用全局其他版本')
  const buildNode = process.version.slice(1).split('.').map(Number)
  assert.ok(buildNode[0] > 24 || buildNode[0] === 24 && buildNode[1] >= 9, `DSH 构建需要普通 Node >=24.9，当前为 ${process.version}`)
  const tools = lock.dsh.toolchain.map(item => {
    const [relative, key] = item.split(':')
    const value = readJson(path.join(absoluteRepository, relative))[key]
    assert.equal(typeof value, 'string', `工具链字段必须是字符串: ${item}`)
    return { input: item, value }
  })
  for (const item of lock.dsh.packages) {
    const manifest = readJson(path.join(absoluteRepository, item.manifest))
    assert.equal(manifest.name, item.name, `DSH 包名与清单不符: ${item.manifest}`)
    assert.equal(manifest.version, item.version ?? lock.dsh.version, `DSH 包版本未固定: ${item.name}`)
    if (item.platformPackage) {
      assert.deepEqual(manifest.os, [lock.platform.os], `原生组件 OS 不匹配: ${item.name}`)
      assert.deepEqual(manifest.cpu, [lock.platform.arch], `原生组件 CPU 不匹配: ${item.name}`)
      readJson(path.join(absoluteRepository, item.prebuilds))
    }
  }
  const snapshotPath = path.resolve(options.snapshotPath ?? path.join(root, lock.dsh.snapshot.path))
  const generatedOutput = path.resolve(options.generatedPath ?? generatedPath)
  const exclusions = [snapshotPath, generatedOutput]
  const tracked = new Set(sourceFiles(absoluteRepository, exclusions))
  for (const file of [
    'package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'LICENSE', lock.dsh.profile.definition.split(':')[0],
    ...lock.dsh.profile.patches, ...lock.dsh.profile.extensionPatches.map(item => item.path),
    ...lock.dsh.packages.flatMap(item => [item.manifest, ...item.prebuilds === undefined ? [] : [item.prebuilds]]),
    ...lock.dsh.entrypoints.flatMap(item => [item.source, item.config]),
  ]) assert.ok(tracked.has(file), `运行时输入未被 Git 跟踪或显式纳入快照: ${file}`)
  const sourceSnapshot = snapshot(absoluteRepository, snapshotPath, exclusions)
  const output = {
    schemaVersion: lock.schemaVersion,
    platform: lock.platform,
    node: lock.node,
    dsh: {
      ...lock.dsh,
      toolchainPaths: lock.dsh.toolchain,
      repository: absoluteRepository,
      revision: git(absoluteRepository, ['rev-parse', 'HEAD']).trim(),
      branch: git(absoluteRepository, ['branch', '--show-current']).trim(),
      committedAt: git(absoluteRepository, ['show', '-s', '--format=%cI', 'HEAD']).trim(),
      dirty: git(absoluteRepository, ['status', '--porcelain=v1', '--untracked-files=all']).length > 0,
      toolchain: tools,
      profile: {
        ...lock.dsh.profile,
        patches: lock.dsh.profile.patches.map(relative => ({ path: relative, sha256: sha256(fs.readFileSync(path.join(absoluteRepository, relative))) })),
      },
      snapshot: {
        ...lock.dsh.snapshot,
        sourceKind: 'git-tracked-and-declared-untracked-build-config',
        fileCount: sourceSnapshot.files.length,
        treeSha256: sourceSnapshot.treeSha256,
        archiveSha256: sourceSnapshot.archiveSha256,
        archiveBytes: sourceSnapshot.archiveBytes,
        files: sourceSnapshot.files,
      },
    },
  }
  return output
}

function main(args = process.argv.slice(2), options = {}) {
  const allowed = new Set(['--check', '--dsh-repository'])
  assert.ok(args.every(arg => allowed.has(arg) || arg.startsWith('--dsh-repository=')), `未知参数；支持 --check、--dsh-repository=<path>: ${args.join(' ')}`)
  const check = args.includes('--check')
  const repository = options.repository ?? args.find(arg => arg.startsWith('--dsh-repository='))?.slice('--dsh-repository='.length)
    ?? path.resolve(root, './dsh-learning/deepseek-harness')
  const lock = readJson(options.baselinePath ?? baselinePath)
  const output = createBaseline(lock, repository, options)
  const serialized = `${JSON.stringify(output, null, 2)}\n`
  const outputPath = options.generatedPath ?? generatedPath
  if (check) {
    assert.ok(fs.existsSync(outputPath), '运行时基线未生成，请先执行 npm run runtime:baseline')
    const existing = fs.readFileSync(outputPath, 'utf8')
    if (existing !== serialized) {
      const actualDigest = sha256(serialized)
      const existingDigest = sha256(existing)
      throw new Error(`DSH 源码或工具链已变化；清单摘要 ${existingDigest} → ${actualDigest}；请审查后重新执行 npm run runtime:baseline`)
    }
    console.log(`Runtime baseline verified: DSH ${output.dsh.revision}, ${output.dsh.snapshot.fileCount} files, dirty=${output.dsh.dirty}`)
  } else {
    fs.mkdirSync(path.dirname(outputPath), { recursive: true })
    fs.writeFileSync(outputPath, serialized)
    fs.writeFileSync(path.resolve(root, lock.dsh.snapshot.sha256File), `${output.dsh.snapshot.archiveSha256}  ${path.basename(lock.dsh.snapshot.path)}\n`)
    console.log(`Runtime baseline generated: Node ${lock.node.version}, DSH ${output.dsh.revision}, dirty=${output.dsh.dirty}`)
    console.log(`DSH snapshot: ${output.dsh.snapshot.fileCount} files, tree ${output.dsh.snapshot.treeSha256}`)
    console.log(`DSH build: ${lock.dsh.artifactCommand} && ${lock.dsh.checkCommand}`)
  }
  return output
}

if (require.main === module) {
  try { main() } catch (error) { console.error(error instanceof Error ? error.message : error); process.exitCode = 1 }
}

module.exports = { baselinePath, generatedPath, sha256, validateLock, sourceFiles, createBaseline, main }
