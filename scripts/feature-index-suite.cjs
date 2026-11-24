const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const { catalogPath, indexPath, loadCatalog, validateCatalog, renderIndex, main } = require('./feature-index.cjs')

const catalog = loadCatalog()
assert.equal(catalog.schemaVersion, 1)
assert.ok(catalog.features.length >= 18)
assert.ok(catalog.features.length <= 30)
assert.equal(validateCatalog(catalog).length, 0, 'The real feature catalog must be valid')
assert.equal(fs.readFileSync(indexPath, 'utf8'), renderIndex(catalog), 'Generated documentation must be current')

function rejected(mutate, expected) {
  const candidate = structuredClone(catalog)
  mutate(candidate)
  const errors = validateCatalog(candidate)
  assert.ok(errors.some(error => error.includes(expected)), `Expected ${expected}; received: ${errors.join('; ')}`)
}

rejected(value => { value.features[0].entry.path = 'src/does-not-exist.ts' }, '索引路径不存在')
rejected(value => { value.features[1].id = value.features[0].id }, '功能 id 必须唯一')
rejected(value => { value.features[1].entry.symbols = ['NonexistentMethod'] }, '索引符号/锚点不存在')
rejected(value => { value.features[1].tests = ['missing-test'] }, '未登记测试')
rejected(value => { value.features[1].dependsOn = ['missing-feature'] }, '未登记依赖')
rejected(value => { value.features[0].outbound = ['unregistered'] }, 'outbound')
rejected(value => { value.features[0].dom[0].selector = '#not-a-real-element' }, 'DOM 锚点不存在')
rejected(value => { value.features[0].dom[0].function = 'nonexistentHandler' }, 'DOM 处理函数不存在')
rejected(value => { value.integrations[0].path = '/etc/passwd' }, '路径超出允许')
rejected(value => { value.features = value.features.filter(feature => !JSON.stringify(feature).includes('src/diagnostics.ts')) }, '生产模块未归属任何功能')

const document = renderIndex(catalog)
for (const match of document.matchAll(/\]\(([^)#]+?)(?:#[^)]+)?\)/g)) {
  if (/^[a-z]+:/i.test(match[1])) continue
  const target = path.resolve(path.dirname(indexPath), decodeURIComponent(match[1]))
  assert.ok(fs.existsSync(target), `Generated documentation link must exist: ${match[1]}`)
}
assert.ok(document.includes('## 5. 消息与事件协议清单'))
assert.ok(document.includes('## 7. 测试矩阵'))
assert.ok(document.includes('npm run index:check'))

const temporary = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'feature-index-cli-'))
try {
  const docs = path.join(temporary, 'docs')
  fs.mkdirSync(docs)
  const paths = { catalogPath: path.join(docs, 'feature-catalog.json'), indexPath: path.join(docs, 'FEATURE_INDEX.md') }
  fs.copyFileSync(catalogPath, paths.catalogPath)
  main([], paths)
  assert.ok(fs.existsSync(paths.indexPath))
  main(['--check'], paths)
  fs.appendFileSync(paths.indexPath, '\n stale local edit\n')
  assert.throws(() => main(['--check'], paths), /已过期/)
  fs.writeFileSync(paths.catalogPath, '{ invalid json')
  assert.throws(() => main([], paths), /Expected property name|JSON/)
  const script = path.join(temporary, 'bad-json-cli.cjs')
  const generator = JSON.stringify(path.join(__dirname, 'feature-index.cjs'))
  fs.writeFileSync(script, `const { main } = require(${generator}); main([], { catalogPath: process.argv[2], indexPath: process.argv[3] })`)
  const cli = spawnSync(process.execPath, [script, paths.catalogPath, paths.indexPath], { encoding: 'utf8' })
  assert.equal(cli.status, 1)
  assert.match(cli.stderr, /Expected property name|JSON/)
} finally {
  fs.rmSync(temporary, { recursive: true, force: true })
}

console.log(`Feature index validation, ${catalog.features.length} features, anchors, protocol, links, generation and corruption rejection passed`)
