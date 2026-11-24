const assert = require('node:assert/strict')
const { spawnSync } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { createHash } = require('node:crypto')
const { root, readJson, sha256 } = require('./runtime-closure.cjs')
const { supplementLicenses } = require('./runtime-licenses.cjs')

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, ...options })
  if (result.error || result.status !== 0) throw new Error(`${command} ${args.join(' ')} 失败：${result.error?.message ?? result.stdout + result.stderr}`)
  return result.stdout
}

function walk(directory, prefix = '') {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const absolute = path.join(directory, entry.name)
    const relative = path.posix.join(prefix, entry.name)
    const stat = fs.lstatSync(absolute)
    assert.ok(!stat.isSymbolicLink(), `VSIX 不能包含符号链接：${relative}`)
    if (stat.isDirectory()) return walk(absolute, relative)
    assert.ok(stat.isFile(), `VSIX 只能包含普通文件：${relative}`)
    return [{ path: relative, bytes: stat.size, mode: (stat.mode & 0o777).toString(8), sha256: sha256(fs.readFileSync(absolute)) }]
  })
}

function copy(source, destination) {
  fs.cpSync(source, destination, { recursive: true, dereference: true, filter: item => {
    if (fs.lstatSync(item).isSymbolicLink()) throw new Error(`生产输入不能包含符号链接：${item}`)
    return true
  } })
}

function assertLicenses(directory, manifestPaths) {
  const notices = []
  for (const relative of manifestPaths) {
    const manifest = readJson(path.join(directory, relative))
    assert.ok(typeof manifest.license === 'string' && manifest.license.length > 0, `包未声明许可证：${manifest.name}`)
    const packageDirectory = path.dirname(path.join(directory, relative))
    const licenses = fs.readdirSync(packageDirectory).filter(name => /^(?:LICENSE|LICENCE|COPYING)(?:[-.]|$)/i.test(name) || /^license-(?:mit|cc0)$/i.test(name))
    assert.ok(licenses.length > 0, `包缺少许可证文本：${manifest.name}@${manifest.version}`)
    notices.push({ name: manifest.name, version: manifest.version, license: manifest.license, files: licenses.map(license => path.posix.join(path.dirname(relative), license)) })
  }
  return notices.sort((a, b) => `${a.name}@${a.version}`.localeCompare(`${b.name}@${b.version}`))
}

function clientClosure(staging, closure) {
  const manifests = new Map()
  for (const item of closure.packages) {
    if (item.stagingPaths.length !== 1 || !item.stagingPaths[0].startsWith('node_modules/')) continue
    manifests.set(item.name, readJson(path.join(staging, item.stagingPaths[0], 'package.json')))
  }
  const files = new Map()
  const required = new Set()
  function source(file) {
    if (files.has(file)) return files.get(file)
    const text = fs.readFileSync(file, 'utf8')
    files.set(file, text)
    return text
  }
  function resolvePackage(name, from, parent) {
    const manifest = manifests.get(name)
    assert.ok(manifest, `SDK 客户端缺少闭包包：${name}`)
    required.add(name)
    const exported = manifest.exports?.['.']
    const relative = (typeof exported === 'string' ? exported : exported?.node?.default ?? exported?.default ?? exported?.import ?? exported?.require) ?? manifest.main ?? 'index.js'
    assert.equal(typeof relative, 'string', `SDK 客户端包的 Node 导出无法解析：${name}`)
    resolveImport(path.join(staging, 'node_modules', name, relative), parent)
  }
  function resolveImport(specifier, parent) {
    if (specifier.startsWith('node:') || !specifier.startsWith('.') && !specifier.startsWith('/')) {
      const name = specifier.startsWith('@') ? specifier.split('/').slice(0, 2).join('/') : specifier.split('/')[0]
      if (!specifier.startsWith('node:')) resolvePackage(name, specifier, parent)
      return
    }
    const file = path.resolve(path.dirname(parent), specifier)
    const text = source(file)
    for (const match of text.matchAll(/(?:^|[;\s])(?:import|export)\s+(?:[\s\S]*?\s+from\s+)?["']([^"']+)["']/g)) resolveImport(match[1], file)
    for (const match of text.matchAll(/import\(["']([^"']+)["']\)/g)) resolveImport(match[1], file)
  }
  resolvePackage('@deepseek-ai/dsh-sdk-client', '.', path.join(staging, 'node_modules/@deepseek-ai/dsh-sdk-client/lib/index.js'))
  required.delete('@deepseek-ai/dsh')
  return [...required].sort()
}

function packageVsix() {
  assert.equal(process.platform, 'linux')
  assert.equal(process.arch, 'x64')
  const config = readJson(path.join(root, 'config/runtime-baseline.json'))
  const closure = readJson(path.join(root, 'build/dsh-production-closure.json'))
  assert.equal(closure.status, 'artifact-inventory-complete')
  const staging = path.join(root, '.runtime-build/dsh')
  const node = path.join(root, '.runtime-build/node')
  assert.ok(fs.existsSync(path.join(staging, 'runtime-staging.json')), '先执行 npm run runtime:stage && npm run runtime:closure')
  assert.ok(fs.existsSync(path.join(node, 'runtime-node.json')), '先执行 npm run runtime:node')
  run(process.execPath, ['--run', 'compile'], { cwd: root })
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'coding-agent-vsix-'))
  const destination = path.join(temporary, 'extension')
  fs.mkdirSync(destination)
  try {
    for (const directory of ['out', 'media']) copy(path.join(root, directory), path.join(destination, directory))
    // vsce renames the root LICENSE to LICENSE.txt and prepends its banner.
    copy(path.join(root, 'LICENSE'), path.join(destination, 'LICENSE.txt'))
    copy(staging, path.join(destination, '.runtime-build/dsh'))
    copy(node, path.join(destination, '.runtime-build/node'))
    for (const file of walk(destination)) {
      if (file.path.endsWith('.map') || /node_modules\/(?:@[^/]+\/)?[^/]+\/(?:src|\.github|test|tests|__tests__)\//.test(file.path)) {
        fs.rmSync(path.join(destination, file.path))
      }
    }
    const manifest = readJson(path.join(root, 'package.json'))
    manifest.private = false
    manifest.dependencies = {
      '@deepseek-ai/dsh-sdk-client': config.dsh.version,
      ...Object.fromEntries(['argparse', 'diff', 'js-yaml'].map(name => [name, readJson(path.join(root, 'node_modules', name, 'package.json')).version])),
    }
    manifest.devDependencies = {}
    manifest.scripts = {}
    fs.writeFileSync(path.join(destination, 'package.json'), JSON.stringify(manifest, null, 2) + '\n')
    fs.writeFileSync(path.join(destination, '.vscodeignore'), [
      '.vscode/**', 'src/**', 'scripts/**', 'tsconfig.json', '**/*.map',
      '!node_modules/@deepseek-ai/dsh-sdk-client/**',
      '!node_modules/diff/**', '!node_modules/js-yaml/**', '!node_modules/argparse/**', '',
    ].join('\n'))
    const npmEnvironment = { ...process.env, CI: 'true', NPM_CONFIG_REGISTRY: 'https://registry.npmjs.org', npm_config_registry: 'https://registry.npmjs.org' }
    const inputs = path.join(temporary, 'production-inputs')
    fs.mkdirSync(inputs)
    const clientPackages = clientClosure(staging, closure)
    assert.ok(!clientPackages.includes('@deepseek-ai/dsh'), 'Extension Host 不得安装第二份 DSH CLI')
    for (const name of clientPackages) {
      const input = path.join(inputs, name)
      copy(path.join(staging, 'node_modules', name), input)
      const packageManifest = readJson(path.join(input, 'package.json'))
      packageManifest.devDependencies = {}
      for (const section of ['dependencies', 'peerDependencies', 'optionalDependencies']) {
        for (const [dependency, value] of Object.entries(packageManifest[section] ?? {})) {
          if (String(value).startsWith('workspace:')) {
            const locked = closure.packages.find(item => item.name === dependency)
            assert.ok(locked, `SDK 的 workspace 依赖不在严格闭包中：${dependency}`)
            packageManifest[section][dependency] = locked.version
          }
          if (dependency === '@deepseek-ai/dsh' || packageManifest[section]?.[dependency]?.startsWith('0.2.2-rc.1') && !clientPackages.includes(dependency)) delete packageManifest[section][dependency]
        }
      }
      fs.writeFileSync(path.join(input, 'package.json'), JSON.stringify(packageManifest, null, 2) + '\n')
      const archive = run('npm', ['pack', input, '--ignore-scripts', '--pack-destination', temporary, '--json'], { cwd: temporary, env: npmEnvironment })
      const filename = JSON.parse(archive)[0].filename
      manifest.dependencies[name] = `file:../${filename}`
    }
    fs.writeFileSync(path.join(destination, 'package.json'), JSON.stringify(manifest, null, 2) + '\n')
    fs.writeFileSync(path.join(destination, 'package.json'), JSON.stringify(manifest, null, 2) + '\n')
    run('npm', ['install', '--package-lock-only', '--ignore-scripts', '--omit=dev'], { cwd: destination, env: npmEnvironment })
    run('npm', ['ci', '--ignore-scripts', '--omit=dev'], { cwd: destination, env: npmEnvironment })
    for (const name of clientPackages) {
      const version = readJson(path.join(destination, 'node_modules', name, 'package.json')).version
      manifest.dependencies[name] = version
    }
    fs.writeFileSync(path.join(destination, 'package.json'), JSON.stringify(manifest, null, 2) + '\n')
    fs.rmSync(path.join(destination, 'node_modules/.bin'), { recursive: true, force: true })
    // npm uses these only while assembling the isolated production tree.
    // The published package has exact versions and no local tarball references.
    fs.rmSync(path.join(destination, 'package-lock.json'), { force: true })
    fs.rmSync(path.join(destination, 'node_modules/.package-lock.json'), { force: true })
    for (const file of walk(destination)) {
      const stat = fs.lstatSync(path.join(destination, file.path))
      fs.chmodSync(path.join(destination, file.path), stat.mode & 0o111 ? 0o755 : 0o644)
    }
    const dependencyPackages = ['diff', 'js-yaml', 'argparse']
    for (const name of dependencyPackages) {
      copy(path.dirname(require.resolve(`${name}/package.json`, { paths: [root] })), path.join(destination, 'node_modules', name))
    }
    for (const name of ['diff', 'js-yaml', 'argparse']) {
      const manifestPath = path.join(destination, 'node_modules', name, 'package.json')
      const packageManifest = readJson(manifestPath)
      packageManifest.devDependencies = {}
      fs.writeFileSync(manifestPath, JSON.stringify(packageManifest, null, 2) + '\n')
    }
    for (const file of walk(destination)) {
      if (file.path.endsWith('.map') || /node_modules\/(?:@[^/]+\/)?[^/]+\/(?:src|\.github|test|tests|__tests__)\//.test(file.path)) {
        fs.rmSync(path.join(destination, file.path))
      }
    }
    const runtimePackagePaths = closure.packages.flatMap(item => (item.stagingPaths ?? [item.stagingPath]).map(directory => `${directory}/package.json`))
    const licenseSupplements = supplementLicenses(path.join(destination, '.runtime-build/dsh'))
    const notices = [
      ...assertLicenses(destination, [...clientPackages, ...dependencyPackages].map(name => `node_modules/${name}/package.json`)),
      ...assertLicenses(path.join(destination, '.runtime-build/dsh'), runtimePackagePaths),
    ]
    const files = walk(destination).filter(file => file.path !== '.vscodeignore')
    for (const native of closure.native.payloads) {
      const relative = `.runtime-build/dsh/node_modules/${closure.native.package}/${native.path}`
      const file = files.find(item => item.path === relative)
      assert.ok(file, `VSIX 缺少原生载荷：${relative}`)
      assert.equal(file.sha256, native.sha256, `VSIX 原生载荷哈希不一致：${relative}`)
      if (native.requiredExecutable) assert.equal(file.mode, '755', `VSIX 原生工具缺少执行权限：${relative}`)
    }
    for (const file of files) {
      assert.ok(!/(?:^|\/)(?:test|tests|__tests__|\.git|\.github|\.vscode-agent-dev)(?:\/|$)/.test(file.path), `VSIX 包含开发内容：${file.path}`)
      assert.ok(!file.path.startsWith('src/') && !/(?:^|\/)node_modules\/@deepseek-ai\/[^/]+\/src\//.test(file.path), `VSIX 包含 DSH 或扩展源码：${file.path}`)
      assert.ok(!/^scripts\//.test(file.path), `VSIX 包含扩展开发脚本：${file.path}`)
      assert.ok(!/(?:\.map|\.vsix|\.env|\.log)$/.test(file.path), `VSIX 包含调试或私有内容：${file.path}`)
      assert.ok(!/(?:^|\/)(?:\.credentials\.yaml|\.env)$/.test(file.path), `VSIX 包含凭据：${file.path}`)
      assert.ok(!/(?:^|\/)(?:profiles|sessions|storages|checkpoints)\//.test(file.path) || /^(?:\.runtime-build\/dsh\/)?node_modules\//.test(file.path), `VSIX 包含用户数据：${file.path}`)
      assert.ok(!file.path.includes('/dsh-source-snapshot'), 'VSIX 不得包含源码快照')
      assert.ok(!fs.readFileSync(path.join(destination, file.path), 'utf8').includes(root), `VSIX 包含开发机绝对路径：${file.path}`)
      if (!file.path.endsWith('package.json')) continue
      const packaged = readJson(path.join(destination, file.path))
      for (const section of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']) {
        for (const value of Object.values(packaged[section] ?? {})) {
          assert.ok(!/^(?:file:|link:|workspace:)/.test(String(value)), `生产依赖包含本地引用：${file.path}`)
        }
      }
    }
    for (const name of ['@deepseek-ai/dsh', ...dependencyPackages]) {
      const packageManifest = readJson(name === '@deepseek-ai/dsh'
        ? path.join(destination, '.runtime-build/dsh/node_modules/@deepseek-ai/dsh/package.json')
        : path.join(destination, 'node_modules', name, 'package.json'))
      for (const section of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']) {
        for (const value of Object.values(packageManifest[section] ?? {})) assert.ok(!String(value).startsWith('file:'), `生产依赖包含 file: ${name}`)
      }
    }
    const vsix = path.join(root, `letscoding-${manifest.version}-linux-x64.vsix`)
    fs.rmSync(vsix, { force: true })
    run('npm', ['exec', '--yes', '--package=@vscode/vsce', '--', 'vsce', 'package', '--allow-missing-repository', '--out', vsix], { cwd: destination, env: npmEnvironment })
    const packager = run('npm', ['exec', '--yes', '--package=@vscode/vsce', '--', 'vsce', '--version'], { cwd: destination, env: { ...process.env, CI: 'true', NPM_CONFIG_REGISTRY: 'https://registry.npmjs.org', npm_config_registry: 'https://registry.npmjs.org' } }).trim()
    const report = {
      schemaVersion: 1, status: 'packaged', platform: config.platform,
      name: path.basename(vsix), version: manifest.version,
      bytes: fs.statSync(vsix).size, sha256: createHash('sha256').update(fs.readFileSync(vsix)).digest('hex'),
      node: config.node.version, dsh: config.dsh.version,
      build: { node: process.version, packager: `@vscode/vsce@${packager}`, os: process.platform, arch: process.arch, libc: process.report?.getReport().header.glibcVersionRuntime },
      fileCount: files.length, unpackedBytes: files.reduce((sum, file) => sum + file.bytes, 0),
      files, licenses: notices, licenseSupplements,
    }
    fs.writeFileSync(path.join(root, 'build/vsix-package.json'), JSON.stringify(report, null, 2) + '\n')
    console.log(`VSIX packaged: ${vsix}`)
    console.log(`Files: ${files.length}; bytes: ${report.bytes}; licenses: ${notices.length}; SHA-256: ${report.sha256}`)
    return report
  } finally { fs.rmSync(temporary, { recursive: true, force: true }) }
}

if (require.main === module) {
  try { packageVsix() } catch (error) { console.error(error.stack); process.exitCode = 1 }
}
module.exports = { packageVsix, walk, run, assertLicenses, clientClosure }
