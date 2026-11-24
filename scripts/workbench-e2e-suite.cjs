const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

/** Real DSH + AgentController + real Webview DOM + managed VS Code terminal. */
async function run() {
  const vscode = require('vscode')
  const { execFileSync } = require('node:child_process')
  const root = vscode.workspace.workspaceFolders[0].uri.fsPath
  const fixture = path.join(root, 'string_utils.py')
  const testFile = path.join(root, 'test_string_utils.py')
  const evidenceFile = path.resolve(__dirname, '../../.vscode-agent-dev/workbench-e2e-evidence.json')
  const devRoot = fs.realpathSync(path.resolve(__dirname, '../../.vscode-agent-dev'))
  if (path.dirname(fs.realpathSync(root)) !== devRoot) throw new Error('E2E requires an isolated direct child of .vscode-agent-dev')
  for (const name of ['string_utils.py', 'test_string_utils.py', '__pycache__', '.vscode']) fs.rmSync(path.join(root, name), { recursive: true, force: true })
  fs.mkdirSync(root, { recursive: true })
  const original = 'def reverse(text: str) -> str:\n    return text\n'
  fs.writeFileSync(fixture, original)
  fs.writeFileSync(testFile, `import unittest\nfrom string_utils import reverse\n\nclass TestStringBehaviors(unittest.TestCase):\n    def test_reverse_word(self):\n        self.assertEqual(reverse("abc"), "cba")\n\n    def test_reverse_preserves_spaces(self):\n        self.assertEqual(reverse("a b"), "b a")\n\nif __name__ == "__main__":\n    unittest.main()\n`)
  const python = args => execFileSync('python', args, { cwd: root, encoding: 'utf8', stdio: 'pipe' })
  try { python(['test_string_utils.py']); throw new Error('Fixture must begin with a real failing test') }
  catch (error) { assert.equal(error.status, 1); assert.match(error.stderr, /AssertionError/) }

  await vscode.extensions.getExtension('local.letscoding')?.activate()
  const config = vscode.workspace.getConfiguration('privateCodingAgent')
  await config.update('provider', 'deepseek-account', vscode.ConfigurationTarget.Workspace)
  await config.update('model', 'deepseek-flash', vscode.ConfigurationTarget.Workspace)
  const events = []
  const reports = []
  const tools = []
  const waitFor = async (predicate, label, timeout = 60_000) => {
    const started = Date.now()
    while (!predicate()) {
      if (Date.now() - started > timeout) throw new Error(`Timed out: ${label}`)
      await new Promise(resolve => setTimeout(resolve, 100))
    }
  }
  const agent = await vscode.commands.executeCommand('privateCodingAgent.debugController')
  const notify = agent.notify
  agent.notify = event => {
    notify.call(agent, event)
    events.push(event)
    if (event.type === 'verificationReport') { reports.push(event.report); console.log('REAL REPORT:', JSON.stringify(event.report)) }
    if (event.type === 'toolResult') { tools.push(event); console.log('REAL TOOL:', event.tool, event.error, String(event.text).slice(0, 800)) }
  }
  let evidence = { workspace: root, model: 'deepseek-account/deepseek-flash', assertions: [] }
  try {
    console.log('E2E phase 1: real failing test, no edits')
    await agent.run('请只运行 python test_string_utils.py 检查当前失败，不要修改任何文件。真实运行后再报告结果。')
    assert.equal(fs.readFileSync(fixture, 'utf8'), original, 'Read-only test task must not edit source')
    assert.ok(tools.some(event => event.tool === 'bash' && event.arguments?.includes('test_string_utils.py')), 'DSH must execute the real test command')
    assert.equal(reports.at(-1)?.status, 'failed')
    const failure = reports.at(-1)?.failures.find(item => !item.resolved && item.location?.path === 'test_string_utils.py')
    assert.ok(failure?.location?.line > 0, 'Real traceback must produce a source location')
    const rerunCommand = reports.at(-1).rerunCommand
    assert.match(rerunCommand, /^python -m unittest .*test_reverse_word/)
    console.log('Real failure, source location and targeted command verified')

    // Drive the real Webview DOM with the report emitted by AgentController.
    const { parseHTML, Event } = require('linkedom')
    const source = fs.readFileSync(path.resolve(__dirname, '../src/extension.ts'), 'utf8')
    const body = source.slice(source.indexOf('<body>'), source.indexOf('</body>') + 7).replace(/\$\{iconUri\}/g, 'agent.svg').replace(/\$\{scriptUri\}/g, 'webview.js')
    const { document } = parseHTML(`<!DOCTYPE html><html><head></head>${body}</html>`)
    document.defaultView.HTMLElement.prototype.scrollIntoView = () => {}
    const posted = []
    const dom = { document, window: document.defaultView, console, acquireVsCodeApi: () => ({ postMessage: message => posted.push(message) }), setTimeout, clearTimeout, Event }
    dom.globalThis = dom
    vm.createContext(dom)
    vm.runInContext(fs.readFileSync(path.resolve(__dirname, '../media/webview.js'), 'utf8'), dom)
    const message = new Event('message')
    message.data = { type: 'verificationReport', report: reports.at(-1) }
    document.defaultView.dispatchEvent(message)
    const locationButton = document.querySelector('.verification-failure button')
    locationButton.click()
    const location = posted.at(-1)
    assert.equal(location.type, 'openLocation')
    await vscode.commands.executeCommand('privateCodingAgent.openTestLocation', location.uri, location.line)
    assert.equal(vscode.window.activeTextEditor?.document.uri.fsPath, testFile)
    assert.equal(vscode.window.activeTextEditor?.selection.active.line, failure.location.line - 1)
    console.log('Report DOM click opened the real failing source line')
    document.querySelector('.rerun-tests').click()
    assert.equal(posted.at(-1).type, 'rerunTests')
    assert.equal(posted.at(-1).command, rerunCommand)
    assert.equal(document.querySelector('.rerun-tests').disabled, true)

    const reportCount = reports.length
    const terminalsBefore = vscode.window.terminals.length
    await vscode.commands.executeCommand('privateCodingAgent.rerunVerification', posted.at(-1).command)
    const terminal = vscode.window.terminals.at(-1)
    assert.equal(vscode.window.terminals.length, terminalsBefore + 1)
    assert.equal(terminal.name, 'Coding Agent 测试重跑')
    await waitFor(() => reports.length > reportCount, 'managed rerun terminal completion', 90_000)
    assert.equal(reports.at(-1).status, 'failed', 'Rerun without a repair must remain failed')
    assert.equal(reports.at(-1).runs.at(-1).exitCode, 1)
    assert.equal(reports.at(-1).failures.some(item => !item.resolved), true)
    assert.equal(reports.at(-1).failures.filter(item => !item.resolved).length, 2, 'Rerun must deduplicate __main__ and imported test names')
    console.log('Managed rerun executed, exit code 1 observed, failure not misreported as passed')
    evidence.failure = { location: failure.location, rerunCommand, rerunExitCode: reports.at(-1).runs.at(-1).exitCode, terminalRemainsOpenForInspection: terminal.exitStatus === undefined }
    evidence.assertions.push('real DSH Bash failure', 'source DOM navigation', 'managed targeted terminal rerun', 'failure remains failed')

    console.log('E2E phase 2: real model repair')
    const beforeRepairReports = reports.length
    await agent.run('请修复 string_utils.py 中的 reverse 函数，使其满足测试。只能修改 string_utils.py，不能修改测试文件；然后运行 python test_string_utils.py 验证。')
    const current = fs.readFileSync(fixture, 'utf8')
    assert.notEqual(current, original, 'Real model must change implementation')
    assert.match(current, /\[::?-1\]|reversed/, 'reverse must actually reverse text')
    assert.ok(fs.readFileSync(testFile, 'utf8').includes('reverse("abc")'), 'Test fixture must not be rewritten')
    python(['test_string_utils.py'])
    assert.equal(reports.at(-1).status, 'passed', 'Only actual passing test evidence may pass the report')
    assert.equal(reports.at(-1).failures.every(item => item.resolved), true)
    assert.equal(reports.at(-1).rerunCommand, undefined)
    assert.equal(reports.at(-1).files[0].path, 'string_utils.py')
    assert.ok(reports.length > beforeRepairReports)
    const history = await agent.sessionHistory(agent.persistedSessionId)
    const repair = history.events.findLast(event => event.type === 'user/message' && event.data.source.kind === 'user'
      && event.data.content?.some(block => block.type === 'text' && block.text?.includes('请修复 string_utils.py')))
    assert.ok(repair, 'Repair user event must be persisted in the real session')
    const store = agent.checkpoints
    const checkpoints = await store.list(agent.persistedSessionId)
    console.log('REAL REPAIR EVENT:', JSON.stringify(repair))
    console.log('REAL CHECKPOINTS:', JSON.stringify(checkpoints))
    const saved = checkpoints.find(item => item.userSeq === repair.seq)
    assert.ok(saved?.files.includes('string_utils.py'), 'Checkpoint must bind the real edit')
    const baseline = await store.baseline(agent.persistedSessionId, repair.seq, 'string_utils.py', root)
    assert.equal(baseline.toString('utf8'), original)
    const executeCommand = vscode.commands.executeCommand
    const commands = []
    vscode.commands.executeCommand = async (command, ...args) => {
      commands.push({ command, args })
      if (command === 'diffEditor.setViewMode.inline') return undefined
      return executeCommand(command, ...args)
    }
    message.data = { type: 'verificationReport', report: reports.at(-1) }
    document.defaultView.dispatchEvent(message)
    document.querySelector('#verification-report details button').click()
    const diffMessage = posted.at(-1)
    assert.equal(diffMessage.type, 'openDiff')
    assert.equal(diffMessage.path, 'string_utils.py')
    const currentSession = await agent.sessionHistory(agent.persistedSessionId)
    assert.ok(currentSession.session.id)
    try { await agent.openDiff(diffMessage.path, repair.seq) } finally { vscode.commands.executeCommand = executeCommand }
    const diff = commands.find(item => item.command === 'vscode.diff')
    assert.ok(diff, 'Report diff action must open native diff')
    assert.equal(diff.args[0].scheme, 'coding-agent-checkpoint')
    const providerBaseline = await agent.checkpointBaseline(agent.persistedSessionId, repair.seq, 'string_utils.py', root)
    assert.equal(providerBaseline.toString('utf8'), original)
    assert.ok(commands.some(item => item.command === 'diffEditor.setViewMode.inline'))
    await agent.refreshInlineDiff(vscode.Uri.file(fixture))
    evidence.repair = { source: current, sessionId: agent.persistedSessionId, repairSeq: repair.seq, checkpointId: saved.id, diffScheme: diff.args[0].scheme, report: reports.at(-1) }
    evidence.assertions.push('real model edit', 'actual passing Python tests', 'resolved report', 'checkpoint baseline', 'native inline diff')
    fs.writeFileSync(evidenceFile, JSON.stringify(evidence, null, 2))
    console.log('REAL DSH WORKBENCH END-TO-END ACCEPTANCE PASSED')
    console.log('Evidence:', evidenceFile)
  } catch (error) {
    evidence.error = String(error.stack ?? error)
    evidence.events = events
    fs.writeFileSync(evidenceFile, JSON.stringify(evidence, null, 2))
    throw error
  } finally {
    await agent.dispose()
    await config.update('provider', undefined, vscode.ConfigurationTarget.Workspace)
    await config.update('model', undefined, vscode.ConfigurationTarget.Workspace)
  }
}
module.exports = { run }
