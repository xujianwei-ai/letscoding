const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { baselinePath, validateLock, sourceFiles, sha256 } = require('./runtime-baseline.cjs')

const root = path.resolve(__dirname, '..')
const generatedPath = path.join(root, 'build/dsh-production-closure.json')
const PLATFORM_PACKAGE = '@deepseek-ai/node-addon-system-linux-x64'

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}

function repositoryPaths(repository) {
  return sourceFiles(repository).filter(file => file.endsWith('/package.json'))
    .filter(file => /^(?:packages\/[^/]+\/[^/]+|apps\/[^/]+|vendor\/[^/]+|native\/system(?:\/packages\/[^/]+)?)\/package\.json$/.test(file))
}

function discoverPackages(repository) {
  const packages = new Map()
  const directories = repositoryPaths(repository).map(file => path.dirname(path.resolve(repository, file)))
  for (const directory of directories) {
    const relative = path.relative(repository, directory).split(path.sep).join('/')
    if (!/^(?:packages\/[^/]+\/[^/]+|apps\/[^/]+|vendor\/[^/]+|native\/system(?:\/packages\/[^/]+)?)$/.test(relative)) continue
    const manifestPath = path.join(directory, 'package.json')
    if (!fs.existsSync(manifestPath)) continue
    const manifest = readJson(manifestPath)
    assert.equal(typeof manifest.name, 'string', `包缺少名称: ${relative}`)
    assert.equal(typeof manifest.version, 'string', `包缺少版本: ${relative}`)
    assert.ok(!packages.has(manifest.name), `包名重复: ${manifest.name}`)
    packages.set(manifest.name, { name: manifest.name, version: manifest.version, directory, relative, manifest })
  }
  return packages
}

function sectionEntries(manifest) {
  const sections = ['dependencies', 'optionalDependencies', 'peerDependencies']
  return sections.flatMap(section => Object.entries(manifest[section] ?? {}).map(([name, range]) => ({
    name, range, section, optional: section === 'optionalDependencies' || section === 'peerDependencies' && manifest.peerDependenciesMeta?.[name]?.optional === true,
  })))
}

function lockPackage(repository, name, version) {
  const lines = fs.readFileSync(path.join(repository, 'pnpm-lock.yaml'), 'utf8').split('\n')
  const prefix = `${name}@${version}:`
  const index = lines.findIndex(line => line === `  ${prefix}` || line === `  '${prefix.slice(0, -1)}':`)
  assert.ok(index >= 0, `外部依赖未在 pnpm lockfile 中固定: ${name}@${version}`)
  const end = lines.findIndex((line, offset) => offset > index && /^  \S/.test(line))
  const fields = Object.fromEntries(lines.slice(index + 1, end < 0 ? undefined : end).flatMap(line => {
    const match = line.match(/^    (resolution|version|integrity): (.+)$/)
    return match === null ? [] : [[match[1], match[2]]]
  }))
  return { integrity: fields.resolution?.match(/integrity: ([^,}]+)/)?.[1], resolution: fields.resolution }
}

function locatePackage(parentDirectory, name, repository) {
  let current = parentDirectory
  while (current.startsWith(repository)) {
    const candidate = path.join(current, 'node_modules', ...name.split('/'))
    if (fs.existsSync(path.join(candidate, 'package.json'))) return fs.realpathSync(candidate)
    const parent = path.dirname(current)
    if (parent === current) break
    current = parent
  }
  throw new Error(`本地安装缺少生产依赖: ${name}（从 ${path.relative(repository, parentDirectory)} 解析）`)
}

function collectClosure(lock, repository) {
  validateLock(lock)
  const packages = discoverPackages(repository)
  const entryPackage = lock.dsh.productionClosure.compiledEntryPackage
  const profile = profileClosure(lock, packages, repository)
  const queue = [...new Set(lock.dsh.productionClosure.roots)].filter(name => name !== entryPackage)
  const parents = new Map()
  const edges = new Map()
  const records = new Map()
  const processed = new Set()
  const installedDirectories = new Map()
  const resolvedDependencies = new Map()
  const rejected = []
  for (const name of queue) {
    assert.ok(packages.has(name), `运行时根包不在 DSH workspace: ${name}`)
    if (!parents.has(name)) parents.set(name, [])
  }
  for (let index = 0; index < queue.length; index += 1) {
    const key = queue[index]
    if (processed.has(key)) continue
    processed.add(key)
    const item = records.get(key) ?? packages.get(key) ?? edges.get(key)
    assert.ok(item, `闭包包不存在: ${key}`)
    installedDirectories.set(item, fs.realpathSync(item.directory))
    const name = item.name
    if (!item.external) {
      if (item.manifest.private === true) rejected.push(`${item.relative}: private workspace 包不能作为 npm 发布闭包成员`)
      if (item.manifest.publishConfig?.access !== 'public') rejected.push(`${item.relative}: 缺少 publishConfig.access=public`)
    }
    for (const dependency of sectionEntries(item.manifest)) {
      // External packages that are already selected still need their complete runtime subtree.
      if (!item.external && !profile.has(name) && !profile.has(dependency.name) && !lock.dsh.productionClosure.roots.includes(dependency.name)) continue
      // An optional peer is supplied only by a deliberate runtime root; a devDependency
      // in the authoring checkout must not silently become part of the VSIX.
      if (dependency.section === 'peerDependencies' && dependency.optional) continue
      if (!item.external && packages.has(dependency.name) && dependency.name !== entryPackage) {
        if (dependency.optional && !isCompatible(packages.get(dependency.name).manifest, lock.platform)) continue
        if (!parents.has(dependency.name)) {
          parents.set(dependency.name, [item])
          queue.push(dependency.name)
        } else if (!parents.get(dependency.name).includes(item)) parents.get(dependency.name).push(item)
      } else if (packages.has(dependency.name)) {
        const installed = packages.get(dependency.name)
        const key = `${dependency.name}@${installed.version}`
        if (!records.has(key)) {
          records.set(key, { ...installed, packagedWorkspace: true })
          parents.set(key, [item])
          queue.push(key)
        } else if (!parents.get(key).includes(item)) parents.get(key).push(item)
      } else {
        if (dependency.optional && dependency.name.startsWith('@deepseek-ai/node-addon-system-') && dependency.name !== PLATFORM_PACKAGE) continue
        let directory
        try { directory = locatePackage(item.directory, dependency.name, repository) } catch (error) {
          if (dependency.optional) continue
          rejected.push(error.message)
          continue
        }
        const installedManifest = readJson(path.join(directory, 'package.json'))
        const key = `${dependency.name}@${installedManifest.version}`
        if (!resolvedDependencies.has(item)) resolvedDependencies.set(item, new Map())
        resolvedDependencies.get(item).set(dependency.name, key)
        if (!edges.has(key)) {
          edges.set(key, { ...lockPackage(repository, dependency.name, installedManifest.version),
            name: dependency.name, ranges: [dependency.range], version: installedManifest.version,
            directory, relative: path.relative(repository, directory).split(path.sep).join('/'),
            external: true, manifest: installedManifest,
          })
          parents.set(key, [item])
          if (!isCompatible(installedManifest, lock.platform)) rejected.push(`${dependency.name}: 当前平台不兼容 ${lock.platform.os}/${lock.platform.arch}`)
          else queue.push(key)
        } else {
          if (!edges.get(key).ranges.includes(dependency.range)) edges.get(key).ranges.push(dependency.range)
          if (!parents.get(key).includes(item)) parents.get(key).push(item)
        }
      }
    }
    if (!records.has(key)) records.set(key, item)
  }
  for (const name of profile) if (!queue.includes(name)) queue.push(name)
  const recordKeys = new Map([...records].map(([key, item]) => [key, item.external ? key : item.name]))
  for (const key of processed) if (!recordKeys.has(key)) recordKeys.set(key, key)
  const aliases = new Map()
  const canonicalRecords = new Map()
  for (const [key, item] of records) {
    if (item.external) canonicalRecords.set(key, item)
    else {
      const canonical = packages.get(item.name)
      assert.ok(canonical !== undefined, `已安装的内部包不在锁定 workspace 中: ${item.name}`)
      assert.equal(canonical.version, item.version, `workspace 发布版本不一致: ${item.name}`)
      aliases.set(item, canonical)
      canonicalRecords.set(item.name, canonical)
    }
  }
  for (const [key, item] of parents) parents.set(key, item.map(parent => aliases.get(parent) ?? parent))
  const canonicalDependencies = new Map()
  for (const [consumer, dependencies] of resolvedDependencies) canonicalDependencies.set(aliases.get(consumer) ?? consumer, dependencies)
  for (let index = 0; index < queue.length; index += 1) queue[index] = recordKeys.get(queue[index]) ?? queue[index]
  const canonicalQueue = [...new Set(queue)]
  placeVersionedPackages(canonicalQueue, canonicalRecords, parents, packages, repository, installedDirectories, canonicalDependencies)
  validateProfile(lock, packages, canonicalRecords, profile, repository)
  const linkFindings = []
  const checkedDirectories = new Set()
  for (const item of canonicalRecords.values()) {
    if (checkedDirectories.has(item.directory) || !fs.existsSync(item.directory)) continue
    checkedDirectories.add(item.directory)
    const directories = ['lib', 'bin', 'dist'].map(name => path.join(item.directory, name)).filter(directory => fs.existsSync(directory))
    const stack = [...directories]
    for (let directory = stack.pop(); directory !== undefined; directory = stack.pop()) {
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        if (entry.name === 'node_modules') continue
        if (entry.isDirectory()) stack.push(path.join(directory, entry.name))
        else if (entry.isSymbolicLink()) inspectLink(item, directory, entry.name, linkFindings)
      }
    }
  }
  for (const item of canonicalRecords.values()) item.stagingPaths = [...new Set(item.stagingPaths)].sort()
  return { packages, records: canonicalRecords, queue: canonicalQueue, parents, externals: edges, rejected, linkFindings }
}

/** Preserve Node's version-aware lookup using only ordinary nested node_modules. */
function placeVersionedPackages(queue, records, parents, packages, repository, installedDirectories, resolvedDependencies) {
  const rootPackage = readJson(path.join(repository, 'package.json'))
  const rootNames = new Set(Object.keys(rootPackage.dependencies ?? {}))
  const rootVersions = new Map()
  for (const key of queue) {
    const item = records.get(key)
    if (item.external && !rootVersions.has(item.name)) rootVersions.set(item.name, item)
    item.stagingPaths = []
  }
  const owners = new Map()
  const claim = (item, candidate) => {
    assert.ok(candidate.startsWith('node_modules/') && !path.isAbsolute(candidate) && !candidate.split('/').includes('..'), `暂存路径非法: ${candidate}`)
    const owner = owners.get(candidate)
    assert.ok(owner === undefined || owner === item, `多个版本争用同一暂存路径: ${candidate}: ${owner?.version} -> ${item.version}`)
    owners.set(candidate, item)
    if (!item.stagingPaths.includes(candidate)) item.stagingPaths.push(candidate)
  }
  const checked = new Set()
  const check = (item, target) => {
    const key = `${item.name}@${item.version} -> ${target}`
    if (checked.has(key)) return
    checked.add(key)
    for (const [name, dependencyKey] of resolvedDependencies.get(item) ?? []) {
      const expected = records.get(dependencyKey)
      const parts = target.split('/')
      const rootPackageDepth = parts[0] === 'node_modules' && parts[1]?.startsWith('@') ? 3 : 2
      let current = parts.length === rootPackageDepth ? target : path.posix.dirname(target)
      let resolved = false
      while (true) {
        const candidate = `${current === '.' ? '' : `${current}/`}node_modules/${name}`
        const owner = owners.get(candidate)
        if (owner) {
          if (owner === expected) resolved = true
          break
        }
        const parent = path.posix.dirname(current)
        if (parent === current) break
        current = parent
      }
      if (!resolved) {
        const candidate = path.posix.join(target, 'node_modules', ...name.split('/'))
        claim(expected, candidate)
        check(expected, candidate)
      }
    }
  }
  for (const key of queue) {
    const item = records.get(key)
    if (!item.external || rootVersions.get(item.name) === item && rootNames.has(item.name)) claim(item, `node_modules/${item.name}`)
  }
  for (const key of queue) {
    const item = records.get(key)
    if (item.external && !owners.has(`node_modules/${item.name}`)) claim(item, `node_modules/${item.name}`)
  }
  for (const key of queue) check(records.get(key), `node_modules/${records.get(key).name}`)
  for (const item of records.values()) {
    item.stagingPaths.sort()
    assert.ok(item.stagingPaths.length > 0, `没有消费者的暂存路径: ${item.name}@${item.version}`)
  }
}

function stagingPaths(item) {
  assert.ok(Array.isArray(item.stagingPaths) && item.stagingPaths.length > 0, `缺少精确暂存路径: ${item.name}@${item.version}`)
  return item.stagingPaths
}

function isNodeDependencyPath(consumerPath, dependencyPath) {
  const segments = dependencyPath.split('/')
  const nodeModules = segments.lastIndexOf('node_modules')
  assert.ok(nodeModules >= 0 && nodeModules + 1 < segments.length)
  const packageName = segments.slice(nodeModules + 1).join('/')
  const packageSuffix = `node_modules/${packageName}`
  if (segments[1] !== '.pnpm') {
    const consumerParts = consumerPath.split('/')
    const scope = consumerParts[0] === 'node_modules' && consumerParts[1]?.startsWith('@') ? 3 : 2
    let current = consumerParts.length === scope && consumerParts[0] === 'node_modules' ? consumerPath : path.dirname(consumerPath).split(path.sep).join('/')
    while (true) {
      if (dependencyPath === `${current === '.' ? '' : `${current}/`}${packageSuffix}`) return true
      const parent = path.posix.dirname(current)
      if (parent === current) return false
      current = parent
    }
  }
  // pnpm package instances resolve their dependencies from the sibling node_modules
  // directory, not by recursively inserting another node_modules below the package.
  const instanceRoot = segments.slice(0, nodeModules).join('/')
  const consumerParts = consumerPath.split('/')
  const marker = consumerParts.lastIndexOf('.pnpm')
  if (marker < 0 || consumerParts[marker + 1] !== segments[marker + 1]) return false
  return consumerPath.startsWith(`${instanceRoot}/`) && dependencyPath === `${instanceRoot}/${packageSuffix}`
}

function inspectLink(item, directory, name, linkFindings) {
      const relative = path.relative(item.directory, path.join(directory, name)).split(path.sep).join('/')
      assert.ok(!/^(?:lib|bin|dist)\//.test(relative), `包发布目录不得包含符号链接: ${item.name}/${relative}`)
  linkFindings.push({ package: item.name, path: relative, action: '不得复制到 VSIX；pnpm pack 发布载荷另行验证' })
}

function validateProfile(lock, packages, records, profile, repository) {
  for (const name of profile) {
    assert.ok(records.has(name), `sdk profile 插件不在闭包中: ${name}`)
  }
  for (const item of records.values()) {
    const selected = item.external || profile.has(item.name) || item.name !== lock.dsh.productionClosure.compiledEntryPackage && lock.dsh.productionClosure.roots.includes(item.name)
    if (!selected) continue
    for (const dependency of sectionEntries(item.manifest)) {
      if (dependency.optional) continue
      assert.ok([...records.values()].some(candidate => candidate.name === dependency.name), `运行时必需依赖不在闭包中: ${item.name} -> ${dependency.name}`)
    }
  }
  const base = packages.get('@deepseek-ai/dsh-base').manifest
  assert.ok(base.dependencies['@deepseek-ai/dsh-agent'], 'base profile 必须包含核心 Agent')
  for (const name of ['@deepseek-ai/cordis-plugin-loader', '@deepseek-ai/cordis-plugin-timer']) {
    assert.ok(records.has(name), `sdk 闭包缺少 Cordis 插件: ${name}`)
  }
}

function profileClosure(lock, packages, repository) {
  const queue = []
  const seen = new Set()
  for (const relative of [...lock.dsh.profile.patches, ...lock.dsh.profile.extensionPatches.filter(item => item.mode === 'bundled').map(item => item.path)]) {
    const text = fs.readFileSync(path.join(repository, relative), 'utf8')
    for (const match of text.matchAll(/^\s+name:\s+['"]?(@deepseek-ai\/[^/'"]+)/gm)) {
      const name = match[1].split('/').slice(0, 2).join('/')
      if (!seen.has(name)) { seen.add(name); queue.push(name) }
    }
  }
  for (const name of [...lock.dsh.profile.bundles, '@deepseek-ai/cordis-plugin-loader', '@deepseek-ai/cordis-plugin-include', '@deepseek-ai/cordis-plugin-timer']) {
    if (!seen.has(name)) { seen.add(name); queue.push(name) }
  }
  for (let index = 0; index < queue.length; index += 1) {
    const item = packages.get(queue[index])
    assert.ok(item, `sdk profile 插件没有 workspace 包: ${queue[index]}`)
    for (const dependency of sectionEntries(item.manifest)) {
      if (dependency.optional || !packages.has(dependency.name)) continue
      if (!seen.has(dependency.name)) { seen.add(dependency.name); queue.push(dependency.name) }
    }
  }
  return seen
}

function isCompatible(manifest, platform) {
  const accepts = (values, actual) => values === undefined || values.length === 0 || values.includes(actual) || !values.includes(`!${actual}`) && values.some(value => value.startsWith('!'))
  return accepts(manifest.os, platform.os) && accepts(manifest.cpu, platform.arch)
}

function inspectNative(repository, platform) {
  const name = PLATFORM_PACKAGE
  const installed = path.join(repository, 'native/system/packages/entry/node_modules', ...name.split('/'))
  const prebuilds = readJson(path.join(installed, 'prebuilds.json'))
  assert.equal(prebuilds.platform, `${platform.os}-${platform.arch}`, '原生平台清单与目标不一致')
  const payloads = prebuilds.binaries.map(binary => {
    const absolute = path.join(installed, binary.path)
    const exists = fs.existsSync(absolute)
    const stat = exists ? fs.lstatSync(absolute) : undefined
    assert.ok(!stat?.isSymbolicLink(), `原生载荷不接受链接: ${binary.path}`)
    return {
      ...binary, exists, bytes: stat?.size ?? 0, mode: stat === undefined ? undefined : (stat.mode & 0o777).toString(8),
      sha256: exists ? sha256(fs.readFileSync(absolute)) : undefined,
      requiredExecutable: binary.kind === 'static-musl',
      executable: exists && (stat.mode & 0o111) !== 0,
    }
  })
  const failures = payloads.filter(item => !item.exists || item.requiredExecutable && !item.executable)
  return { package: name, directory: path.relative(repository, installed).split(path.sep).join('/'), payloads, failures }
}

function assertPublishFile(packageName, file) {
  assert.ok(file && !path.isAbsolute(file) && !file.split('/').includes('..'), `发布路径逃逸: ${packageName}/${file}`)
  const segments = file.split('/')
  const excludedDirectory = segments.slice(0, -1).some(segment => /^(?:\.git|\.agents|__tests__|test|tests|benchmark|benchmarks|\.runtime-build)$/.test(segment))
  assert.ok(!excludedDirectory, `发布文件命中排除规则: ${packageName}/${file}`)
  assert.ok(!/(?:\.spec|\.test)\.[cm]?[jt]sx?$/.test(file), `发布文件包含测试: ${packageName}/${file}`)
}

function stagedInventory(repository, graph, staging, native) {
  assert.ok(staging, '严格清单必须指定实际发布暂存区')
  const packages = []
  const packagePaths = new Set()
  const files = []
  const failures = []
  const inventory = new Set()
  const check = (directory, prefix = '') => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name)
      const relative = path.join(prefix, entry.name).split(path.sep).join('/')
      const stat = fs.lstatSync(absolute)
      assert.ok(!stat.isSymbolicLink(), `发布树包含符号链接: ${relative}`)
      if (stat.isDirectory()) {
        assert.ok(relative !== 'node_modules/.pnpm', 'pnpm 虚拟存储只能包含登记的生产包')
        check(absolute, relative)
      } else {
        assert.ok(stat.isFile(), `发布树只能是普通文件或目录: ${relative}`)
        files.push({ path: relative, bytes: stat.size, mode: (stat.mode & 0o777).toString(8), sha256: sha256(fs.readFileSync(absolute)) })
      }
    }
  }
  check(staging)
  for (const item of graph.records.values()) {
    for (const packagePath of stagingPaths(item)) {
      assert.ok(!packagePaths.has(packagePath), `多个包版本被放置到同一目录: ${packagePath}`)
      packagePaths.add(packagePath)
      const directory = path.join(staging, packagePath)
      const manifest = readJson(path.join(directory, 'package.json'))
      assert.equal(manifest.name, item.name, '暂存包名与闭包不一致')
      assert.equal(manifest.version, item.version, `暂存包版本与闭包不一致: ${item.name}`)
      const dependencies = sectionEntries(manifest)
      for (const dependency of dependencies) {
        assert.ok(!dependency.range.startsWith('workspace:'), `暂存清单保留 workspace 依赖: ${item.name}`)
        assert.ok(!dependency.range.startsWith('file:'), `暂存清单保留本地文件依赖: ${item.name}`)
      }
      const packageFiles = files.filter(file => file.path.startsWith(`${packagePath}/`) && !graph.records.values().some(candidate => stagingPaths(candidate).some(nested => nested !== packagePath && nested.startsWith(`${packagePath}/`) && file.path.startsWith(`${nested}/`))))
      assert.ok(packageFiles.some(file => file.path.endsWith('/package.json')), `暂存包缺少 package.json: ${item.name}`)
      for (const file of packageFiles) assertPublishFile(item.name, file.path.slice(`${packagePath}/`.length))
      packages.push({ name: item.name, version: item.version, stagingPath: packagePath, fileCount: packageFiles.length, unpackedBytes: packageFiles.reduce((sum, file) => sum + file.bytes, 0) })
      for (const file of packageFiles) inventory.add(`${item.name}/${file.path.slice(`${packagePath}/`.length)}`)
    }
  }
  const packageBytes = packages.reduce((sum, item) => sum + item.unpackedBytes, 0)
  const metadata = new Set(['package.json', 'runtime-staging.json'])
  for (const file of files) {
    if (metadata.has(file.path)) continue
    const owner = packages.filter(item => file.path.startsWith(`${item.stagingPath}/`)).sort((a, b) => b.stagingPath.length - a.stagingPath.length)[0]
    assert.ok(owner, `文件不属于登记的包: ${file.path}`)
    file.package = owner.name
  }
  const allBytes = files.reduce((sum, file) => sum + file.bytes, 0)
  assert.equal(packageBytes, allBytes - files.filter(file => metadata.has(file.path)).reduce((sum, file) => sum + file.bytes, 0), '发布文件必须全部归属一个已登记包')
  for (const binary of native.payloads) {
    const file = path.join(staging, 'node_modules', ...native.package.split('/'), binary.path)
    assert.equal(sha256(fs.readFileSync(file)), binary.sha256, `原生暂存哈希不一致: ${binary.path}`)
    const mode = fs.lstatSync(file).mode & 0o777
    assert.equal(mode & 0o111, binary.executable ? 0o111 : 0, `原生暂存执行位不一致: ${binary.path}`)
    assert.equal(mode & 0o200, 0o200, `原生暂存文件必须可读且由安装者拥有: ${binary.path}`)
  }
  return { packages, files, failures, packageFileCount: inventory.size }
}

function assertNoHostPaths(packaged, hostRepository) {
  const entries = [...packaged.packages.map(item => [item, item]), ...packaged.files.map(file => [file, packaged.packages.find(item => item.name === file.package)])]
  const forbidden = [process.cwd(), hostRepository, path.dirname(hostRepository), process.env.HOME]
    .filter(value => typeof value === 'string' && path.isAbsolute(value))
  for (const [entry, item] of entries) {
    const serialized = JSON.stringify(entry)
    for (const value of forbidden) assert.ok(!serialized.includes(value), `发布清单泄露开发机路径: ${value}`)
    assert.ok(!path.isAbsolute(entry.path ?? ''), `发布文件使用绝对路径: ${item?.name ?? 'staging'}/${entry.path}`)
  }
  return { checked: true, policy: '清单只使用仓库相对来源路径和包内相对路径；B1 对实际 VSIX 暂存区逐文件复核，不把源码位置当作运行路径。' }
}

function assertDeclaredInputs(lock, graph) {
  for (const item of lock.dsh.packages) assert.ok(graph.records.has(item.name), `基线登记的包不在闭包中: ${item.name}`)
}

function sourceFingerprint(repository) {
  const files = sourceFiles(repository).map(relative => {
    const absolute = path.join(repository, relative)
    const stat = fs.lstatSync(absolute)
    const content = stat.isSymbolicLink() ? Buffer.from(fs.readlinkSync(absolute)) : fs.readFileSync(absolute)
    return { path: relative, bytes: content.length, sha256: sha256(content), mode: stat.mode & 0o111 ? '755' : '644', ...stat.isSymbolicLink() ? { symbolicLink: fs.readlinkSync(absolute) } : {} }
  })
  return { fileCount: files.length, treeSha256: sha256(JSON.stringify({ algorithm: 'sha256', files })), lockfileSha256: sha256(fs.readFileSync(path.join(repository, 'pnpm-lock.yaml'))) }
}

function createClosure(lock, repository, options = {}) {
  const absoluteRepository = fs.realpathSync(repository)
  const graph = collectClosure(lock, absoluteRepository)
  assertDeclaredInputs(lock, graph)
  for (const name of lock.dsh.productionClosure.roots) {
    assert.ok(!graph.packages.get(name).manifest.private, `发布根不能是 private 包: ${name}`)
    assert.equal(graph.packages.get(name).manifest.publishConfig?.access, 'public', `发布根必须允许公开打包: ${name}`)
  }
  const native = inspectNative(absoluteRepository, lock.platform)
  const packed = options.requireBuilt ? stagedInventory(absoluteRepository, graph, options.staging, native) : undefined
  const source = sourceFingerprint(absoluteRepository)
  const baseline = options.sourceBaseline ?? readJson(path.join(root, 'build/runtime-baseline.json'))
  assert.equal(source.treeSha256, baseline.dsh.snapshot.treeSha256, '闭包依赖的源码树与 A2 基线不一致；先审查并重新生成 runtime:baseline')
  const lockedFile = baseline.dsh.snapshot.files.find(item => item.path === 'pnpm-lock.yaml')
  assert.equal(source.lockfileSha256, lockedFile?.sha256, '闭包 lockfile 与 A2 基线不一致')
  const missing = [...graph.rejected, ...native.failures.map(item => `${native.package}: 缺少或不可执行 ${item.path}`)]
  if (packed) missing.push(...packed.failures)
  const packages = [...graph.records.values()].sort((a, b) => a.name.localeCompare(b.name)).map(item => ({
    name: item.name, version: item.version, kind: item.external ? 'external' : 'workspace',
    stagingPath: item.stagingPath ?? `node_modules/${item.name}`,
    stagingPaths: [...new Set(stagingPaths(item))].sort(),
    source: item.relative, externalDirectory: item.external ? item.directory : undefined,
    parents: (graph.parents.get(`${item.name}@${item.version}`) ?? graph.parents.get(item.name) ?? []).map(parent => `${parent.name}@${parent.version}`).sort(),
    license: item.manifest.license,
    dependencies: sectionEntries(item.manifest),
  }))
  return {
    schemaVersion: 1,
    platform: lock.platform,
    dsh: { version: lock.dsh.version, revision: lock.dsh.revision, source, baselineArchiveSha256: baseline.dsh.snapshot.archiveSha256 },
    roots: lock.dsh.productionClosure.roots,
    selection: { sections: lock.dsh.productionClosure.dependencySections, exclusions: lock.dsh.productionClosure.exclusions },
    status: missing.length === 0 && packed !== undefined ? 'artifact-inventory-complete' : 'pending-build-or-missing-inputs',
    packageCount: packages.length,
    externalPackageCount: [...graph.externals.values()].length,
    packages,
    externalDependencies: [...graph.externals.values()].sort((a, b) => `${a.name}@${a.version}`.localeCompare(`${b.name}@${b.version}`))
      .map(item => ({ name: item.name, version: item.version, ranges: item.ranges, integrity: item.integrity, resolution: item.resolution })),
    native,
    pathAudit: { checked: true, manifest: 'relative-only', symlinks: 'forbidden', sourceTreeLinks: graph.linkFindings ?? [], stagedVsixAudit: 'D6' },
    missing,
    artifacts: packed === undefined ? { status: 'not-built', fileCount: 0, unpackedBytes: 0, packedBytes: 0, packages: [] } : {
      status: missing.length === 0 ? 'complete' : 'incomplete', fileCount: packed.files.length,
      unpackedBytes: packed.packages.reduce((sum, item) => sum + item.unpackedBytes, 0),
      packedBytes: null,
      packageFileCount: packed.packageFileCount,
      packages: packed.packages, files: packed.files,
      pathAudit: assertNoHostPaths(packed, absoluteRepository),
    },
  }
}

function main(args = process.argv.slice(2), options = {}) {
  assert.ok(args.every(arg => ['--check', '--require-built', '--package-preview'].includes(arg)), `未知参数；支持 --check、--require-built、--package-preview: ${args.join(' ')}`)
  const lock = readJson(options.baselinePath ?? baselinePath)
  const repository = fs.realpathSync(options.repository ?? path.resolve(root, '../dsh-learning/deepseek-harness'))
  const staging = options.staging ?? path.join(root, lock.dsh.productionClosure.stagingDirectory)
  const requireBuilt = options.requireBuilt ?? !args.includes('--package-preview')
  if (requireBuilt) assert.ok(fs.existsSync(staging), `发布暂存区不存在；先执行 ${lock.dsh.productionClosure.strictCommand}`)
  const output = createClosure(lock, repository, { requireBuilt, sourceBaseline: options.sourceBaseline, staging })
  const serialized = `${JSON.stringify(output, null, 2)}\n`
  const destination = options.generatedPath ?? generatedPath
  if (args.includes('--check')) {
    assert.ok(fs.existsSync(destination), '生产闭包未生成，请先执行 npm run runtime:closure')
    assert.equal(fs.readFileSync(destination, 'utf8'), serialized, 'DSH 生产闭包已变化，请审查后重新生成')
  } else {
    fs.mkdirSync(path.dirname(destination), { recursive: true })
    fs.writeFileSync(destination, serialized)
  }
  console.log(`DSH production closure: ${output.packageCount} packages, ${output.externalPackageCount} external resolutions, missing=${output.missing.length}`)
  console.log(`Native payloads: ${output.native.payloads.filter(item => item.exists).length}/${output.native.payloads.length}; artifact status=${output.artifacts.status}`)
  if (args.includes('--require-built')) assert.equal(output.missing.length, 0, `发布闭包存在缺失:\n${output.missing.join('\n')}`)
  return output
}

if (require.main === module) {
  try { main() } catch (error) { console.error(error instanceof Error ? error.message : error); process.exitCode = 1 }
}

module.exports = { root, generatedPath, readJson, sha256, discoverPackages, collectClosure, inspectNative, isCompatible, createClosure, stagedInventory, main, assertPublishFile, assertNoHostPaths }
