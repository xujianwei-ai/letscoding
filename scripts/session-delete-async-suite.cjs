const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const Module = require('node:module')

/** Direct controller storage test, without Electron, a DSH Host or model credentials. */
async function run() {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'delete-workspace-'))
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'delete-home-'))
  const storage = await fs.mkdtemp(path.join(os.tmpdir(), 'delete-storage-'))
  const stub = path.join(storage, 'vscode.mjs')
  const hook = Module.registerHooks({ resolve: (specifier, context, next) => specifier === 'vscode'
    ? { url: require('node:url').pathToFileURL(stub).href, shortCircuit: true } : next(specifier, context) })
  await fs.writeFile(stub, `
    class EventEmitter { constructor() { this.event = () => ({ dispose() {} }) } dispose() {} }
    class ThemeColor { constructor(id) { this.id = id } }
    const disposable = () => ({ dispose() {} })
    const workspace = { isTrusted: true, workspaceFolders: [{ uri: { fsPath: ${JSON.stringify(workspace)} } }], getConfiguration: () => ({ get: (key, fallback) => key === 'dshHome' ? ${JSON.stringify(home)} : fallback }), onDidOpenTextDocument: disposable, onDidSaveTextDocument: disposable, onDidChangeTextDocument: disposable }
    const window = { onDidChangeVisibleTextEditors: disposable, createTextEditorDecorationType: disposable, visibleTextEditors: [] }
    const OverviewRulerLane = { Left: 1 }
    const Uri = { parse: value => value }
    export { EventEmitter, ThemeColor, workspace, window, OverviewRulerLane, Uri }
  `)
  let agent
  try {
    const { AgentController } = await import('../out/agentController.js')
    const { sessionProjectKey } = await import('../out/agent.js')
    process.env.DSH_AGENT_HOME = home
    const memento = new Map()
    const events = []
    agent = new AgentController({ extensionUri: { fsPath: path.resolve(__dirname, '..') }, globalStorageUri: { fsPath: storage },
      workspaceState: { get: key => memento.get(key), update: async (key, value) => value === undefined ? memento.delete(key) : memento.set(key, value) } }, event => events.push(event))
    const { CheckpointStore } = await import('../out/checkpoints.js')
    CheckpointStore.prototype.deleteSession = async () => {}
    const directory = path.join(home, 'sessions', sessionProjectKey(await fs.realpath(workspace)), 'old')
    await fs.mkdir(directory, { recursive: true })
    await fs.writeFile(path.join(directory, 'session.jsonl'), '{}\n')
    await fs.mkdir(path.join(home, 'storages/session_projcache/sessions'), { recursive: true })
    await fs.writeFile(path.join(home, 'storages/session_projcache/sessions/old.json'), '{}')
    await agent.deleteSession('old')
    assert.equal(await fs.stat(directory).then(() => false, error => error.code === 'ENOENT'), true)
    assert.equal(await fs.stat(path.join(home, 'storages/session_projcache/sessions/old.json')).then(() => false, error => error.code === 'ENOENT'), true)
    assert.equal(agent.persistedSessionId, undefined)
    await assert.rejects(agent.deleteSession('missing'), /ENOENT/)
    assert.equal(agent.deletedSessions.has('missing'), false)
    console.log('Direct background deletion, projection cleanup and pre-delete failure recovery passed')
  } finally {
    await agent?.dispose()
    hook.deregister()
    await Promise.all([workspace, home, storage].map(directory => fs.rm(directory, { recursive: true, force: true })))
  }
}
if (require.main === module) void run().catch(error => { console.error(error); process.exitCode = 1 })
module.exports = { run }
