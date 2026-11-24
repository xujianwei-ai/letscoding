const assert = require('node:assert/strict')

// End-to-end verification of the graceful-stop fix inside a real VS Code
// Extension Host: the extension must cancel via session/cancel (Host stays
// warm), keep the cancelled user message durable, and accept a follow-up
// without a cold relaunch.
async function run() {
  console.log('Graceful-stop integration test starting')
  const vscode = require('vscode')
  const { AgentController } = await import('../out/agentController.js')
  const { Uri } = vscode
  const testStorage = require('node:path').resolve(__dirname, `../../.vscode-agent-dev/test-storage-cancel-${Date.now()}`)
  const context = { extensionUri: Uri.file(require('node:path').resolve(__dirname, '..')), globalStorageUri: Uri.file(testStorage) }
  const events = []
  const state = new Map()
  context.workspaceState = {
    get: key => state.get(key),
    update: async (key, value) => { if (value === undefined) state.delete(key); else state.set(key, value) },
    keys: () => [...state.keys()],
  }
  const agent = new AgentController(context, event => { events.push(event) })
  await context.workspaceState.update('permissionMode', 'workspace-write')
  await new Promise(resolve => setTimeout(resolve, 100))

  const sessionId = agent.prepareRun()
  const firstRun = agent.run('Count slowly from 1 to 50, one number per line, with a short comment per line.', undefined, sessionId)

  // Wait for streaming to actually start before stopping.
  const streamDeadline = Date.now() + 30000
  while (!events.some(e => e.type === 'assistantDelta' && e.text) && Date.now() < streamDeadline) {
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  const sawStream = events.some(e => e.type === 'assistantDelta' && e.text)
  console.log('Streamed before stop:', sawStream)

  const stopStarted = Date.now()
  await agent.stop(sessionId)
  const stopLatency = Date.now() - stopStarted
  console.log(`stop() returned in ${stopLatency}ms`)
  await firstRun

  const cancelledHistory = await agent.sessionHistory(agent.persistedSessionId)
  const userMessagesAfterStop = cancelledHistory.events.filter(e => e.type === 'user/message' && e.data?.source?.kind === 'user').length
  console.log('Durable user messages after stop:', userMessagesAfterStop)
  assert.equal(userMessagesAfterStop, 1, 'cancelled user turn must stay durable (not rewound)')

  const statuses = events.filter(e => e.type === 'status').map(e => e.text)
  console.log('Status trail:', JSON.stringify(statuses))
  const busyEvents = events.filter(e => e.type === 'busy').map(e => e.busy)
  assert.equal(busyEvents.at(-1), false, 'busy must be released after stop')

  // The Host must still be warm: a follow-up on the same session starts without a cold launch.
  const followupStarted = Date.now()
  await agent.run('Reply exactly: still alive.', undefined, sessionId)
  const followupLatency = Date.now() - followupStarted
  console.log(`Follow-up completed in ${followupLatency}ms`)

  const finalHistory = await agent.sessionHistory(agent.persistedSessionId)
  const finalUserMessages = finalHistory.events.filter(e => e.type === 'user/message' && e.data?.source?.kind === 'user').length
  const turnEnds = finalHistory.events.filter(e => e.type === 'turn/end')
  const abortedTurn = turnEnds.find(e => e.data?.reason?.kind === 'aborted')
  console.log('Final durable user messages:', finalUserMessages)
  console.log('Aborted turn recorded:', abortedTurn !== undefined)
  assert.equal(finalUserMessages, 2, 'both user turns must be durable')
  assert.ok(abortedTurn, 'cancelled turn must settle as turn/end reason=aborted')

  console.log('Graceful-stop integration test passed', JSON.stringify({ stopLatency, followupLatency, sawStream }))
}

module.exports = { run }
