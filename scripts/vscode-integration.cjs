const { runTests } = require('@vscode/test-electron')
const path = require('node:path')
const fs = require('node:fs')

async function main() {
  delete process.env.ELECTRON_RUN_AS_NODE
  // Every test run owns its Session history; never pollute the interactive store.
  const sharedHome = path.resolve(__dirname, '../../.dsh-dev')
  const isolatedHome = process.env.VSCODE_AGENT_SUITE === 'runtime-launch-suite.cjs'
  const testHome = fs.mkdtempSync(path.resolve(__dirname, '../../.vscode-agent-dev/dsh-test-'))
  process.env.DSH_AGENT_HOME = testHome
  if (!isolatedHome) {
    for (const name of ['.credentials.yaml', 'cordis.patch.yml']) {
      const source = path.join(sharedHome, name)
      if (fs.existsSync(source)) fs.copyFileSync(source, path.join(testHome, name), fs.constants.COPYFILE_EXCL)
    }
    fs.cpSync(path.join(sharedHome, 'profiles'), path.join(testHome, 'profiles'), { recursive: true })
    fs.chmodSync(path.join(testHome, '.credentials.yaml'), 0o600)
  }
  process.env.VSCODE_AGENT_DEBUG = '1'
  const testWorkspace = path.resolve(__dirname, '..', process.env.VSCODE_AGENT_WORKSPACE ?? '../.vscode-agent-dev/model-test-workspace')
  const { mkdirSync, realpathSync } = require('node:fs')
  mkdirSync(testWorkspace, { recursive: true })
  const devRoot = realpathSync(path.resolve(__dirname, '../../.vscode-agent-dev'))
  const realWorkspace = realpathSync(testWorkspace)
  if (path.dirname(realWorkspace) !== devRoot) throw new Error('Integration tests require a direct child of .vscode-agent-dev')
  const userData = process.env.VSCODE_AGENT_USER_DATA === undefined
    ? (process.env.VSCODE_AGENT_SUITE === undefined
      ? require('node:fs').mkdtempSync(path.resolve(__dirname, '../../.vscode-agent-dev/test-user-'))
      : path.resolve(__dirname, '../../.vscode-agent-dev/test-user'))
    : path.resolve(__dirname, '..', process.env.VSCODE_AGENT_USER_DATA)
  await runTests({
    vscodeExecutablePath: '/usr/share/code/code',
    extensionDevelopmentPath: path.resolve(__dirname, '..'),
    extensionTestsPath: path.resolve(__dirname, process.env.VSCODE_AGENT_SUITE ?? 'vscode-suite.cjs'),
    launchArgs: [
      '/usr/share/code/resources/app/out/main.js',
      '--new-window',
      '--user-data-dir=' + userData,
      '--extensions-dir=' + path.resolve(__dirname, '../../.vscode-agent-dev/test-extensions'),
      testWorkspace,
    ],
  })
}
main().catch(error => { console.error(error); process.exitCode = 1 })
