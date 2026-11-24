const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { createHash } = require('node:crypto')

// These packages omit license text from their npm tarball. Never infer a
// license for a new package/version; review its declared license and source.
const rules = {
  '@aws-sdk/credential-provider-http@3.972.74': { license: 'Apache-2.0', files: ['aws-apache-2.0.txt'] },
  '@aws-sdk/credential-provider-login@3.972.79': { license: 'Apache-2.0', files: ['aws-apache-2.0.txt'] },
  '@aws-sdk/nested-clients@3.997.46': { license: 'Apache-2.0', files: ['aws-apache-2.0.txt'] },
  '@deepseek-ai/libreoffice-kit-wasm@0.1.5': { license: 'MPL-2.0', embedded: [{ source: 'licenses/LICENSE', target: 'LICENSE' }] },
  '@earendil-works/pi-ai@1.3.0': { license: 'MIT', files: ['pi-mit.txt'] },
  '@earendil-works/pi-telemetry@1.3.0': { license: 'MIT', files: ['pi-mit.txt'] },
  '@img/sharp-libvips-linux-x64@1.3.4': { license: 'LGPL-3.0-or-later', files: ['lgpl-3.0.txt', 'gpl-3.0.txt', 'libvips-third-party-notices.txt'] },
  '@koromix/koffi-linux-x64@3.1.1': { license: 'MIT', files: ['koffi-mit.txt'] },
  'brotli@1.3.3': { license: 'MIT', author: 'Devon Govett', declared: 'package.json and readme.md' },
  'data-uri-to-buffer@4.0.1': { license: 'MIT', files: ['tootallnate-mit.txt'] },
  'dfa@1.2.0': { license: 'MIT', author: 'Devon Govett', declared: 'package.json and README.md' },
  'fontkit@2.0.4': { license: 'MIT', files: ['fontkit-mit.txt'] },
  'proxy-agent-negotiate@1.1.0': { license: 'MIT', files: ['tootallnate-mit.txt'] },
  'saxes@6.0.0': { license: 'ISC', files: ['saxes-isc.txt'] },
  'standardwebhooks@1.1.1': { license: 'MIT', files: ['standardwebhooks-mit.txt'] },
}

const sources = {
  'aws-apache-2.0.txt': 'https://github.com/aws/aws-sdk-js-v3/blob/main/LICENSE',
  'pi-mit.txt': 'https://github.com/earendil-works/pi/blob/v1.3.0/LICENSE',
  'koffi-mit.txt': 'https://github.com/Koromix/koffi/blob/master/LICENSE.txt',
  'fontkit-mit.txt': 'https://github.com/foliojs/fontkit/blob/master/LICENSE',
  'tootallnate-mit.txt': 'https://github.com/TooTallNate/proxy-agents/blob/main/packages/data-uri-to-buffer/LICENSE',
  'standardwebhooks-mit.txt': 'https://github.com/standard-webhooks/standard-webhooks/blob/main/libraries/LICENSE',
  'saxes-isc.txt': 'https://github.com/lddubeau/saxes/blob/v6.0.0/LICENSE',
  'libvips-third-party-notices.txt': 'https://github.com/lovell/sharp-libvips/blob/v1.3.4/THIRD-PARTY-NOTICES.md',
  'lgpl-3.0.txt': 'https://www.gnu.org/licenses/lgpl-3.0.txt (Debian common-licenses/LGPL-3)',
  'gpl-3.0.txt': 'https://www.gnu.org/licenses/gpl-3.0.txt (Debian common-licenses/GPL-3)',
}

const hashes = {
  'aws-apache-2.0.txt': 'edea91454b811f127fbdea3d86f378f6719bd372ed440abf82b232f6fca06c3d',
  'fontkit-mit.txt': 'cf22b8198f0886a8d4626121579114f23141070e1fceab02ab3c1c361e163440',
  'gpl-3.0.txt': '8ceb4b9ee5adedde47b31e975c1d90c73ad27b6b165a1dcd80c7c545eb65b903',
  'koffi-mit.txt': '54abb741a2ba1a7fa89e98d2d3199575e548c8708885eeadab0f5bb83ad22e0e',
  'lgpl-3.0.txt': 'da7eabb7bafdf7d3ae5e9f223aa5bdc1eece45ac569dc21b3b037520b4464768',
  'libvips-third-party-notices.txt': '6f0d5086e3bcbee12bcdacf5878b31d1104002aeecaeb241d3fff466108082fe',
  'pi-mit.txt': '0457f5bcec3b3b211605dfb5d1a49042fd638f3686a410fe099c24a25af13c48',
  'saxes-isc.txt': '0fac2374380621b22e6b50451057721a9c52935b02d16d106a9f04897f061d0e',
  'standardwebhooks-mit.txt': '5ec8c7b26b64d881a6706617bed25c049f97f2f35de034c756de8546fd6dbe27',
  'tootallnate-mit.txt': '29308c08926e2139ce2c6dc389fc7d6ac801927df4941c19fa92de4a8b18da12',
}

const licensePattern = /^(?:LICENSE|LICENCE|COPYING)(?:[-.]|$)/i
function hasLicense(directory) {
  return fs.readdirSync(directory).some(name => licensePattern.test(name) || /^license-(?:mit|cc0)$/i.test(name))
}

function mitText(author) {
  return `MIT License\n\nCopyright (c) ${author}\n\nPermission is hereby granted, free of charge, to any person obtaining a copy\nof this software and associated documentation files (the "Software"), to deal\nin the Software without restriction, including without limitation the rights\nto use, copy, modify, merge, publish, distribute, sublicense, and/or sell\ncopies of the Software, and to permit persons to whom the Software is\nfurnished to do so, subject to the following conditions:\n\nThe above copyright notice and this permission notice shall be included in all\ncopies or substantial portions of the Software.\n\nTHE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR\nIMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,\nFITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE\nAUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER\nLIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,\nOUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE\nSOFTWARE.\n`
}

function supplementLicenses(staging, materials = path.resolve(__dirname, '../config/runtime-licenses')) {
  const audit = []
  for (const [reference, rule] of Object.entries(rules)) {
    const at = reference.lastIndexOf('@')
    const name = reference.slice(0, at)
    const version = reference.slice(at + 1)
    const directory = path.join(staging, 'node_modules', name)
    const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'package.json'), 'utf8'))
    assert.equal(manifest.version, version, `许可证补齐的包版本已变化：${reference}`)
    assert.equal(manifest.license, rule.license, `许可证声明已变化：${reference}`)
    if (hasLicense(directory)) continue
    const files = []
    for (const item of rule.embedded ?? []) {
      const destination = path.join(directory, item.target)
      fs.copyFileSync(path.join(directory, item.source), destination)
      files.push(item.target)
    }
    for (const file of rule.files ?? []) {
      const content = fs.readFileSync(path.join(materials, file))
      assert.equal(createHash('sha256').update(content).digest('hex'), hashes[file], `固定许可证材料哈希不匹配：${file}`)
      const target = file === 'libvips-third-party-notices.txt' ? 'LICENSE-third-party-notices.txt' : file.startsWith('gpl-') ? 'COPYING-GPL-3.0.txt' : 'LICENSE'
      fs.writeFileSync(path.join(directory, target), content)
      files.push(target)
    }
    if (rule.author) {
      const text = mitText(rule.author)
      fs.writeFileSync(path.join(directory, 'LICENSE'), text)
      files.push('LICENSE')
    }
    audit.push({ name, version, license: rule.license, files, source: rule.author ? `Declared MIT by ${rule.author} in ${rule.declared}; standard MIT text added.` : (rule.files ?? []).map(file => sources[file]) })
  }
  return audit
}

module.exports = { supplementLicenses, hasLicense, rules }
