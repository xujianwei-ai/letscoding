const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const Module = require('node:module')

async function run() {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'runtime-workspace-'))
  const storage = await fs.mkdtemp(path.join(os.tmpdir(), 'runtime-storage-'))
  const stub = path.join(storage, 'vscode.mjs')
  const hook = Module.registerHooks({ resolve: (specifier, context, next) => specifier === 'vscode'
    ? { url: require('node:url').pathToFileURL(stub).href, shortCircuit: true } : next(specifier, context) })
  await fs.writeFile(stub, `
    class EventEmitter { constructor() { this.event = () => ({ dispose() {} }) } dispose() {} }
    class ThemeColor { constructor(id) { this.id = id } }
    const disposable = () => ({ dispose() {} })
    const workspace = { isTrusted: false, workspaceFolders: [{ uri: { fsPath: ${JSON.stringify(workspace)} } }], getConfiguration: () => ({ get: (key, fallback) => fallback }), onDidOpenTextDocument: disposable, onDidSaveTextDocument: disposable, onDidChangeTextDocument: disposable }
    const window = { onDidChangeVisibleTextEditors: disposable, createTextEditorDecorationType: disposable, visibleTextEditors: [] }
    const OverviewRulerLane = { Left: 1 }
    const Uri = { parse: value => value }
    export { EventEmitter, ThemeColor, workspace, window, OverviewRulerLane, Uri }
  `)
  const { AgentController } = await import('../out/agentController.js')
  const { workspace: vscodeWorkspace } = await import('vscode')
  const { SessionRuntime } = await import('../out/agent.js')
  const restricted = new AgentController({ extensionUri: { fsPath: path.resolve(__dirname, '..') }, globalStorageUri: { fsPath: storage },
    workspaceState: { get: () => undefined, update: async () => {} } }, () => {})
  let restrictedHostStarts = 0
  restricted.create = () => ({ run: async () => { restrictedHostStarts++ } })
  await assert.rejects(restricted.run('untrusted'), /信任当前工作区/)
  await assert.rejects(restricted.modelCatalog(), /信任当前工作区/)
  assert.deepEqual(await restricted.listSessions(), { sessions: [] })
  await restricted.restoreSelection()
  assert.equal(restrictedHostStarts, 0, 'Restricted Mode must not allocate a DSH Host')
  vscodeWorkspace.isTrusted = true
  await restricted.dispose()
  console.log('Restricted Mode exposes the shell without starting DSH')
  const networkEvents = []
  const networkRuntime = new SessionRuntime({ extensionUri: { fsPath: path.resolve(__dirname, '..') }, globalStorageUri: { fsPath: storage },
    workspaceState: { get: () => undefined, update: async () => {} } }, event => networkEvents.push(event))
  let closes = 0
  networkRuntime.harness = { close: async () => { closes++ } }
  networkRuntime.hostNetwork = { networkMode: 'system' }
  networkRuntime.options = () => { throw new Error('Network boundary reached with direct mode') }
  networkRuntime.notify = () => {}
  const originalClose = networkRuntime.closeHost.bind(networkRuntime)
  networkRuntime.closeHost = async () => { await originalClose(); throw new Error('Network Host reopened for direct mode') }
  await assert.rejects(networkRuntime.start(), /Network Host reopened/)
  assert.equal(closes, 1, 'A changed network policy closes the stale Host before a turn')
  assert.equal(networkRuntime.harness, undefined)
  console.log('Session network change closes the stale Host before resuming a turn')
  const events = []
  const memento = new Map()
  const controller = new AgentController({ extensionUri: { fsPath: path.resolve(__dirname, '..') }, globalStorageUri: { fsPath: storage },
    workspaceState: { get: key => memento.get(key), update: async (key, value) => value === undefined ? memento.delete(key) : memento.set(key, value) } }, event => events.push(event))
  const hosts = []
  const readHost = {
    start: async () => {},
    listSessions: async () => ({ sessions: [{ id: 'cold', title: 'Cold', cwd: workspace, createdAt: 1, updatedAt: 1 }] }),
    sessionHistory: async id => ({ session: { id, title: id, cwd: workspace, createdAt: 1, updatedAt: 1 }, events: [{ type: 'user/message', seq: 0, time: 1, data: { content: [{ type: 'text', text: 'cold prompt' }] } }] }),
    close: async () => { readHost.closed = (readHost.closed ?? 0) + 1 },
  }
  controller.readHost = readHost
  controller.create = id => {
    const host = { id, busy: false, hasStarted: id !== undefined, disposed: 0, replay: [],
      adopt(value) { this.id = value },
      releaseAdoptedId() { this.id = undefined },
      needsResume: false, prepareCalls: 0,
      async prepareRestore() { this.prepareCalls++; this.needsResume = false },
      async run() {
        this.busy = true
        controller.output({ type: 'busy', busy: true, sessionId: this.id })
        // Resolve only when the owning test stops this Session, as a real Host turn does.
        return new Promise(resolve => { this.finish = () => { this.busy = false; resolve() } })
      },
      replayHistory(history) {
        this.replay.push(history.session.id)
        const user = { type: 'user', text: history.events[0].data.content[0].text, sessionId: this.id }
        controller.output({ type: 'historyReplay', sessionId: this.id, messages: [user] })
      },
      async dispose() { this.disposed++ },
      async stop() { this.busy = false; this.finish?.() },
      async restart() {}, async resume() {},
      async previewRestore() {}, async undoRestore() {}, async rerunVerification() {},
      async resendFromHistory(seq) {
        this.rewindSeq = seq
        if (this.rewindError) throw this.rewindError
      },
      answerQuestions() {}, setPermissionMode: async () => true,
    }
    hosts.push(host)
    return host
  }
  try {
    const running = controller.run('A')
    const first = hosts[0]
    assert.equal(controller.selectedId, first.id, 'Draft adoption updates the selected Session immediately')
    assert.equal(controller.selected.id, first.id, 'Runtime identity and selection never diverge')
    assert.equal(controller.liveViews.get(first.id).filter(event => event.type === 'busy').length, 1, 'The adopted draft records its first turn once')
    assert.ok(first.id, 'Draft is assigned a Session id')
    controller.newSession()
    assert.equal(controller.persistedSessionId, undefined)
    const second = controller.run('B')
    while (controller.runtimes.size < 2) await new Promise(resolve => setImmediate(resolve))
    const secondHost = hosts.find(host => host.id !== first.id)
    assert.equal(hosts.length, 2, 'New Session has its own runtime')
    assert.equal(first.disposed, 0, 'Switching must not close the running Host')
    controller.output({ type: 'assistantDelta', text: 'A background', sessionId: first.id })
    assert.equal(events.some(event => event.text === 'A background'), false)
    assert.equal(controller.liveViews.get(first.id).at(-1).text, 'A background', 'Background deltas replace the stale history snapshot')
    controller.output({ type: 'assistantDelta', text: ' continued', sessionId: first.id })
    assert.equal(controller.liveViews.get(first.id).at(-1).text, ' continued', 'Cached deltas keep their independent wire boundaries')
    await controller.selectSession(first.id)
    assert.equal(events.filter(event => event.text === 'A background').length, 1, `Background text is restored on selection: ${JSON.stringify(events)}`)
    assert.equal(events.filter(event => event.text === ' continued').length, 1, 'The later delta is restored in order')
    events.length = 0
    await controller.restoreSelection()
    assert.equal(events.filter(event => event.text === 'A background').length, 1, 'Webview recreation restores the full in-memory snapshot')
    assert.ok(events.some(event => event.type === 'busy' && event.busy), 'Webview recreation preserves the running state')
    const secondId = secondHost.id
    await controller.stop(secondId)
    await second
    assert.equal(first.busy, true, 'The selected Session remains busy while a background Session stops')
    controller.output({ type: 'busy', busy: false, sessionId: secondId })
    assert.equal(events.some(event => event.type === 'busy' && event.busy === false), false, 'A background completion must not unlock the selected composer')
    await controller.selectSession('cold')
    assert.equal(hosts.at(-1).replay[0], 'cold')
    await controller.selectSession('cold')
    assert.equal(hosts.filter(host => host.id === 'cold').length, 1, 'Warm Session selection must not create another Host')
    await controller.listSessions()
    assert.equal(readHost.closed, undefined, 'Read Host is retained across Session switches')
    assert.equal(first.disposed, 0)
    await running
    await second
    hosts.find(host => host.id === 'cold').needsResume = true
    await controller.selectSession(first.id)
    await controller.selectSession('cold')
    assert.equal(hosts.find(host => host.id === 'cold').prepareCalls, 1, 'Warm historical projection releases a stale DSH write lock once')
    await controller.selectSession(first.id)
    await controller.selectSession('cold')
    assert.equal(hosts.find(host => host.id === 'cold').prepareCalls, 1, 'A running Session keeps its live Host on every switch')
    await controller.resendFromHistory(0, 'retry prompt', 'retry prompt', undefined, undefined, false, 'cold')
    const current = controller.runtimes.get('cold')
    assert.equal(current.rewindSeq, 0)
    assert.equal(controller.persistedSessionId, 'cold', 'Resend retains the current Session identity')
    assert.equal(hosts.length, 3, 'Resend creates neither a Session nor a Host')
    const sourceRewind = current.resendFromHistory
    let releaseRewind
    current.resendFromHistory = seq => new Promise((resolve, reject) => {
      releaseRewind = () => sourceRewind.call(current, seq).then(resolve, reject)
    })
    const delayedRewind = controller.resendFromHistory(0, 'retry again', 'retry again', undefined, undefined, false, 'cold')
    while (releaseRewind === undefined) await new Promise(resolve => setImmediate(resolve))
    controller.newSession()
    assert.equal(controller.persistedSessionId, undefined, 'New Session remains immediate during background rewind')
    await releaseRewind()
    await delayedRewind
    assert.equal(controller.persistedSessionId, undefined, 'An older rewind never steals the newer draft selection')
    assert.equal(current.busy, true, 'Rewind resumes the original Session even while it is hidden')
    assert.equal(hosts.length, 3, 'Repeated resends retain the same Host')
    await controller.stop('cold')
    await controller.selectSession('cold')
    current.rewindError = new Error('rewind failed')
    await assert.rejects(controller.resendFromHistory(0, 'failed rewind', 'failed rewind', undefined, undefined, false, 'cold'), /rewind failed/)
    assert.equal(controller.persistedSessionId, 'cold', 'A failed rewind preserves the source selection')
    assert.equal(current.disposed, 0, 'Rewind never disposes the source UI runtime')
    assert.equal(hosts.length, 3, 'A failed rewind creates no abandoned Session')
    controller.newSession()
    const failed = controller.run('will fail')
    while (hosts.at(-1).id === undefined) await new Promise(resolve => setImmediate(resolve))
    hosts.at(-1).run = async () => {}
    await failed
    assert.equal(controller.persistedSessionId, undefined, 'A Host rejected before starting must return to a draft')

    const reads = new Map()
    readHost.sessionHistory = id => new Promise(resolve => { reads.set(id, () => resolve({ session: { id, title: id, cwd: workspace, createdAt: 1, updatedAt: 1 }, events: [] })) })
    controller.selectSession('slow-a').catch(() => {})
    controller.selectSession('slow-b').catch(() => {})
    while (reads.size < 2) await new Promise(resolve => setImmediate(resolve))
    assert.equal(controller.persistedSessionId, 'slow-b', 'Cold selection immediately exposes the latest target')
    reads.get('slow-b')()
    await new Promise(resolve => setImmediate(resolve))
    reads.get('slow-a')()
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(controller.persistedSessionId, 'slow-b', 'A late cold read cannot replace the latest selection')
    assert.equal(controller.selected.id, 'slow-b', 'The selected runtime remains the newest Session')
    const deletedSelection = controller.selectSession('deleting').catch(() => {})
    await controller.deleteSession('deleting')
    assert.equal(controller.persistedSessionId, undefined, 'Deleting a background Session keeps the active draft')
    await deletedSelection
    assert.equal(controller.persistedSessionId, undefined, 'A pending deleted read cannot reselect the deleted Session')
    readHost.sessionHistory = async id => ({ session: { id, title: id, cwd: workspace, createdAt: 1, updatedAt: 1 }, events: [] })
    await controller.selectSession('slow-b')
    const closingHost = controller.runtimes.get('slow-b')
    let releaseDisposal
    closingHost.dispose = () => new Promise(resolve => { releaseDisposal = resolve })
    const disposing = controller.deleteSession('slow-b')
    while (releaseDisposal === undefined) await new Promise(resolve => setImmediate(resolve))
    await controller.selectSession('cold')
    releaseDisposal()
    await disposing
    assert.equal(controller.persistedSessionId, 'cold', 'Slow disposal cannot reset a newer selection')
    await assert.rejects(controller.selectSession('slow-b'), /会话已删除/)
    const missingSelection = controller.selectSession('missing-after-delete').catch(() => {})
    controller.newSession()
    controller.prepareRun()
    const draftRun = controller.run('fresh after failed selection')
    while (hosts.at(-1).id === undefined) await new Promise(resolve => setImmediate(resolve))
    assert.equal(hosts.at(-1).busy, true, 'A new draft runs after a failed historical selection')
    await missingSelection
    await controller.stop(hosts.at(-1).id)
    await draftRun
    console.log('Independent runtimes, background projection, warm history and read Host reuse passed')
  } finally {
    await controller.dispose()
    hook.deregister()
    await Promise.all([workspace, storage].map(directory => fs.rm(directory, { recursive: true, force: true })))
  }
}
if (require.main === module) void run().catch(error => { console.error(error); process.exitCode = 1 })
module.exports = { run }
