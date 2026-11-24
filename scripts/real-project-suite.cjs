async function run() {
  const assert = require('node:assert/strict')
  const { execFileSync } = require('node:child_process')
  const fs = require('node:fs')
  const path = require('node:path')
  const { createHarness } = await import('../out/runtime.js')
  const { testSummary } = await import('../out/diagnostics.js')
  const cwd = path.resolve(__dirname, '../../.vscode-agent-dev/real-project-workspace')
  fs.rmSync(cwd, { recursive: true, force: true })
  fs.mkdirSync(cwd, { recursive: true })
  const git = args => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
  git(['init'])
  git(['config', 'user.email', 'agent-test@localhost'])
  git(['config', 'user.name', 'Agent Test'])
  fs.writeFileSync(path.join(cwd, 'package.json'), JSON.stringify({ private: true, type: 'module', scripts: { test: 'node --test' } }))
  fs.writeFileSync(path.join(cwd, 'calculator.js'), 'export function add(left, right) {\n  return left - right\n}\n')
  fs.writeFileSync(path.join(cwd, 'calculator.test.js'), "import assert from 'node:assert/strict'\nimport test from 'node:test'\nimport { add } from './calculator.js'\ntest('adds numeric values', () => assert.equal(add(20, 22), 42))\n")
  git(['add', '.'])
  git(['commit', '-m', 'Fixture with failing addition'])
  const options = {
    extensionRoot: path.resolve(__dirname, '..'), dshHome: process.env.DSH_AGENT_HOME, cwd,
    provider: 'deepseek-account', model: 'deepseek-flash', approvalRequests: true, permissionMode: 'workspace-write',
  }
  let harness = createHarness(options)
  let sessionId = ''
  try {
    await harness.start()
    let observedTests = false
    const result = await harness.run('calculator.js 的 add 实现有错误，导致测试失败。请只修改 calculator.js 修复加法，不修改测试；然后运行 npm test 验证。')
    const bashCommands = new Map()
    for (const event of result.events) {
      if (event.type === 'tool/call' && event.data.name === 'bash') bashCommands.set(event.data.callId, JSON.parse(event.data.arguments).command)
      if (event.type !== 'tool/result') continue
      const callId = event.data.message?.source?.callId ?? event.data.message?.toolCallId
      if (!bashCommands.has(callId)) continue
      const text = event.data.message?.content?.flatMap(block => block.type === 'text' ? [block.text] : (block.content ?? []).map(part => part.text ?? '')).join('\n') ?? ''
      const summary = testSummary(bashCommands.get(callId), text, event.data.error !== undefined)
      if (summary?.status === 'passed') observedTests = true
    }
    sessionId = result.sessionId
    assert.equal(result.finishReason, 'completed')
    assert.match(fs.readFileSync(path.join(cwd, 'calculator.js'), 'utf8'), /left \+ right/)
    execFileSync('npm', ['test'], { cwd, encoding: 'utf8', stdio: 'pipe' })
    assert.ok(observedTests, 'DSH must actually run a passing test, not merely report one')
    assert.match(git(['diff', '--', 'calculator.js']), /\+  return left \+ right/)
    assert.equal(git(['diff', '--name-only']), 'calculator.js')
  } finally { await harness.close() }
  harness = createHarness(options)
  try {
    await harness.start()
    const session = await harness.resumeSession(sessionId)
    const resumed = await session.run('不要使用工具，只回复刚才修复的是哪个函数，以及验证命令。')
    assert.equal(resumed.finishReason, 'completed')
    assert.match(resumed.finalResponse, /add/)
    assert.match(resumed.finalResponse, /npm test/)
    console.log('Real project edit, passing tests, Git diff and resumed Session passed')
  } finally {
    await harness.close()
    fs.rmSync(cwd, { recursive: true, force: true })
  }
}
module.exports = { run }
