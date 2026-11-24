const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

function inventory(directory, prefix = '') {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const absolute = path.join(directory, entry.name)
    const relative = path.posix.join(prefix, entry.name)
    const stat = fs.lstatSync(absolute)
    assert.ok(!stat.isSymbolicLink(), `Installed symbolic link: ${relative}`)
    return stat.isDirectory() ? inventory(absolute, relative)
      : [{ path: relative, bytes: stat.size, mode: stat.mode & 0o777 }]
  })
}

function userMessage(history, marker) {
  return history.events.find(event => event.type === 'user/message' && event.data.source.kind === 'user'
    && JSON.stringify(event.data.content).includes(marker))
}

async function modelAcceptance(agent, extensionRoot, workspace, checks, events) {
  const vscode = require('vscode')
  const target = path.join(workspace, 'acceptance.txt')
  fs.writeFileSync(target, 'BASE\n')
  await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(target))
  await agent.run('请记住安装验收暗号 VSIX_ACCEPT_6721，只回复已记住，不要使用工具。')
  const first = agent.persistedSessionId
  assert.ok(first)
  assert.ok(events.filter(event => event.sessionId === first && event.type === 'assistantDelta').length > 0, `真实流式输出缺失：${JSON.stringify(events.map(event => event.type === 'error' ? { type: event.type, text: String(event.text).replace(/(session-|sk-|token-|Bearer\s+)[A-Za-z0-9_-]+/gi, '$1<redacted>') } : event.type))}`)
  checks.push('model turn and streaming')
  await agent.run('请把 acceptance.txt 的全部内容改为 FIRST。不要使用 Bash；只回复已修改。')
  assert.equal(fs.readFileSync(target, 'utf8').trim(), 'FIRST')
  const firstSeq = events.findLast(event => event.type === 'messageSeq' && event.sessionId === first)?.seq
  assert.ok(Number.isSafeInteger(firstSeq), '用户消息未绑定持久化序号')
  const firstUser = userMessage(await agent.sessionHistory(first), '改为 FIRST')
  assert.ok(firstUser)
  assert.equal(firstUser.seq, firstSeq)
  await agent.run('请把 acceptance.txt 的全部内容改为 SECOND。不要使用 Bash；只回复已修改。')
  assert.equal(fs.readFileSync(target, 'utf8').trim(), 'SECOND')
  const baseline = await agent.checkpointBaseline(first, firstUser.seq, 'acceptance.txt', workspace)
  assert.equal(baseline.toString('utf8'), 'BASE\n')
  await agent.openDiff('acceptance.txt', firstUser.seq)
  const deadline = Date.now() + 10_000
  while (!vscode.window.visibleTextEditors.some(editor => editor.document.uri.scheme === 'coding-agent-checkpoint') && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 25))
  const beforeEditor = vscode.window.visibleTextEditors.find(editor => editor.document.uri.scheme === 'coding-agent-checkpoint')
  assert.ok(beforeEditor, 'VS Code 未打开检查点 Diff')
  assert.equal(beforeEditor.document.getText(), 'BASE\n')
  checks.push('file edit, checkpoint and native diff')
  const plan = await agent.previewRestore(firstUser.seq)
  assert.deepEqual(plan.changes.map(item => item.path), ['acceptance.txt'])
  await agent.resendFromHistory(firstUser.seq, '请把 acceptance.txt 的全部内容改为 REBUILT。不要使用 Bash；只回复已修改。', '历史重发', undefined, plan)
  assert.equal(agent.persistedSessionId, first)
  assert.equal(fs.readFileSync(target, 'utf8').trim(), 'REBUILT')
  const rewound = await agent.sessionHistory(first)
  assert.ok(!userMessage(rewound, '改为 SECOND'))
  await agent.undoRestore()
  assert.equal(fs.readFileSync(target, 'utf8').trim(), 'SECOND')
  checks.push('restore preview, rewind, resend and undo')
  await agent.newSession()
  await agent.run('只回复第二会话就绪，不要使用工具。')
  const second = agent.persistedSessionId
  assert.notEqual(second, first)
  await agent.selectSession(first)
  assert.ok((await agent.listSessions()).sessions.some(session => session.id === second))
  await agent.deleteSession(second)
  await assert.rejects(agent.selectSession(second), /会话已删除/)
  assert.equal(agent.persistedSessionId, first)
  checks.push('session switch and inactive delete')
  await agent.dispose()
  agent = new (agent.constructor)(agent.context, agent.emitDirect)
  await agent.restoreSelection()
  assert.equal(agent.persistedSessionId, first)
  await agent.run('只回复最初给你的安装验收暗号，不要使用工具。')
  const replay = await agent.sessionHistory(first)
  assert.ok(replay.events.some(event => event.type === 'assistant/message' && JSON.stringify(event.data.message.content).includes('VSIX_ACCEPT_6721')))
  checks.push('controller recreation and session continuation')
  assert.ok(await agent.setPermissionMode('read-only'))
  await new Promise(resolve => setTimeout(resolve, 100))
  await agent.run('只回复已切换到只读，不要使用工具。')
  assert.ok(events.some(event => event.type === 'config' && event.permissionMode === 'read-only'))
  checks.push('controller permission mode elevation boundary')
  await agent.dispose()
  for (const outcome of ['rejected', 'allowed-once']) {
    const { createHarness, defaultDshHome } = await import(path.join(extensionRoot, 'out/runtime.js'))
    fs.writeFileSync(target, 'BEFORE\n')
    const harness = createHarness({ dshHome: process.env.DSH_AGENT_HOME ?? defaultDshHome(), cwd: workspace, runtimeStorage: path.join(process.env.VSCODE_ACCEPT_STORAGE, 'approval-patches'), permissionMode: 'read-only', approvalRequests: true })
    let count = 0
    try {
      harness.client.start()
      harness.client.onRequest(async (method) => {
        assert.equal(method, 'approval/request')
        count++
        return { outcome }
      })
      await harness.start()
      const result = await harness.run(`请把 acceptance.txt 的内容改成 ${outcome}，只修改这个文件。当前会话 read-only；普通写入被沙箱拒绝时，请重试精确操作，携带 sandbox_permissions="workspace-write" 和 justification。不要 Bash。最终报告结果。`)
      assert.equal(result.finishReason, 'completed')
      assert.equal(count, 1)
      if (outcome === 'rejected') assert.equal(fs.readFileSync(target, 'utf8'), 'BEFORE\n')
      else assert.match(fs.readFileSync(target, 'utf8'), /allowed-once/)
    } finally { await harness.close() }
  }
  checks.push('single-use approval allow and reject')
}

async function run() {
  const vscode = require('vscode')
  const extensionRoot = process.env.VSCODE_ACCEPT_ROOT
  const workspace = process.env.VSCODE_ACCEPT_WORKSPACE
  const evidence = { schemaVersion: 1, status: 'running', checks: [], platform: process.platform, arch: process.arch, dshHome: process.env.VSCODE_ACCEPT_WITH_MODEL === '1' ? 'default HOME/.dsh' : 'isolated DSH_AGENT_HOME' }
  const write = () => fs.writeFileSync(process.env.VSCODE_ACCEPT_EVIDENCE, JSON.stringify(evidence, null, 2) + '\n')
  const initialFiles = inventory(extensionRoot)
  try {
    assert.ok(process.versions.electron)
    assert.ok(!extensionRoot.includes('vscode-coding-agent'))
    process.env.PATH = '/nonexistent/coding-agent-path'
    delete process.env.DSH_NODE_PATH
    const { AgentController } = await import(path.join(extensionRoot, 'out/agentController.js'))
    const { hostError } = await import(path.join(extensionRoot, 'out/diagnostics.js'))
    const extension = vscode.extensions.getExtension(process.env.VSCODE_ACCEPT_EXTENSION_ID)
    assert.ok(extension, '已安装的 Agent 扩展未出现在当前工作区')
    assert.equal(extension.extensionUri.fsPath, extensionRoot, '激活的扩展必须来自 VSIX 安装目录')
    assert.equal(extension.packageJSON.capabilities?.untrustedWorkspaces?.supported, 'limited')
    await extension.activate()
    await vscode.commands.executeCommand('workbench.view.extension.privateCodingAgent')
    await vscode.commands.executeCommand('privateCodingAgent.chat.focus')
    const agent = await vscode.commands.executeCommand('privateCodingAgent.debugController')
    assert.equal(vscode.workspace.isTrusted, true, '@vscode/test-electron 强制 --disable-workspace-trust；真实受限模式必须由独立桌面窗口人工验收')
    evidence.checks.push('installed manifest declares limited untrusted workspace support; test runner forces trust')
    evidence.workspaceTrust = { forcedByTestRunner: true, realRestrictedModeVerified: false }
    evidence.checks.push('extension activation and registered Webview opened')
    const { defaultDshHome } = await import(path.join(extensionRoot, 'out/runtime.js'))
    const config = vscode.workspace.getConfiguration('privateCodingAgent')
    await config.update('provider', 'kimi-coding', vscode.ConfigurationTarget.Workspace)
    await config.update('model', 'k3', vscode.ConfigurationTarget.Workspace)
    if (process.env.VSCODE_ACCEPT_WITH_MODEL === '1') {
      assert.equal(process.env.DSH_AGENT_HOME, undefined, '默认目录验收不得使用测试 Home 覆盖')
      assert.equal(agent.options().dshHome, defaultDshHome())
      assert.notEqual(agent.options().dshHome, process.env.VSCODE_ACCEPT_STORAGE)
      evidence.checks.push('default HOME/.dsh with VS Code-private UI storage')
    }
    assert.ok(agent instanceof AgentController)
    evidence.checks.push('extension activation and registered Webview opened')
    assert.ok(agent instanceof AgentController)
    const state = new Map()
    const context = {
      extensionUri: vscode.Uri.file(extensionRoot), globalStorageUri: vscode.Uri.file(process.env.VSCODE_ACCEPT_STORAGE),
      workspaceState: { get: key => state.get(key), update: async (key, value) => { if (value === undefined) state.delete(key); else state.set(key, value) }, keys: () => [...state.keys()] },
    }
    const events = []
    let controller = agent
    const observe = agent.emitDirect
    agent.emitDirect = message => { events.push(message); observe(message) }
    if (process.env.VSCODE_ACCEPT_WITH_MODEL === '1') assert.ok(controller instanceof AgentController)
    await vscode.commands.executeCommand('privateCodingAgent.initializeWorkspace')
    assert.equal(config.get('provider'), 'deepseek-account', '初始化必须迁移旧内置 Provider')
    assert.equal(config.get('model'), 'deepseek-flash', '初始化必须迁移旧内置模型')
    assert.ok(!events.some(event => event.type === 'error' && String(event.text).includes('no adapter registered')), '旧模型不得阻塞目录与会话初始化')
    evidence.checks.push('removed built-in route migrates through real workspace initialization')
    try {
      const sessions = await controller.listSessions()
      assert.deepEqual(sessions, { sessions: [] })
      const catalog = process.env.VSCODE_ACCEPT_OFFLINE_CATALOG === undefined
        ? await controller.modelCatalog()
        : await (async () => {
          const { harnessLaunchOptions } = await import(path.join(extensionRoot, 'out/runtime.js'))
          const { DeepSeekHarness } = await import(path.join(extensionRoot, 'node_modules/@deepseek-ai/dsh-sdk-client/lib/index.js'))
          const harness = new DeepSeekHarness({
            ...harnessLaunchOptions({ dshHome: process.env.DSH_AGENT_HOME, cwd: workspace, runtimeStorage: path.join(process.env.VSCODE_ACCEPT_STORAGE, 'catalog-patches') }),
            patches: [process.env.VSCODE_ACCEPT_OFFLINE_CATALOG],
            env: { ...harnessLaunchOptions({ dshHome: process.env.DSH_AGENT_HOME, cwd: workspace }).env, DEEPSEEK_API_KEY: 'vsix-offline-probe' },
          })
          try { await harness.start(); return await harness.listModels() } finally { await harness.close() }
        })()
      const expectedProvider = process.env.VSCODE_ACCEPT_OFFLINE_CATALOG === undefined ? 'deepseek-account' : 'deepseek-official'
      assert.ok(catalog.groups.some(group => group.id === expectedProvider && (!process.env.VSCODE_ACCEPT_OFFLINE_CATALOG || group.models.some(model => model.id === 'vsix-offline-catalog'))), `内置模型目录缺少 ${expectedProvider}`)
      evidence.checks.push('isolated home, bundled model catalog')
      assert.match(hostError(new Error('Request timed out. [code TIMEOUT]')), /\[模型\]/)
      assert.doesNotMatch(hostError(new Error('Request timed out. [code TIMEOUT]')), /安装 Node|源码路径/)
      evidence.checks.push('network error classification without Node advice')
      const { CheckpointStore } = await import(path.join(extensionRoot, 'out/checkpoints.js'))
      const largeWorkspace = path.join(workspace, 'large-checkpoint-workspace')
      fs.mkdirSync(path.join(largeWorkspace, 'downloads'), { recursive: true })
      const download = path.join(largeWorkspace, 'downloads', 'node-v24.9.0-linux-x64.tar.xz')
      const descriptor = fs.openSync(download, 'w')
      fs.ftruncateSync(descriptor, 10 * 1024 * 1024 + 1)
      fs.closeSync(descriptor)
      const small = path.join(largeWorkspace, 'source.txt')
      fs.writeFileSync(small, 'BEFORE\n')
      const store = new CheckpointStore(path.join(process.env.VSCODE_ACCEPT_STORAGE, 'large-checkpoint'))
      await store.before('large-file-session', largeWorkspace, 1, 'preserve the existing Node archive')
      await store.trackWorkspaceChanges('large-file-session', largeWorkspace)
      await store.finish('large-file-session', largeWorkspace)
      await store.after('large-file-session', 1)
      await store.before('large-file-session', largeWorkspace, 2, 'modify source while preserving the archive')
      fs.writeFileSync(small, 'AFTER\n')
      await store.track('large-file-session', largeWorkspace, small)
      fs.appendFileSync(download, 'archive update')
      await assert.rejects(store.trackWorkspaceChanges('large-file-session', largeWorkspace), /大文件.*手动审查/)
      await store.finish('large-file-session', largeWorkspace)
      await store.after('large-file-session', 2)
      const plan = await store.previewRestore(largeWorkspace, 'large-file-session', 2)
      assert.equal(plan.changes.find(change => change.path.includes('node-v24')).current, undefined)
      await store.restoreFrom(largeWorkspace, 'large-file-session', 2, new Map(plan.changes.map(change => [change.path, change.currentHash])), plan)
      assert.equal(fs.readFileSync(small, 'utf8'), 'BEFORE\n')
      assert.ok(fs.statSync(download).size > 10 * 1024 * 1024)
      await store.backupForUndo('large-file-session', largeWorkspace, plan.changes.map(change => change.path))
      await store.undo(largeWorkspace, 'large-file-session')
      assert.ok(fs.statSync(download).size > 10 * 1024 * 1024)
      fs.rmSync(largeWorkspace, { recursive: true })
      evidence.checks.push('large archive turn, metadata-only preview, small restore and undo preservation')
      if (process.env.VSCODE_ACCEPT_WITH_MODEL === '1') await modelAcceptance(controller, extensionRoot, workspace, evidence.checks, events)
      else await controller.dispose()
    } finally { await agent.dispose() }
    const after = inventory(extensionRoot)
    assert.deepEqual(after, initialFiles, '运行时写入了只读安装目录')
    evidence.checks.push('read-only installation and clean teardown')
    evidence.status = 'passed'
    write()
    console.log('VSIX acceptance passed', JSON.stringify(evidence))
  } catch (error) {
    evidence.error = error.stack ?? String(error)
    write()
    throw error
  }
}
module.exports = { run }
