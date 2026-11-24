const assert = require('node:assert/strict')
const { spawnSync } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { baselinePath, sha256, validateLock, sourceFiles, createBaseline, main } = require('./runtime-baseline.cjs')

const root = path.resolve(__dirname, '..')
const repository = path.resolve(root, './dsh-learning/deepseek-harness')
const lock = JSON.parse(fs.readFileSync(baselinePath, 'utf8'))
assert.equal(validateLock(lock).node.version, '24.9.0')
assert.equal(lock.dsh.profile.patches.length, 2)
assert.equal(lock.dsh.entrypoints.find(item => item.mode === 'bundled').source, 'apps/cli/src/installed-bin.ts')
assert.throws(() => validateLock({ ...lock, node: { ...lock.node, version: '^24.9.0' } }), /精确版本/)
assert.throws(() => validateLock({ ...lock, node: { ...lock.node, origin: 'http://example.com/' } }), /官方发布地址/)
assert.throws(() => validateLock({ ...lock, platform: { ...lock.platform, arch: 'arm64' } }), /Linux x64/)
assert.throws(() => validateLock({ ...lock, dsh: { ...lock.dsh, profile: { ...lock.dsh.profile, patches: ['/tmp/patch.yml'] } } }), /仓库内相对路径/)
assert.throws(() => main(['--unsupported']), /未知参数/)

const files = sourceFiles(repository)
assert.ok(files.includes('packages/sdk/client/tsdown.config.ts'), '未跟踪的构建配置也必须进入基线')
assert.ok(!files.some(file => file.includes('__pycache__') || /(^|\/)\.generated-model-[^/]+\//.test(file)), '测试生成物不得进入源码基线')
assert.ok(files.includes('pnpm-lock.yaml'))

function makeRepository(files) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-baseline-repo-'))
  for (const file of files) {
    const target = path.join(directory, file)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.copyFileSync(path.join(repository, file), target)
  }
  const initialize = spawnSync('git', ['-C', directory, 'init', '--quiet'], { encoding: 'utf8' })
  assert.equal(initialize.status, 0, initialize.stderr)
  const commit = spawnSync('git', ['-C', directory, '-c', 'user.name=Runtime Test', '-c', 'user.email=runtime@localhost', 'commit', '--allow-empty', '--quiet', '-m', 'Baseline fixture'], { encoding: 'utf8' })
  assert.equal(commit.status, 0, commit.stderr)
  return directory
}

function toolOverrides(source, destination) {
  const copies = []
  for (const item of lock.dsh.toolchain) {
    const relative = item.split(':')[0]
    const target = path.join(destination, relative)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.copyFileSync(path.join(source, relative), target)
    copies.push(relative)
  }
  return copies
}

const temporary = makeRepository([
  'package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'LICENSE',
  ...lock.dsh.packages.flatMap(item => [item.manifest, ...item.prebuilds === undefined ? [] : [item.prebuilds]]),
  ...lock.dsh.entrypoints.map(item => item.source),
])
try {
  toolOverrides(repository, temporary)
  const addConfig = path.join(temporary, 'apps/cli/tsdown.config.ts')
  fs.writeFileSync(addConfig, 'export default {}\n')
  assert.throws(() => createBaseline(lock, temporary, { snapshotPath: path.join(temporary, 'snapshot.tar.gz') }), /未被 Git 跟踪或显式纳入/)
  const tracked = makeRepository([
    'package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'LICENSE', 'packages/util/official-bundles/src/bundles.ts',
    ...lock.dsh.profile.patches, ...lock.dsh.profile.extensionPatches.map(item => item.path),
    ...lock.dsh.packages.flatMap(item => [item.manifest, ...item.prebuilds === undefined ? [] : [item.prebuilds]]),
    ...lock.dsh.entrypoints.flatMap(item => [item.source, item.config]),
  ])
  try {
    toolOverrides(repository, tracked)
    const outputPath = path.join(tracked, 'runtime-baseline.json')
    const sourceArchive = path.join(tracked, 'source.tar.gz')
    const expectedFileCount = sourceFiles(tracked).length
    const first = main([], { repository: tracked, generatedPath: outputPath, snapshotPath: sourceArchive })
    const original = fs.readFileSync(outputPath, 'utf8')
    assert.equal(first.dsh.snapshot.fileCount, expectedFileCount)
    assert.doesNotThrow(() => main(['--check'], { repository: tracked, generatedPath: outputPath, snapshotPath: path.join(tracked, 'source.tar.gz') }))
    assert.equal(fs.readFileSync(outputPath, 'utf8'), original, '同一输入的基线清单必须稳定')
    fs.appendFileSync(path.join(tracked, 'apps/cli/src/sdk-source.cordis.patch.yml'), '# changed input\n')
    assert.throws(() => main(['--check'], { repository: tracked, generatedPath: outputPath, snapshotPath: path.join(tracked, 'source.tar.gz') }), /已变化/)
    assert.equal(fs.readFileSync(outputPath, 'utf8'), original, '检查失败不得改写已审查清单')
    fs.symlinkSync('/etc/passwd', path.join(tracked, 'outside-link'))
    assert.throws(() => createBaseline(lock, tracked, { snapshotPath: path.join(tracked, 'bad-source.tar.gz') }), /超出源码仓库/)
    console.log('Runtime baseline: exact versions, relative paths, untracked configs, repeatability, change rejection and external-link rejection passed')
  } finally {
    fs.rmSync(tracked, { recursive: true, force: true })
  }
} finally {
  fs.rmSync(temporary, { recursive: true, force: true })
}

function trackedFileCount(directory) {
  const output = spawnSync('git', ['-C', directory, 'ls-files', '-co', '--exclude-standard', '-z'], { encoding: 'utf8' })
  assert.equal(output.status, 0, output.stderr)
  return sourceFiles(directory).length
}

const realOutput = path.join(root, 'build/runtime-baseline.json')
const archive = path.join(root, lock.dsh.snapshot.path)
assert.ok(fs.existsSync(realOutput) && fs.existsSync(archive), '真实 DSH 基线和源码快照必须已生成')
const generated = JSON.parse(fs.readFileSync(realOutput, 'utf8'))
assert.equal(generated.dsh.snapshot.archiveSha256, sha256(fs.readFileSync(archive)))
assert.equal(generated.dsh.snapshot.treeSha256, sha256(JSON.stringify({ algorithm: 'sha256', files: generated.dsh.snapshot.files })))
assert.equal(generated.dsh.dirty, true, '当前联合开发基线必须明确标记未提交修改')
assert.throws(() => main(['--check'], { repository, generatedPath: path.join(os.tmpdir(), 'missing-runtime-baseline.json'), snapshotPath: path.join(root, '.runtime-build/test-unused-source.tar.gz') }), /运行时基线未生成/)
console.log(`Actual DSH baseline: ${generated.dsh.revision}, ${generated.dsh.snapshot.fileCount} files, archive ${generated.dsh.snapshot.archiveSha256}`)
