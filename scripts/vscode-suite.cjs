const assert = require('node:assert/strict')

function visibleReply(events) {
  return events.filter(event => event.type === 'assistant' || event.type === 'assistantDelta')
    .map(event => event.text).join('')
}

async function run() {
  console.log('VS Code integration test starting')
  const vscode = require('vscode')
  const { createHarness, hostNetworkEnvironment, sameNetworkOptions } = await import('../out/runtime.js')
  const network = hostNetworkEnvironment({ HTTP_PROXY: 'http://127.0.0.1:1', HTTPS_PROXY: 'http://127.0.0.1:1', ALL_PROXY: 'socks://127.0.0.1:1' })
  for (const name of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy']) assert.equal(network[name], '')
  assert.equal(network.NODE_USE_ENV_PROXY, undefined)
  assert.equal(hostNetworkEnvironment({ HTTPS_PROXY: 'http://127.0.0.1:7890', NO_PROXY: 'localhost' }, 'system').HTTPS_PROXY, 'http://127.0.0.1:7890')
  assert.equal(hostNetworkEnvironment({}, 'proxy', 'http://127.0.0.1:7890').HTTPS_PROXY, 'http://127.0.0.1:7890/')
  assert.equal(hostNetworkEnvironment({}, 'proxy', 'http://127.0.0.1:7890').HTTP_PROXY, 'http://127.0.0.1:7890/')
  assert.throws(() => hostNetworkEnvironment({}, 'proxy', 'socks://127.0.0.1:7890'), /仅支持 HTTP/)
  assert.equal(sameNetworkOptions({}, { networkMode: 'direct' }), true)
  assert.equal(sameNetworkOptions({ networkMode: 'direct' }, { networkMode: 'system' }), false)
  assert.equal(sameNetworkOptions({ networkMode: 'proxy', proxyUrl: ' http://127.0.0.1:7890' }, { networkMode: 'proxy', proxyUrl: 'http://127.0.0.1:7890' }), true)
  console.log('Host network environment isolation and explicit proxy settings passed')
  const harness = createHarness({
    extensionRoot: require('node:path').resolve(__dirname, '..'),
    dshHome: process.env.DSH_AGENT_HOME,
    cwd: vscode.workspace.workspaceFolders[0].uri.fsPath,
    provider: 'deepseek-account',
    model: 'deepseek-flash',
  })
  try {
  console.log('Starting DSH under Electron', process.versions.electron)
  harness.client.start()
  harness.client.onRequest(async () => ({ outcome: 'rejected' }))
  await harness.start()
  console.log('DSH initialize succeeded')
  const result = await harness.run('Reply exactly: VS Code Electron Node OK. Do not use tools.')
  console.log('Model response:', result.finalResponse, result.finishReason)
  if (result.finishReason !== 'completed') throw new Error(JSON.stringify(result.events.at(-1)))
  await harness.close()
  const { AgentController } = await import('../out/agentController.js')
  const { sessionProjectKey } = await import('../out/agent.js')
  const { Uri } = vscode
  const testStorage = require('node:path').resolve(__dirname, `../../.vscode-agent-dev/test-storage-stage3-${Date.now()}`)
  const context = { extensionUri: Uri.file(require('node:path').resolve(__dirname, '..')), globalStorageUri: Uri.file(testStorage) }
  const events = []
  const state = new Map()
  context.workspaceState = {
    get: key => state.get(key),
    update: async (key, value) => { if (value === undefined) state.delete(key); else state.set(key, value) },
    keys: () => [...state.keys()],
  }
  let agent = new AgentController(context, event => { events.push(event); console.log('Agent UI event:', JSON.stringify(event).slice(0, 1500)) })
  const config = vscode.workspace.getConfiguration('privateCodingAgent')
  // A previous interrupted suite may have left this dedicated test workspace read-only.
  await context.workspaceState.update('permissionMode', 'workspace-write')
  await new Promise(resolve => setTimeout(resolve, 100))
  try {
    await agent.run('请记住暗号 MODEL_SWITCH_7391，只回复“已记住”，不要使用工具。')
    const streamedText = events.filter(event => event.type === 'assistantDelta').map(event => event.text).join('')
    if (events.filter(event => event.type === 'assistantDelta').length === 0) throw new Error('Live assistant deltas are missing')
    const streamHistory = await agent.sessionHistory(agent.persistedSessionId)
    const settled = streamHistory.events.findLast(event => event.type === 'assistant/message')
    const finalText = settled.data.message.content.filter(block => block.type === 'text').map(block => block.text).join('')
    if (streamedText !== finalText) throw new Error('Live stream differs from the settled response: ' + JSON.stringify({ streamedText, finalText }))
    const firstSession = agent.persistedSessionId
    await agent.resume()
    await config.update('provider', 'kimi-coding', vscode.ConfigurationTarget.Workspace)
    await config.update('model', 'k3.1-pro', vscode.ConfigurationTarget.Workspace)
    console.log('Controller before explicit model-switch run:', JSON.stringify({ firstSession, selectedId: agent.selectedId, selectedRuntime: agent.selected?.id, runtimeIds: [...agent.runtimes.keys()] }))
    await agent.run('只回复我之前给你的暗号，不要使用工具。', '只回复暗号', firstSession)
    const resumedReply = visibleReply(events) ?? ''
    if (!resumedReply.includes('MODEL_SWITCH_7391')) throw new Error('Model switch lost session history: ' + resumedReply)
    if (agent.persistedSessionId !== firstSession) throw new Error('Session changed after model switch')
    const routed = events.filter(event => event.type === 'modelRoute').at(-1)
    if (routed?.provider !== 'kimi-coding' || routed?.model !== 'k3.1-pro') {
      throw new Error('Resumed session did not use the selected Kimi route: ' + JSON.stringify(routed))
    }
    const { html } = await import('../out/extension.js')
    const markup = html({ cspSource: 'test', asWebviewUri: uri => uri.toString() }, Uri.file(require('node:path').resolve(__dirname, '..')))
    if (!markup.includes('id="model"')) throw new Error('Model dropdown missing from Webview')
    if (!markup.includes('#model { width: 150px; max-width: 150px; padding-right: 28px; text-overflow: ellipsis;')) {
      throw new Error('Model text must leave room for the dropdown arrow')
    }
    if (!markup.includes('#model optgroup { color:') || !markup.includes('var(--vscode-dropdown-background, var(--vscode-editorWidget-background, #252526))')) {
      throw new Error('Model provider groups need readable foreground and background colors')
    }
    if (markup.indexOf('</style>') !== markup.lastIndexOf('</style>')) throw new Error('Duplicate style blocks in Webview')
    const styleEnd = markup.indexOf('</style>')
    if (styleEnd < 0 || markup.slice(styleEnd + 8, markup.indexOf('</head>')).trim() !== '') {
      throw new Error('CSS leaked into visible Webview markup outside the style element')
    }
    if (markup.indexOf('<div id="composer-toolbar"') < markup.indexOf('<select id="permissionMode"')
      && markup.indexOf('<select id="permissionMode"') < markup.indexOf('<select id="model"')
      && markup.indexOf('<select id="model"') < markup.indexOf('<button id="send"')) {
      console.log('Webview markup contains no visible CSS; model is beside Send')
    } else throw new Error('Model selector must be immediately before Send in the composer toolbar')
    const catalog = await agent.modelCatalog()
    const expected = [{ provider: 'deepseek-account', model: 'deepseek-flash' }, { provider: 'kimi-coding', model: 'k3.1-pro' }]
    for (const route of expected) {
      if (!catalog.groups.some(group => group.id === route.provider && group.models.some(model => model.id === route.model))) {
        throw new Error('Configured model missing from SDK catalog: ' + JSON.stringify(catalog))
      }
    }
    if (!catalog.groups.some(group => group.id === 'kimi-coding' && group.models.length > 1)) throw new Error('Kimi catalog exposes only one model')
    console.log('SDK model catalog:', JSON.stringify(catalog))
    const webviewCatalog = await vscode.commands.executeCommand('privateCodingAgent.modelCatalog')
    if (!webviewCatalog.groups.some(group => group.id === 'kimi-coding' && group.models.length > 1)) {
      throw new Error('Actual Webview controller has no Kimi catalog: ' + JSON.stringify(webviewCatalog))
    }
  console.log('Actual Webview controller Kimi catalog passed')
  const secondHost = agent.selected?.harness
  await config.update('provider', 'deepseek-account', vscode.ConfigurationTarget.Workspace)
  await config.update('model', 'deepseek-flash', vscode.ConfigurationTarget.Workspace)
  await agent.run('只回复我之前给你的暗号，不要使用工具。', '再次核对暗号', firstSession)
  const liveHistory = await agent.sessionHistory(firstSession)
  const actualHeader = liveHistory.events.findLast(event => event.type === 'request/header')
  if (actualHeader?.data.header.config.provider !== 'deepseek-account' || actualHeader.data.header.config.model !== 'deepseek-flash') {
    throw new Error('Persisted request header does not match the selected DeepSeek route')
  }
  const liveRoute = events.filter(event => event.type === 'modelRoute').at(-1)
  if (liveRoute?.provider !== 'deepseek-account' || liveRoute?.model !== 'deepseek-flash') {
    throw new Error('Warm Session kept a stale model instead of the selected DeepSeek route: ' + JSON.stringify(liveRoute))
  }
  if (agent.selected?.harness !== secondHost) throw new Error('Model selection must not restart a warm Host')
  const secondReply = visibleReply(events) ?? ''
  if (!secondReply.includes('MODEL_SWITCH_7391')) throw new Error('Warm model switch lost session history: ' + secondReply)
  console.log('Warm Session switched provider/model in place using the actual request header')
  console.log('VS Code model selection, dropdown and resumed Kimi route passed')

    const { CheckpointStore, workspacePath } = await import('../out/checkpoints.js')
    const fs = require('node:fs')
    const path = require('node:path')
    const root = vscode.workspace.workspaceFolders[0].uri.fsPath
    const rollbackFile = path.join(root, 'checkpoint-live.txt')
    fs.writeFileSync(rollbackFile, 'BASE\n')
    await agent.run('请用工具把 checkpoint-live.txt 的全部内容改为 FIRST。不要使用 Bash；只回复已修改。')
    const firstHistory = await agent.sessionHistory(agent.persistedSessionId)
    console.log('[Checkpoint Test] Live Session:', agent.persistedSessionId, firstHistory.events.map(event => ({ seq: event.seq, type: event.type })))
    const firstUser = firstHistory.events.find(event => event.type === 'user/message' && event.data.source.kind === 'user'
      && JSON.stringify(event.data.content).includes('改为 FIRST'))
    if (!firstUser || fs.readFileSync(rollbackFile, 'utf8').trim() !== 'FIRST') throw new Error('First file checkpoint turn failed')
    await agent.run('请用工具把 checkpoint-live.txt 的全部内容改为 SECOND。不要使用 Bash；只回复已修改。')
    if (fs.readFileSync(rollbackFile, 'utf8').trim() !== 'SECOND') throw new Error('Second file checkpoint turn failed')
    const parentSession = agent.persistedSessionId
    const sessionsBeforeResend = (await agent.listSessions()).sessions.map(session => session.id).sort()
    const liveStore = new CheckpointStore(path.join(context.globalStorageUri.fsPath, 'checkpoints', encodeURIComponent(root)))
    const savedLive = (await liveStore.list(parentSession)).find(item => item.userSeq === firstUser.seq)
    if (!savedLive || savedLive.files.length !== 1 || savedLive.files[0] !== 'checkpoint-live.txt') throw new Error('Tool call did not bind original file to the checkpoint: ' + JSON.stringify(savedLive))
    await agent.resendFromHistory(firstUser.seq, '请用工具把 checkpoint-live.txt 的全部内容改为 REBUILT。不要使用 Bash；只回复已修改。', '历史重发', { provider: 'kimi-coding', model: 'k3.1-pro' })
    const resendHeader = (await agent.sessionHistory(parentSession)).events.findLast(event => event.type === 'request/header')
    if (resendHeader?.data.header.config.provider !== 'kimi-coding' || resendHeader.data.header.config.model !== 'k3.1-pro') {
      throw new Error('History resend did not honor its explicit model route: ' + JSON.stringify(resendHeader))
    }
    if (fs.readFileSync(rollbackFile, 'utf8').trim() !== 'REBUILT') throw new Error('Historical in-place code restore failed: ' + fs.readFileSync(rollbackFile, 'utf8'))
    if (agent.persistedSessionId !== parentSession) throw new Error('History resend must retain the current Session')
    const sessionsAfterResend = (await agent.listSessions()).sessions.map(session => session.id).sort()
    assert.deepEqual(sessionsAfterResend, sessionsBeforeResend, 'History resend must not create a child Session or list entry')
    if (!events.some(event => event.type === 'toolResult'
      && typeof event.text === 'string' && event.text.includes('1: BASE'))) {
      throw new Error('History resend did not expose the restored pre-turn BASE to the Agent')
    }
    const rewoundHistory = await agent.sessionHistory(parentSession)
    if (rewoundHistory.events.some(event => event.type === 'user/message' && JSON.stringify(event.data.content).includes('改为 SECOND'))
      || rewoundHistory.events.some(event => event.type === 'tool/call' && JSON.stringify(event.data.arguments).includes('SECOND'))) {
      throw new Error('In-place rewind retained the discarded later turn')
    }
    if (!rewoundHistory.events.some(event => event.type === 'user/message' && JSON.stringify(event.data.content).includes('改为 REBUILT'))) {
      throw new Error('In-place resend did not append to the original Session')
    }
    await agent.undoRestore()
    if (fs.readFileSync(rollbackFile, 'utf8').trim() !== 'SECOND') throw new Error('Undo restore did not restore pre-rewind file')
    const running = agent.run('请调用 Bash 执行 sleep 20，等待工具结束后再回复。')
    for (let attempt = 0; attempt < 100 && !events.some(event => event.type === 'tool' && event.tool === 'bash'); attempt++) await new Promise(resolve => setTimeout(resolve, 100))
    if (!events.some(event => event.type === 'tool' && event.tool === 'bash')) throw new Error('Stop test did not reach the Bash tool')
    const stopStarted = Date.now()
    await agent.stop()
    if (Date.now() - stopStarted > 8000) throw new Error('Stop did not promptly interrupt the running turn')
    await running
    console.log('Real stop terminates the running Host promptly')
    console.log('Real multi-turn file rollback, in-place Session rewind, identity retention and undo passed')
    await agent.newSession()
    await agent.run('请记住独立暗号 SESSION_HISTORY_5824，只回复“第二个会话已记住”，不要使用工具。')
    const secondSession = agent.persistedSessionId
    if (!secondSession || secondSession === firstSession) throw new Error('New session reused previous identity')
    const listed = await agent.listSessions()
    for (const id of [firstSession, secondSession]) {
      if (!listed.sessions.some(session => session.id === id)) throw new Error('Session missing from workspace history: ' + id)
    }
    if (listed.sessions.some(session => session.cwd !== vscode.workspace.workspaceFolders[0].uri.fsPath)) {
      throw new Error('History leaked a different workspace')
    }
    await agent.selectSession(firstSession)
    const restored = events.slice(events.findIndex(event => event.type === 'sessionSelected'))
    if (!restored.some(event => event.type === 'user' && event.text.includes('MODEL_SWITCH_7391'))
      || !restored.some(event => event.type === 'assistant' && event.text.includes('MODEL_SWITCH_7391'))) {
      throw new Error('Historical messages were not restored: ' + JSON.stringify(restored))
    }
    if (!markup.includes('id="session-select"')) throw new Error('Session history dropdown missing from Webview')
    await agent.run('只回复这个会话最初给你的暗号，不要使用工具。')
    const continued = visibleReply(events) ?? ''
    if (!continued.includes('MODEL_SWITCH_7391')) throw new Error('History selection did not continue original Session: ' + continued)
    if (agent.persistedSessionId !== firstSession) throw new Error('History continuation changed Session identity')
    console.log('Workspace history list, message replay, selection and continuation passed')

    const backgroundRun = agent.run('请调用 Bash 执行 sleep 12，等待工具结束后再回复。', '后台会话任务', firstSession)
    for (let attempt = 0; attempt < 100 && !agent.runtimes.get(firstSession)?.busy; attempt++) await new Promise(resolve => setTimeout(resolve, 50))
    if (!agent.busy) throw new Error('Background Session did not start independently')
    const backgroundHost = agent.runtimes.get(firstSession).harness
    const readHost = agent.readHost
    agent.newSession()
    if (agent.persistedSessionId !== undefined || agent.busy) throw new Error('New Session is blocked by a running Session')
    await agent.selectSession(secondSession)
    if (agent.busy) throw new Error('Background busy state leaked into the selected Session')
    await agent.selectSession(firstSession)
    if (!agent.busy || agent.runtimes.get(firstSession).harness !== backgroundHost || agent.readHost !== readHost) {
      throw new Error('Warm Session switching restarted a Host or discarded the read Host')
    }
    await agent.stop(firstSession)
    await backgroundRun
    if (agent.runtimes.get(firstSession).harness !== undefined) throw new Error('Stopped background Host was not released')
    await config.update('provider', 'deepseek-account', vscode.ConfigurationTarget.Workspace)
    await config.update('model', 'deepseek-flash', vscode.ConfigurationTarget.Workspace)
    console.log('Running background Session, immediate New/switch, Host reuse and routed stop passed')

    // Recreate the view/controller without changing the ExtensionContext Memento.
    await agent.dispose()
    events.length = 0
    agent = new AgentController(context, event => { events.push(event); console.log('Restored UI event:', JSON.stringify(event).slice(0, 1500)) })
    await agent.restoreSelection()
    if (agent.persistedSessionId !== firstSession) throw new Error('Panel recreation lost the selected Session')
    if (!events.some(event => event.type === 'user' && event.text.includes('MODEL_SWITCH_7391'))
      || !events.some(event => event.type === 'assistant' && event.text.includes('MODEL_SWITCH_7391'))) {
      throw new Error('Panel recreation did not replay persisted messages')
    }
    await agent.run('再次只回复本会话最初的暗号，不要使用工具。')
    const afterPanelRestore = visibleReply(events) ?? ''
    if (!afterPanelRestore.includes('MODEL_SWITCH_7391')) throw new Error('Restored panel lost Session memory: ' + afterPanelRestore)
    // The checkpoint content provider is bound to the extension's own controller, not the suite's
    // instance. Verify the same session/workspace ownership via this controller's baseline API.
    const baseline = await agent.checkpointBaseline(agent.persistedSessionId, firstUser.seq, 'checkpoint-live.txt', root)
    if (baseline.toString('utf8') !== 'BASE\n') throw new Error('Checkpoint read-only baseline failed: ' + baseline.toString('utf8'))
    const executed = []
    const executeCommand = vscode.commands.executeCommand
    vscode.commands.executeCommand = async (command, ...args) => {
      executed.push(command)
      if (command === 'diffEditor.setViewMode.inline') return undefined
      return executeCommand(command, ...args)
    }
    try { await agent.openDiff('checkpoint-live.txt', firstUser.seq) } finally { vscode.commands.executeCommand = executeCommand }
    assert.ok(executed.includes('vscode.diff'))
    assert.ok(executed.includes('diffEditor.setViewMode.inline'), 'Full review must use stable native inline diff layout')
    console.log('Checkpoint baseline read-only URI and native inline review passed')
    // A stale inline-diff hover link keeps the session that produced it. Opening it after
    // switching sessions must still resolve that session's snapshot, not the live one.
    await agent.selectSession(secondSession)
    const staleBaseline = await agent.checkpointBaseline(firstSession, firstUser.seq, 'checkpoint-live.txt', root)
    if (staleBaseline.toString('utf8') !== 'BASE\n') throw new Error('Stale-session baseline was rejected after session switch')
    const staleCommands = []
    vscode.commands.executeCommand = async (command, ...args) => {
      staleCommands.push(command)
      if (command === 'diffEditor.setViewMode.inline') return undefined
      return executeCommand(command, ...args)
    }
    try { await agent.openDiff('checkpoint-live.txt', firstUser.seq, firstSession) } finally { vscode.commands.executeCommand = executeCommand }
    assert.ok(staleCommands.includes('vscode.diff'), 'Stale-session inline diff must still open')
    await agent.selectSession(firstSession)
    console.log('Stale inline-diff link keeps its originating session after switching')
    console.log('Webview recreation, persisted selection and memory continuation passed')

    await agent.deleteSession(secondSession)
    await assert.rejects(agent.selectSession(secondSession), /会话已删除/)
    if (agent.persistedSessionId !== firstSession) throw new Error('Deleting background Session changed current Session')
    await agent.deleteSession(firstSession)
    if (agent.persistedSessionId !== undefined) throw new Error('Deleting current Session did not reset the controller')
    if (context.workspaceState.get('currentSession:' + root) !== undefined) throw new Error('Deleted current Session remains in Memento')
    await assert.rejects(agent.sessionHistory(firstSession), /does not belong|not found/)
    if (!events.some(event => event.type === 'cleared')) throw new Error('Deleting current Session did not clear the Webview')
    const sessionRoot = path.join(process.env.DSH_AGENT_HOME, 'sessions')
    for (const id of [firstSession, secondSession]) {
      const removed = (await agent.listSessions()).sessions.every(session => session.id !== id)
      if (!removed) throw new Error('Deleted Session returned to DSH history: ' + id)
      if (fs.existsSync(path.join(sessionRoot, sessionProjectKey(fs.realpathSync(root)), id))) throw new Error('Session JSONL directory was not removed: ' + id)
      if (fs.existsSync(path.join(process.env.DSH_AGENT_HOME, 'storages/session_projcache/sessions', id + '.json'))) throw new Error('Session projection cache was not removed: ' + id)
    }
    if (!fs.existsSync(sessionRoot)) throw new Error('Session root was removed instead of one Session')
    await assert.rejects(agent.selectSession('session-that-does-not-exist'), /does not belong|not found/)
    agent.newSession()
    const afterFailedSelection = agent.run('只回复 FRESH_DRAFT，不要使用工具。')
    for (let attempt = 0; attempt < 2000 && !events.some(event => event.type === 'user' && event.text === '只回复 FRESH_DRAFT，不要使用工具。'); attempt++) {
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    await afterFailedSelection
    console.log('Real DSH background/current Session deletion and boundary protection passed')

    const { captureEditorContext, promptWithEditorContext, contextLabel, openEditorReference } = await import('../out/context.js')
    const contextPath = path.join(root, 'context-fixture.js')
    const contextSource = 'let first = 1\nlet second = 2\nlet selectedMarker = "EDITOR_CONTEXT_8417"\n'
    fs.writeFileSync(contextPath, contextSource)
    const document = await vscode.workspace.openTextDocument(contextPath)
    const editor = await vscode.window.showTextDocument(document)
    editor.selection = new vscode.Selection(1, 0, 2, 42)
    let editorContext = captureEditorContext(editor)
    if (editorContext?.path !== 'context-fixture.js' || editorContext.selection?.startLine !== 2 || editorContext.selection.endLine !== 3) {
      throw new Error('Editor selection coordinates are incorrect: ' + JSON.stringify(editorContext))
    }
    const selectedPrompt = promptWithEditorContext('请解释选区', editorContext)
    if (!selectedPrompt.includes('EDITOR_CONTEXT_8417') || !selectedPrompt.includes('context-fixture.js')
      || !selectedPrompt.includes('第 2–3 行') || !selectedPrompt.endsWith('</editor-context>')) {
      throw new Error('Selected code was not attached correctly: ' + selectedPrompt)
    }
    if (contextLabel(editorContext) !== 'context-fixture.js:2–3') throw new Error('Context label is incorrect: ' + contextLabel(editorContext))
    const selectedSnapshot = editorContext
    editor.selection = new vscode.Selection(0, 3, 0, 3)
    editorContext = captureEditorContext(editor)
    const cursorOnlyPrompt = promptWithEditorContext('只使用位置', editorContext)
    if (editorContext.cursorLine !== 1 || cursorOnlyPrompt.includes('let first')
      || !cursorOnlyPrompt.includes('第 1 行，第 4 列') || !cursorOnlyPrompt.includes('用户未选择代码')) {
      throw new Error('Cursor-only context leaked file text: ' + cursorOnlyPrompt)
    }
    const external = await vscode.workspace.openTextDocument({ content: 'PRIVATE_OUTSIDE_WORKSPACE', language: 'plaintext' })
    await vscode.window.showTextDocument(external)
    if (captureEditorContext() !== undefined) throw new Error('Untitled editor content must not be attached')
    await openEditorReference({ uri: document.uri.toString(), line: 3 })
    if (vscode.window.activeTextEditor?.document.uri.toString() !== document.uri.toString()
      || vscode.window.activeTextEditor.selection.active.line !== 2) {
      throw new Error('File reference did not navigate to the requested line')
    }
    await openEditorReference({ uri: 'file:///etc/passwd', line: 1 })
    if (vscode.window.activeTextEditor?.document.uri.toString() !== document.uri.toString()) throw new Error('External reference was opened')
    console.log('Editor file, selection, cursor-only privacy and line navigation passed')
    agent.editorContext = selectedSnapshot
    await agent.run(promptWithEditorContext('上下文去重测试', selectedSnapshot), '上下文去重测试')
    const displayedUserMessages = events.filter(event => event.type === 'user' && event.text === '上下文去重测试')
    if (displayedUserMessages.length !== 1) throw new Error('One prompt must render one user event: ' + JSON.stringify(displayedUserMessages))
    if (displayedUserMessages[0].context?.label !== 'context-fixture.js:2–3' || displayedUserMessages[0].context.line !== 2) {
      throw new Error('User message did not retain the captured context label: ' + JSON.stringify(displayedUserMessages[0]))
    }
    agent.target().replayHistory({ session: { id: agent.persistedSessionId, cwd: root, title: 'Context test' }, events: [{ type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: selectedPrompt }] } }] })
    const replayed = events.filter(event => event.type === 'user' && event.text === '请解释选区')
    if (replayed.length !== 1 || replayed[0].context?.label !== 'context-fixture.js:2–3') {
      throw new Error('History did not restore the exact selected range: ' + JSON.stringify(replayed))
    }
    console.log('Single user echo and selected-range history rendering passed')
    const { workspaceFiles, promptWithFileReferences } = await import('../out/context.js')
    fs.writeFileSync(path.join(root, 'package.json'), '{"name":"context-test"}\n')
    fs.mkdirSync(path.join(root, 'node_modules', 'hidden'), { recursive: true })
    fs.writeFileSync(path.join(root, 'node_modules', 'hidden', 'secret.js'), 'NOT_INDEXED')
    fs.mkdirSync(path.join(root, '__pycache__'), { recursive: true })
    fs.writeFileSync(path.join(root, '__pycache__', 'context-fixture.cpython-312.pyc'), 'BINARY')
    fs.writeFileSync(path.join(root, 'context-fixture.pyc'), 'BINARY')
    fs.writeFileSync(path.join(root, 'context-notes.md'), '# Searchable notes\n')
    const files = await workspaceFiles()
    if (!files.some(file => file.path === 'context-fixture.js') || !files.some(file => file.path === 'context-notes.md')
      || files.some(file => file.path.includes('node_modules') || file.path.endsWith('.pyc'))) {
      throw new Error('Workspace file index is incomplete or includes generated/binary files: ' + JSON.stringify(files))
    }
    const reference = files.find(file => file.path === 'context-fixture.js')
    const withFile = await promptWithFileReferences('请分析 @context-fixture.js', [reference])
    if (!withFile.includes('EDITOR_CONTEXT_8417') || !withFile.includes('<referenced-file>')) throw new Error('Explicit file content was not attached')
    agent.target().replayHistory({ session: { id: agent.persistedSessionId, cwd: root, title: 'Context test' }, events: [{ type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: promptWithEditorContext(withFile, selectedSnapshot) }] } }] })
    const fileHistory = events.filter(event => event.type === 'user').at(-1)
    assert.equal(fileHistory?.text, '请分析 @context-fixture.js', 'History must show only the typed prompt, not referenced file contents')
    assert.equal(fileHistory?.context?.label, 'context-fixture.js:2–3')
    if (await promptWithFileReferences('请分析普通文本', [reference]) !== '请分析普通文本') throw new Error('Unmentioned file was attached')
    const externalReference = { path: 'context-fixture.js', uri: 'file:///etc/passwd' }
    if (await promptWithFileReferences('请分析 @context-fixture.js', [externalReference]) === withFile) throw new Error('External reference was attached')
    const mismatchedReference = { path: 'context-fixture.js', uri: Uri.file(path.join(root, 'calculator.js')).toString() }
    if (await promptWithFileReferences('请分析 @context-fixture.js', [mismatchedReference]) === withFile) {
      throw new Error('Mismatched path and URI must not be trusted as an explicit reference')
    }
    fs.rmSync(path.join(root, 'package.json'), { force: true })
    fs.rmSync(path.join(root, 'node_modules'), { recursive: true, force: true })
    fs.rmSync(path.join(root, '__pycache__'), { recursive: true, force: true })
    fs.rmSync(path.join(root, 'context-fixture.pyc'), { force: true })
    fs.rmSync(path.join(root, 'context-notes.md'), { force: true })
    fs.rmSync(contextPath, { force: true })
    console.log('@ file index, explicit content and path security passed')
    const { hostError, toolError, testSummary } = await import('../out/diagnostics.js')
    if (!hostError(new Error('MISSING_CREDENTIAL: api key absent')).includes('[模型]')) throw new Error('Credential errors were not classified')
    if (!toolError('[sandbox: file access denied under workspace-write mode]').includes('[工具/沙箱]')) throw new Error('Sandbox errors were not classified')
    const failedTest = testSummary('npm test', '# pass 3\n# fail 1\n# tests 4\n[exit code: 1]')
    const passedTest = testSummary('npm test', '# pass 4\n# fail 0\n# tests 4\n[exit code: 0]')
    const livePassedTest = testSummary('npm test', 'ℹ tests 1\nℹ pass 1\nℹ fail 0\n[stderr]\nnpm warn configuration')
    if (livePassedTest?.status !== 'passed' || testSummary('npm test', 'ℹ tests 1\nℹ pass 0\nℹ fail 1', false)?.status !== 'failed') {
      throw new Error('Real DSH test output was not classified correctly')
    }
    if (failedTest?.status !== 'failed' || failedTest.exitCode !== 1 || !failedTest.label?.includes('3 通过，1 失败')) throw new Error('Failed tests were not summarized: ' + JSON.stringify(failedTest))
    const passedUnittest = testSummary('python test_string_utils.py', 'Ran 11 tests in 0.001s\n\nOK')
    if (passedUnittest?.label !== '测试通过 · Python unittest 11 项，全部通过' || passedUnittest.details !== '退出码：本次工具结果未提供') throw new Error('Unittest success presentation is unclear: ' + JSON.stringify(passedUnittest))
    if (passedTest?.status !== 'passed' || testSummary('ls', '[exit code: 1]') !== undefined) throw new Error('Ordinary commands must not be treated as passing tests')
    const unittestOutput = `FAIL: test_truncate (test_string_utils.TestStringBehaviors.test_truncate)\n----------------------------------------------------------------------\nTraceback (most recent call last):\n  File "/workspace/test_string_utils.py", line 12, in test_truncate\n    self.assertEqual(truncate('abc', 2), 'a…')\nAssertionError: 'ab…' != 'a…'\n----------------------------------------------------------------------\nRan 1 test in 0.001s\nFAILED (failures=1)`
    const unittest = testSummary('python test_string_utils.py', unittestOutput, true)
    if (unittest?.status !== 'failed' || unittest.failures[0]?.line !== 12 || unittest.rerunCommand !== "python -m unittest 'test_string_utils.TestStringBehaviors.test_truncate'") throw new Error('Unittest failure discovery failed: ' + JSON.stringify(unittest))
    const { VerificationTracker } = await import('../out/verification.js')
    const verification = new VerificationTracker('/workspace')
    verification.record('/workspace', 'python test_string_utils.py', unittestOutput, true)
    if (verification.report(['/workspace/test_string_utils.py']).failures[0].location?.line !== 12) throw new Error('Failure source location missing')
    verification.record('/workspace', unittest.rerunCommand, 'Ran 1 test\nOK', false)
    if (verification.report([]).status !== 'passed' || verification.report([]).failures[0].resolved !== true) throw new Error('Successful targeted rerun did not resolve the failure')
    console.log('Credential, sandbox, failure discovery and targeted rerun diagnostics passed')
    agent.target().inspectNotification({ method: 'session.event', params: { sessionId: 'test', event: {
      type: 'tool/call', data: { callId: 'test-call', name: 'bash', arguments: JSON.stringify({ command: 'npm test' }) },
    } } })
    const testToolResult = {
      type: 'tool-result', toolCallId: 'test-call',
      content: [{ type: 'text', text: '# pass 3\n# fail 1\n# tests 4\n[exit code: 1]' }],
    }
    agent.target().inspectNotification({ method: 'session.event', params: { sessionId: 'test', event: {
      type: 'tool/result', data: { message: { source: { callId: 'test-call' }, content: [testToolResult] } },
    } } })
    const testEvent = events.filter(event => event.type === 'testResult').at(-1)
    if (testEvent?.status !== 'failed' || testEvent.exitCode !== 1) throw new Error('Test result was not emitted through the controller')
    agent.target().inspectNotification({ method: 'session.event', params: { sessionId: 'test', event: {
      type: 'tool/call', data: { callId: 'denied-call', name: 'edit', arguments: JSON.stringify({ file_path: 'context-fixture.js' }) },
    } } })
    agent.target().inspectNotification({ method: 'session.event', params: { sessionId: 'test', event: {
      type: 'tool/result', data: { message: { source: { callId: 'denied-call' }, isError: true, content: [{ type: 'text', text: '[sandbox: file access denied]' }] } },
    } } })
    const deniedEvent = events.filter(event => event.type === 'toolResult' && event.callId === 'denied-call').at(-1)
    if (!deniedEvent?.error || !deniedEvent.text.includes('[工具/沙箱]')) throw new Error('Tool message isError was not classified as a failure')
    agent.target().inspectNotification({ method: 'session.event', params: { sessionId: 'test', event: {
      type: 'tool/call', data: { callId: 'live-test-call', name: 'bash', arguments: JSON.stringify({ command: 'npm test' }) },
    } } })
    agent.target().inspectNotification({ method: 'session.event', params: { sessionId: 'test', event: {
      type: 'tool/result', data: { message: { source: { callId: 'live-test-call' }, isError: false, content: [{ type: 'text', text: 'ℹ tests 1\nℹ pass 1\nℹ fail 0' }] } },
    } } })
    if (events.filter(event => event.type === 'testResult').at(-1)?.status !== 'passed') throw new Error('Actual Bash text event did not yield a passing summary')
    const initialPermission = agent.target().sessionState?.get('permissionMode') ?? 'workspace-write'
    const permissionTarget = agent.target()
    permissionTarget.pendingTools = new Map([['busy', { name: 'bash', arguments: '{}' }]])
    permissionTarget.busy = true
    if (await agent.setPermissionMode('read-only') !== false || agent.target().sessionState?.get('permissionMode') === 'read-only') {
      throw new Error('Permission mode changed while a turn was running')
    }
    permissionTarget.busy = false
    permissionTarget.pendingTools.clear()
    if (await agent.setPermissionMode('read-only') !== true) throw new Error('Permission mode update was rejected while idle')
    await new Promise(resolve => setTimeout(resolve, 100))
    if (agent.target().sessionState?.get('permissionMode') !== 'read-only') {
      throw new Error('Permission mode did not persist while idle')
    }
    await agent.target().sessionState?.update('permissionMode', initialPermission)
    await new Promise(resolve => setTimeout(resolve, 50))
    await agent.setPermissionMode('read-only')
    await new Promise(resolve => setTimeout(resolve, 50))
    await agent.run('请记住权限切换暗号 PERMISSION_RESTART_8142，只回复“已记住”，不要使用工具。')
    if (!events.some(event => event.type === 'config' && event.permissionMode === 'read-only')) {
      throw new Error('Read-only Host did not start after the permission switch')
    }
    await agent.setPermissionMode('workspace-write')
    await new Promise(resolve => setTimeout(resolve, 50))
    await agent.run('只回复权限切换暗号，不要使用工具。')
    if (!visibleReply(events).includes('PERMISSION_RESTART_8142')) {
      throw new Error('Permission Host boundary lost the existing Session')
    }
    console.log('Live tool error, passing summary and permission boundaries passed')
    console.log('Tool-to-test-result event rendering passed')
    const { EditConflictMonitor, onEditConflict } = await import('../out/conflicts.js')
    const conflictPath = path.join(root, 'conflict-fixture.js')
    fs.writeFileSync(conflictPath, 'const initial = true\n')
    const conflictDocument = await vscode.workspace.openTextDocument(conflictPath)
    const conflictEditor = await vscode.window.showTextDocument(conflictDocument)
    const conflictMonitor = new EditConflictMonitor()
    conflictMonitor.snapshot(root)
    await conflictEditor.edit(edit => edit.insert(new vscode.Position(0, 0), '// UNSAVED_USER_EDIT\n'))
    let conflictNotified = false
    const conflictListener = onEditConflict(({ path: file, text }) => {
      if (file === 'conflict-fixture.js' && text.includes('未保存')) conflictNotified = true
    })
    try {
      await conflictMonitor.watch(root, 'edit', JSON.stringify({ file_path: 'conflict-fixture.js', old_string: 'const', new_string: 'let' }))
      if (!conflictNotified) throw new Error('Unsaved editor changes did not produce a conflict warning')
    } finally {
      conflictListener.dispose()
      await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor')
      fs.rmSync(conflictPath, { force: true })
    }
    console.log('Unsaved editor conflict detection passed')
    const store = new CheckpointStore(path.join(context.globalStorageUri.fsPath, 'checkpoint-unit'))
    const checkpointFile = path.join(root, 'checkpoint-file.txt')
    const secondFile = path.join(root, 'checkpoint-second.txt')
    const deletedFile = path.join(root, 'checkpoint-deleted.txt')
    const newFile = path.join(root, 'checkpoint-new.txt')
    // Clean up leftovers from previous test runs
    for (const file of [checkpointFile, secondFile, deletedFile, newFile]) fs.rmSync(file, { force: true })
    await store.before('checkpoint-session', root, 7, 'change the fixture')
    fs.writeFileSync(checkpointFile, 'ORIGINAL\n')
    fs.writeFileSync(secondFile, 'SECOND ORIGINAL\n')
    fs.writeFileSync(deletedFile, 'DELETED ORIGINAL\n')
    await store.track('checkpoint-session', root, checkpointFile)
    fs.writeFileSync(checkpointFile, 'FIRST CHANGE\n')
    await store.track('checkpoint-session', root, secondFile)
    await store.track('checkpoint-session', root, deletedFile)
    fs.writeFileSync(secondFile, 'SECOND CHANGE\n')
    fs.rmSync(deletedFile)
    await assert.rejects(store.track('checkpoint-session', root, path.join(root, '.env')), /敏感文件/)
    await store.track('checkpoint-session', root, checkpointFile)
    fs.writeFileSync(checkpointFile, 'SECOND CHANGE\n')
    await store.track('checkpoint-session', root, newFile)
    fs.writeFileSync(newFile, 'AGENT CREATED\n')
    const [saved] = await store.list('checkpoint-session')
    fs.writeFileSync(checkpointFile, 'LATER USER EDIT\n')
    await store.backupForUndo('child-session', root, saved.files)
    await store.restore(root, saved.id)
    assert.equal(fs.readFileSync(checkpointFile, 'utf8'), 'ORIGINAL\n')
    assert.equal(fs.readFileSync(secondFile, 'utf8'), 'SECOND ORIGINAL\n')
    assert.equal(fs.readFileSync(deletedFile, 'utf8'), 'DELETED ORIGINAL\n')
    assert.ok(!fs.existsSync(newFile), 'Restoring must remove files created by the Agent')
    await store.undo(root, 'child-session')
    assert.equal(fs.readFileSync(checkpointFile, 'utf8'), 'LATER USER EDIT\n')
    assert.equal(fs.readFileSync(newFile, 'utf8'), 'AGENT CREATED\n', 'Undo preserves the state immediately before restore')
    assert.throws(() => workspacePath(root, '../outside.txt'))
    await store.after('checkpoint-session', 1)
    const reloaded = new CheckpointStore(path.join(context.globalStorageUri.fsPath, 'checkpoint-unit'))
    assert.equal((await reloaded.list('checkpoint-session'))[0].turn, 1)
    await reloaded.rebindSession('checkpoint-session', 'forked-session', 8)
    const inherited = (await reloaded.list('forked-session'))[0]
    assert.equal(inherited.id, saved.id)
    assert.equal((await reloaded.list('checkpoint-session')).length, 1)
    fs.writeFileSync(checkpointFile, 'FORK BRANCH MODIFIED\n')
    await store.restore(root, inherited.id)
    assert.equal(fs.readFileSync(checkpointFile, 'utf8'), 'ORIGINAL\n')
    console.log('Incremental checkpoint, new file, undo, persistence and path boundary passed')
  } finally {
    await agent.dispose()
    await config.update('provider', undefined, vscode.ConfigurationTarget.Workspace)
    await config.update('model', undefined, vscode.ConfigurationTarget.Workspace)
    await context.workspaceState.update('permissionMode', undefined)
  }
  } finally { await harness.close().catch(() => {}) }
  console.log('VS Code DSH integration passed')
}
module.exports = { run }
