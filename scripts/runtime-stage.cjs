const assert = require('node:assert/strict')
const { spawnSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')
const { createClosure, readJson, root, assertPublishFile } = require('./runtime-closure.cjs')

const config = readJson(path.join(root, 'config/runtime-baseline.json'))
function assertStagedRuntime(destination, node) {
  const version = run(node, ['node_modules/@deepseek-ai/dsh/lib/bin.js', '--version'], destination).trim()
  assert.match(version, /\d+\.\d+\.\d+/, 'CLI 必须由普通 Node 执行编译入口')
  const sdk = run(node, ['--input-type=module', '-e', 'const sdk = await import("@deepseek-ai/dsh-sdk-client"); if (typeof sdk.DeepSeekHarness !== "function" || typeof sdk.HarnessClient !== "function") throw new Error("SDK createHarness missing"); console.log("sdk-client-ok")'], destination).trim()
  assert.equal(sdk, 'sdk-client-ok', '发布暂存区必须能导入 SDK 客户端')
  return { version, sdk }
}

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', env: { ...process.env, CI: 'true', NPM_CONFIG_IGNORE_SCRIPTS: 'true' }, maxBuffer: 32 * 1024 * 1024 })
  if (result.error || result.status !== 0) throw new Error(`${command} ${args.join(' ')} 失败 [cwd=${cwd}]: ${result.error?.message ?? result.stdout + result.stderr}`)
  return result.stdout
}

function stage(options = {}) {
  const repository = options.repository ?? path.resolve(root, './dsh-learning/deepseek-harness')
  const destination = options.destination ?? path.join(root, '.runtime-build/dsh')
  const closure = createClosure(readJson(path.join(root, 'config/runtime-baseline.json')), fs.realpathSync(repository), { requireBuilt: false })
  const packageOwners = new Map()
  const packageInstances = new Map()
  for (const item of closure.packages) {
    const key = `${item.name}@${item.version}`
    assert.ok(!packageInstances.has(key), `同一包版本被重复登记: ${key}`)
    packageInstances.set(key, item)
    for (const stagingPath of item.stagingPaths) {
      const owner = packageOwners.get(stagingPath)
      assert.ok(!owner, `多个包版本争用暂存路径: ${stagingPath}: ${owner?.name}@${owner?.version} -> ${item.name}@${item.version}`)
      packageOwners.set(stagingPath, item)
    }
  }
  const orderedPackages = closure.packages.flatMap(item => item.stagingPaths.map(stagingPath => ({ ...item, stagingPaths: [stagingPath] })))
    .sort((a, b) => b.stagingPaths[0].split('/').length - a.stagingPaths[0].split('/').length || a.stagingPaths[0].localeCompare(b.stagingPaths[0]))
  assert.deepEqual(closure.native.failures, [], '构建原生组件后才能暂存')
  const parent = path.dirname(destination)
  assert.notEqual(parent, destination)
  assert.ok(fs.existsSync(parent), '暂存区的受控父目录必须已存在')
  const pending = `${destination}.staging`
  fs.rmSync(pending, { recursive: true, force: true })
  fs.mkdirSync(pending, { recursive: true })
  const node = options.node ?? path.join(root, '.runtime-build/node/bin/node')
  assert.equal(run(node, ['--version'], pending).trim(), `v${config.node.version}`)
  for (const [index, item] of orderedPackages.entries()) {
    if (index % 50 === 0) console.log(`Packing ${index + 1}/${closure.packages.length}: ${item.name}`)
    const directory = item.kind === 'external' ? fs.realpathSync(item.externalDirectory) : path.join(repository, item.source)
    assert.ok(directory.startsWith(fs.realpathSync(repository) + path.sep), `发布输入不能离开 DSH 开发仓库: ${item.name}`)
    const pack = JSON.parse(item.kind === 'external'
      ? run('npm', ['pack', directory, '--ignore-scripts', '--json', '--pack-destination', pending], pending)
      : run(process.execPath, [path.join(repository, 'node_modules/pnpm/bin/pnpm.cjs'), '--dir', directory, 'pack', '--config.ignore-scripts=true', '--json', '--pack-destination', pending], pending))
    const packed = Array.isArray(pack) ? pack : [pack]
    assert.equal(packed.length, 1, '每个依赖必须只生成一个 tarball')
    const [publication] = packed
    assert.equal(publication.name, item.name, '打包名称必须与闭包一致')
    assert.equal(publication.version, item.version, '打包版本必须与闭包一致')
    const archive = path.join(pending, path.basename(publication.filename))
    for (const stagingPath of item.stagingPaths) {
      const target = path.join(pending, stagingPath)
      fs.mkdirSync(target, { recursive: true })
      assert.ok(!fs.existsSync(path.join(target, 'package.json')), `暂存目标不得覆盖已有包: ${item.name}@${item.version} -> ${stagingPath}`)
      const entries = run('tar', ['-tvzf', archive], pending).split('\n').filter(Boolean)
      const extraction = spawnSync('tar', ['-xzf', archive, '--strip-components=1', '-C', target], { cwd: pending, encoding: 'utf8' })
      assert.ok(!extraction.error, `tar 解压无法启动: ${item.name}`)
      if (extraction.status !== 0) assert.ok(extraction.stderr.split('\n').filter(line => line.includes('：')).every(line => line.includes('无法硬连接到')), `tar 存在非硬链接错误: ${item.name}: ${extraction.stderr}`)
      assert.ok(fs.existsSync(path.join(target, 'package.json')), `解包后缺少 manifest: ${item.name}@${item.version} -> ${stagingPath}`)
      for (const entry of entries) {
        const match = entry.match(/^[^\s]+\s+\S+\s+\S+\s+\d+\s+\S+\s+\S+\s+(\S+) link to (\S+)$/)
        if (match) {
          const link = path.join(target, match[1].replace(/^package\//, ''))
          const source = path.join(target, match[2].replace(/^package\//, ''))
          assert.ok(link.startsWith(target + path.sep) && source.startsWith(target + path.sep), 'tarball 硬链接不能逃逸')
          assert.ok(fs.statSync(source).isFile(), `tarball 硬链接目标缺失: ${item.name}`)
          fs.mkdirSync(path.dirname(link), { recursive: true })
          fs.copyFileSync(source, link)
        }
      }
    }
    fs.rmSync(archive)
    for (const stagingPath of item.stagingPaths) {
      const target = path.join(pending, stagingPath)
      const manifest = readJson(path.join(target, 'package.json'))
      assert.equal(manifest.name, item.name)
      assert.equal(manifest.version, item.version)
      const removeExcluded = currentDirectory => {
        for (const entry of fs.readdirSync(currentDirectory, { withFileTypes: true })) {
          const absolute = path.join(currentDirectory, entry.name)
          const relative = path.relative(target, absolute).split(path.sep).join('/')
          if (entry.isDirectory() && relative === 'node_modules') continue
          try { assertPublishFile(item.name, relative) } catch {
            fs.rmSync(absolute, { recursive: true, force: true })
            continue
          }
          if (entry.isDirectory()) removeExcluded(absolute)
          else assert.ok(entry.isFile() && !entry.isSymbolicLink(), `发布包只能包含普通文件: ${item.name}/${relative}`)
        }
      }
      removeExcluded(target)
      assert.equal(manifest.name, item.name)
      assert.equal(manifest.version, item.version)
      for (const section of ['dependencies', 'optionalDependencies', 'peerDependencies']) {
        for (const range of Object.values(manifest[section] ?? {})) assert.ok(!String(range).startsWith('workspace:'), `发布包不能保留 workspace 引用: ${item.name}`)
      }
    }
  }
  verifyStagedPackages(pending, closure)
  const runtime = assertStagedRuntime(pending, node)
  fs.rmSync(destination, { recursive: true, force: true })
  fs.renameSync(pending, destination)
  fs.writeFileSync(path.join(destination, 'runtime-staging.json'), `${JSON.stringify({ ...readJson(path.join(destination, 'runtime-staging.json')), probes: runtime }, null, 2)}\n`)
  return { destination, repository, closure, probes: runtime }
}

function verifyStagedPackages(pending, closure) {
  fs.writeFileSync(path.join(pending, 'package.json'), `${JSON.stringify({ name: 'dsh-staged-runtime', private: true, version: config.dsh.version, type: 'module' }, null, 2)}\n`)
  fs.writeFileSync(path.join(pending, 'runtime-staging.json'), `${JSON.stringify({ schemaVersion: 1, layout: 'packed-pnpm-production', roots: closure.roots, entry: 'node_modules/@deepseek-ai/dsh/lib/bin.js', packages: closure.packages.map(item => ({ name: item.name, version: item.version, stagingPaths: item.stagingPaths })) }, null, 2)}\n`)
  for (const item of closure.packages) {
    for (const dependency of item.dependencies) {
      if (dependency.optional) continue
      if (dependency.name === '@deepseek-ai/dsh' && item.name !== '@deepseek-ai/dsh-sdk-client') continue
      if (!closure.packages.some(candidate => candidate.name === dependency.name)) continue
      const expected = closure.packages.filter(candidate => candidate.name === dependency.name)
        .flatMap(candidate => (candidate.stagingPaths ?? [candidate.stagingPath]).map(stagingPath => ({ stagingPath, version: candidate.version })))
      const resolutions = item.stagingPaths.map(stagingPath => {
        let current = path.join(pending, stagingPath)
        let manifest
        while (current.startsWith(pending)) {
          const candidate = path.join(current, 'node_modules', ...dependency.name.split('/'), 'package.json')
          if (fs.existsSync(candidate)) {
            const parsed = readJson(candidate)
            assert.equal(parsed.name, dependency.name)
            manifest = candidate
            break
          }
          if (current === pending) break
          current = path.dirname(current)
        }
        assert.ok(manifest, `依赖目录无法解析: ${item.name} -> ${dependency.name}`)
        const relative = path.relative(pending, manifest).split(path.sep).join('/')
        const owner = expected.find(candidate => relative === `${candidate.stagingPath}/package.json`)
        assert.ok(owner, `依赖解析到错误版本: ${item.name}@${item.version} -> ${dependency.name}; ${relative}; expected=${JSON.stringify(expected)}`)
        return { dependency: dependency.name, from: stagingPath, resolved: path.dirname(relative), version: owner.version }
      })
      assert.ok(resolutions.length > 0)
    }
  }
  console.log(`Staged dependency resolutions: ${closure.packages.length} packages passed`)
}

if (require.main === module) {
  try {
    const result = process.argv.includes('--verify-only')
      ? (verifyStagedPackages(path.join(root, '.runtime-build/dsh.staging'), createClosure(config, path.resolve(root, './dsh-learning/deepseek-harness'))), undefined)
      : stage()
    if (!result) process.exit(0)
    console.log(`DSH staged: ${result.destination}`)
    console.log(`Packages: ${result.closure.packages.length}; native failures: ${result.closure.native.failures.length}`)
  } catch (error) { console.error(error instanceof Error ? error.stack : error); process.exitCode = 1 }
}

module.exports = { stage }
