const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { supplementLicenses, hasLicense } = require('./runtime-licenses.cjs')
const { assertLicenses } = require('./vsix-package.cjs')

const root = path.resolve(__dirname, '..')
const staging = path.join(root, '.runtime-build/dsh')
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'coding-agent-licenses-'))
try {
  const name = '@aws-sdk/credential-provider-http'
  const directory = path.join(work, 'node_modules', name)
  fs.mkdirSync(directory, { recursive: true })
  const original = JSON.parse(fs.readFileSync(path.join(staging, 'node_modules', name, 'package.json'), 'utf8'))
  const manifestPath = path.join(directory, 'package.json')
  const materials = path.join(work, 'materials')
  fs.mkdirSync(materials)
  fs.copyFileSync(path.join(root, 'config/runtime-licenses/aws-apache-2.0.txt'), path.join(materials, 'aws-apache-2.0.txt'))
  original.version = 'wrong-version'
  fs.writeFileSync(manifestPath, JSON.stringify(original))
  assert.throws(() => supplementLicenses(work, materials), /包版本已变化/)
  original.version = '3.972.74'
  fs.writeFileSync(manifestPath, JSON.stringify(original))
  fs.appendFileSync(path.join(materials, 'aws-apache-2.0.txt'), 'tampered\n')
  assert.throws(() => supplementLicenses(work, materials), /固定许可证材料哈希不匹配/)
  assert.equal(hasLicense(directory), false)
  assert.throws(() => assertLicenses(work, ['node_modules/@aws-sdk/credential-provider-http/package.json']), /包缺少许可证文本/)
  const packages = JSON.parse(fs.readFileSync(path.join(root, 'build/dsh-production-closure.json'), 'utf8')).packages
  const manifests = packages.flatMap(item => (item.stagingPaths ?? [item.stagingPath]).map(directory => `${directory}/package.json`))
  const isolated = path.join(work, 'isolated')
  fs.cpSync(staging, isolated, { recursive: true })
  const audit = supplementLicenses(isolated)
  assert.ok(audit.length >= 14)
  assert.equal(supplementLicenses(isolated).length, 0, '重复补齐必须幂等')
  assert.equal(assertLicenses(isolated, manifests).length, manifests.length)
  console.log('Runtime license audit passed: package drift and material tampering rejected; all staged packages have license texts.')
} finally { fs.rmSync(work, { recursive: true, force: true }) }
