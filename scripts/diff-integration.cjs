const { runTests } = require('@vscode/test-electron')
const path = require('node:path')
runTests({
  vscodeExecutablePath: '/usr/bin/code',
  extensionDevelopmentPath: path.resolve(__dirname, '..'),
  extensionTestsPath: path.resolve(__dirname, 'diff-suite.cjs'),
  launchArgs: [
    '--user-data-dir=' + path.resolve(__dirname, '../../.vscode-agent-dev/diff-user'),
    '--extensions-dir=' + path.resolve(__dirname, '../../.vscode-agent-dev/test-extensions'),
    path.resolve(__dirname, '../../stage1-fixture'),
  ],
}).catch(error => { console.error(error); process.exitCode = 1 })
