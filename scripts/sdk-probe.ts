import { resolve } from 'node:path'
import { createHarness } from '../src/runtime.ts'

const projectRoot = resolve(import.meta.dirname, '../..')
const harness = createHarness({
  dshRepository: resolve(projectRoot, 'dsh-learning/deepseek-harness'),
  dshHome: resolve(projectRoot, '.dsh-dev'),
  cwd: resolve(projectRoot, 'stage0-fixture'),
  provider: process.env.AGENT_PROVIDER ?? 'deepseek-account',
  model: process.env.AGENT_MODEL ?? 'deepseek-flash',
  approvalRequests: true,
})

try {
  await harness.client.start()
  harness.client.onRequest(async (method, params) => {
    console.log('Approval requested (rejected by non-interactive probe):', method, params.toolName)
    return { outcome: 'rejected' as const }
  })
  await harness.start()
  console.log('SDK initialize: OK')
  const result = await harness.run(
    process.env.AGENT_PROMPT ?? 'Reply exactly: SDK connection OK. Do not use tools.',
    {
      onNotification(notification) {
        if (notification.method === 'session.event') {
          const event = notification.params.event as { type?: string, data?: { reason?: unknown } }
          if (event.type === 'turn/end') console.log('Turn ended:', event.data?.reason)
          if (event.type?.startsWith('assistant/') && event.type !== 'assistant/message') console.log('Assistant stream event:', JSON.stringify(event))
          if (event.type === 'assistant/message') console.log('Assistant settled:', JSON.stringify((event.data as { message?: { content?: unknown } }).message?.content))
        }
      },
    },
  )
  console.log(JSON.stringify({ sessionId: result.sessionId, finalResponse: result.finalResponse, finishReason: result.finishReason }, null, 2))
} finally {
  await harness.close()
  console.log('SDK subprocess closed')
}
