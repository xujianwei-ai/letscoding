import { resolve } from 'node:path'
import { createHarness } from '../src/runtime.ts'

// End-to-end probe for graceful cancel: start a real turn, cancel it via
// session/cancel, then immediately send a follow-up on the SAME Host. Before
// the fix, stop() killed the Host subprocess and rewound the user message out
// of the durable log.
const projectRoot = resolve(import.meta.dirname, '../..')
const harness = createHarness({
  dshRepository: resolve(projectRoot, 'dsh-learning/deepseek-harness'),
  dshHome: resolve(projectRoot, '.dsh-dev'),
  cwd: resolve(projectRoot, 'stage0-fixture'),
  provider: process.env.AGENT_PROVIDER ?? 'deepseek-account',
  model: process.env.AGENT_MODEL ?? 'deepseek-flash',
  approvalRequests: true,
  runtimeMode: 'source',
})

const sessionId = `probe-cancel-${Date.now()}`
let sawDelta = false
let turnEndReason: unknown

try {
  await harness.client.start()
  harness.client.onRequest(async () => ({ outcome: 'rejected' as const }))
  await harness.start()
  console.log('[probe] Host initialized')

  const first = harness.session(sessionId).run(
    'Count slowly from 1 to 50, one number per line, with a short comment per line.',
    {
      onNotification(notification) {
        if (notification.method === 'session.assistant.delta') {
          const text = (notification.params as { text?: string }).text ?? ''
          if (text.length > 0) sawDelta = true
        }
        if (notification.method === 'session.event') {
          const event = notification.params.event as { type?: string, data?: { reason?: unknown } }
          if (event.type === 'turn/end') turnEndReason = event.data?.reason
        }
      },
    },
  )

  // Wait for the first streamed chunk (bounded), then cancel gracefully.
  const deadline = Date.now() + 20_000
  while (!sawDelta && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 200))
  }
  console.log(`[probe] Streamed before cancel: ${sawDelta}`)

  const cancelStarted = Date.now()
  await harness.session(sessionId).cancel()
  console.log(`[probe] session/cancel accepted in ${Date.now() - cancelStarted}ms`)

  const result = await first
  console.log('[probe] First turn settled:', JSON.stringify({ finishReason: result.finishReason, turnEndReason }))

  // The Host must still be warm: the follow-up starts without a cold launch,
  // and the durable log retains the cancelled user turn (no rewind).
  const followupStarted = Date.now()
  const second = await harness.session(sessionId).run('Reply exactly: still alive.')
  console.log(`[probe] Follow-up completed in ${Date.now() - followupStarted}ms: ${second.finalResponse.slice(0, 60)}`)

  const history = await harness.sessionHistory(sessionId)
  console.log(`[probe] history.session.id: ${history.session.id}, events: ${history.events.length}`)
  for (const e of history.events) {
    if (e.type === 'user/message') {
      console.log(`[probe]   user/message seq=${e.seq}`, JSON.stringify((e.data as { content?: Array<{ text?: string }> }).content?.[0]?.text?.slice(0, 50)))
    }
  }
  const userMessages = history.events.filter(e =>
    e.type === 'user/message' && (e.data as { source?: { kind?: string } }).source?.kind === 'user',
  ).length
  console.log(`[probe] Durable user messages in ${sessionId}: ${userMessages} (must be 2 — the cancelled turn is NOT rewound)`)
  if (userMessages !== 2) throw new Error(`expected 2 durable user messages, got ${userMessages}`)
} finally {
  await harness.close()
  console.log('[probe] done')
}
