import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import fs from 'node:fs'
import path from 'node:path'

const runtimeRoot = process.env.DSH_RUNTIME_ROOT
const home = process.env.DSH_PROBE_HOME
const workspace = process.env.DSH_PROBE_WORKSPACE
const provider = process.env.DSH_PROBE_PROVIDER ?? 'deepseek-account'
const model = process.env.DSH_PROBE_MODEL ?? 'deepseek-flash'
for (const [name, value] of Object.entries({ runtimeRoot, home, workspace })) {
  assert.ok(value !== undefined && path.isAbsolute(value), `${name} 必须是绝对路径`)
}
assert.equal(process.versions.electron, undefined)
assert.equal(process.env.DSH_PROBE_NODE, process.execPath)
const mode = process.env.DSH_PROBE_MODE ?? 'keyless'
assert.ok(['keyless', 'controlled', 'controlled-mock', 'fault', 'question-protocol'].includes(mode), `未知探针模式: ${mode}`)
const apiKey = mode === 'controlled' ? process.env.DEEPSEEK_API_KEY : mode === 'controlled-mock' ? 'b3-local-controlled-key' : mode === 'keyless' ? 'b3-non-routable-offline-probe' : undefined
let mockServer
if (mode === 'controlled-mock') {
  const { createHash } = await import('node:crypto')
  const mockModule = path.resolve(process.env.DSH_PROBE_MOCK_SERVER)
  assert.equal(mockModule, path.resolve(process.env.DSH_PROBE_MOCK_EXPECTED), '本地模型测试辅助模块必须来自固定 DSH 源码快照')
  const mockPackage = path.join(path.dirname(path.dirname(mockModule)), 'package.json')
  assert.equal(JSON.parse(fs.readFileSync(mockPackage, 'utf8')).name, '@deepseek-ai/dsh-llm-mock-server')
  assert.equal(createHash('sha256').update(fs.readFileSync(mockModule)).digest('hex'), process.env.DSH_PROBE_MOCK_SHA256, '本地模型测试辅助模块哈希漂移')
  const { startMockLlmServer } = await import(mockModule)
  mockServer = await startMockLlmServer({ sequence: ['success', 'success', 'tool_call_success', 'success', 'success'], apiKey: 'b3-local-controlled-key', successText: 'B3_CONTROLLED_OK', toolName: 'ask_user_question', toolArguments: JSON.stringify({ questions: [{ id: 'leave_files', question: 'Leave files unchanged?', options: [{ label: 'Yes', description: 'Keep the temporary workspace unchanged.' }] }] }), chunkDelayMs: 0 })
}
if (mockServer) process.on('exit', () => { void mockServer.close() })
const require = createRequire(path.join(runtimeRoot, 'package.json'))
const { DeepSeekHarness, HarnessClient } = await import(require.resolve('@deepseek-ai/dsh-sdk-client'))
const { hostNetworkEnvironment } = await import(path.join(runtimeRoot, '.sdk-probe/network.ts'))
fs.mkdirSync(home, { recursive: true, mode: 0o700 })
fs.mkdirSync(workspace, { recursive: true })
const dshBin = require.resolve('@deepseek-ai/dsh/package.json').replace(/package\.json$/, 'lib/bin.js')
assert.ok(fs.statSync(dshBin).isFile())
assert.ok(dshBin.startsWith(path.join(runtimeRoot, 'node_modules') + path.sep))
const patchDirectory = path.join(home, 'probe-patches')
fs.mkdirSync(patchDirectory, { recursive: true, mode: 0o700 })
const patches = []
if (mode === 'keyless') {
  const patch = path.join(patchDirectory, 'offline-catalog.yml')
  fs.writeFileSync(patch, `- id: llm-deepseek\n  config:\n    baseURL: http://127.0.0.1:1/anthropic\n    models:\n      - id: b3-offline-catalog\n        name: B3 Offline Catalog\n`, { mode: 0o600 })
  patches.push(patch)
}
if (mode === 'controlled-mock') {
  const patch = path.join(patchDirectory, 'controlled-catalog.yml')
  fs.writeFileSync(patch, `- id: llm-deepseek\n  config:\n    baseURL: ${mockServer.baseURL}\n    models:\n      - id: deepseek-flash\n        name: B3 Controlled Model\n    retryPolicy:\n      mode: normal\n      maxRetries: 0\n`, { mode: 0o600 })
  patches.push(patch)
}
if (mode === 'controlled' && process.env.DSH_PROBE_CREDENTIAL_SOURCE !== undefined) {
  const { load, dump } = await import(require.resolve('js-yaml'))
  const source = path.resolve(process.env.DSH_PROBE_CREDENTIAL_SOURCE)
  const document = load(fs.readFileSync(source, 'utf8'))
  const selected = Object.fromEntries(Object.entries(document?.records ?? {}).filter(([key]) => ['deepseek-account-platform/default', 'deepseek-account-platform/device'].includes(key)))
  assert.ok(Object.keys(selected).length > 0, '显式凭据源没有 DeepSeek 账户授权')
  assert.ok(provider === 'deepseek-account', '账户凭据复制只能用于 deepseek-account 路由')
  assert.ok(process.env.DEEPSEEK_API_KEY === undefined, '账户凭据模式不得混用 API key')
  const target = path.join(home, '.credentials.yaml')
  fs.writeFileSync(target, dump({ version: 1, records: selected }), { mode: 0o600, flag: 'wx' })
  assert.equal(fs.statSync(target).mode & 0o077, 0)
}
if (process.env.DSH_PROBE_PROVIDER_PATCH !== undefined) {
  const patch = path.join(patchDirectory, 'providers.yml')
  fs.copyFileSync(process.env.DSH_PROBE_PROVIDER_PATCH, patch)
  fs.chmodSync(patch, 0o600)
  patches.push(patch)
}
if (process.env.DSH_PROBE_DISABLE_CONTROLLER === '1') {
  const patch = path.join(patchDirectory, 'disable-controller.yml')
  fs.writeFileSync(patch, '- id: session-controller\n  disabled: true\n', { mode: 0o600 })
  patches.push(patch)
}
const questions = []
const events = []
function harnessFor(description, withQuestions = false) {
  const options = {
    nodePath: process.execPath, dshBin, dshHome: home, cwd: workspace, processCwd: runtimeRoot,
    provider, model, approvalRequests: true,
    env: { ...hostNetworkEnvironment(process.env), HOME: home, DEEPSEEK_API_KEY: apiKey, ELECTRON_RUN_AS_NODE: undefined, ELECTRON_NO_ATTACH_CONSOLE: undefined, DSH_PERMISSION_MODE: 'read-only', DSH_TELEMETRY_DISABLED: '1' },
    patches,
    ...withQuestions ? { onUserQuestion: async (request, { signal }) => {
      assert.equal(signal.aborted, false)
      questions.push(request)
      return { answers: request.questions.map(question => ({ id: question.id, selected: [question.options?.[0]?.label ?? ''], custom: 'B3 controlled answer; do not modify files.' })) }
    } } : {},
    initializeTimeoutMs: 60_000, requestTimeoutMs: 120_000,
  }
  const harness = new DeepSeekHarness(options)
  return { harness, launch: harness.client.runtime }
}
const { harness, launch } = harnessFor('staged SDK profile', true)
assert.equal(launch.command, process.env.DSH_PROBE_NODE)
assert.notEqual(launch.command, '/electron-host-must-not-be-used')
assert.deepEqual(launch.args, [dshBin, '--profile', 'sdk', ...patches.flatMap(patch => ['--patch', patch])])
if (mode === 'question-protocol') {
  const entered = Promise.withResolvers()
  const cancelled = Promise.withResolvers()
  const lateAnswer = Promise.withResolvers()
  const fixture = new HarnessClient({
    onUserQuestion: async (request, { signal }) => {
      entered.resolve(request.requestId)
      signal.addEventListener('abort', () => cancelled.resolve(request.requestId), { once: true })
      return lateAnswer.promise
    },
  }, {
    command: process.execPath,
    args: [path.join(runtimeRoot, '.sdk-probe/question-fixture.mjs')],
    cwd: runtimeRoot,
    environment: () => ({ DSH_HOME: home, ELECTRON_RUN_AS_NODE: undefined, ELECTRON_NO_ATTACH_CONSOLE: undefined }),
    description: 'structured question protocol fixture', initializeTimeoutMs: 10_000, requestTimeoutMs: 10_000,
  })
  const subscription = fixture.subscribe(notification => notification.method === 'user-question.cancelled')
  const cancellationNotice = subscription.next()
  try {
    fixture.start()
    await fixture.initialize({ cwd: workspace, provider: 'fixture', model: 'fixture' })
    const pending = fixture.request('test/question', { requestId: 'b3-cancel' })
    assert.equal(await entered.promise, 'b3-cancel')
    await fixture.request('test/cancel', { requestId: 'b3-cancel', sessionId: 'main' })
    assert.equal(await cancelled.promise, 'b3-cancel')
    assert.deepEqual((await cancellationNotice).params, { requestId: 'b3-cancel', sessionId: 'main' })
    const outcome = await pending
    assert.match(outcome.error?.message ?? '', /cancelled/)
    assert.equal(outcome.answer, null)
    lateAnswer.resolve({ answers: [{ id: 'format', selected: ['late answer must be ignored'] }] })
    const result = await fixture.request('test/late-answer', { requestId: 'b3-cancel' })
    assert.equal(result.answer, null, '迟到答案不能重新出现在宿主响应中')
    console.log(JSON.stringify({ schemaVersion: 1, mode, requestId: 'b3-cancel', signalAborted: true, cancellationNotice: true, lateAnswerIgnored: result.answer === null }))
  } finally { subscription.close(); await fixture.close() }
} else try {
  harness.client.start()
  harness.client.onRequest(async () => ({ outcome: 'rejected' }))
  try { await harness.start() }
  catch (error) {
    if (mode !== 'fault') throw error
    const message = error instanceof Error ? error.message : String(error)
    assert.match(message, /sessionController/)
    assert.match(message, /required plugin did not activate/)
    console.log(JSON.stringify({ schemaVersion: 1, mode, disabled: 'session-controller', startupRejected: true, errors: { startup: message } }))
    process.exit(0)
  }
  const report = { schemaVersion: 1, mode, profile: 'sdk', node: process.version, patches: patches.map(item => path.basename(item)) }
  report.catalog = await harness.listModels()
  const catalog = report.catalog
  const available = catalog.groups.some(group => group.id === provider && group.models.some(item => item.id === model))
  if (mode === 'keyless') {
    report.sessions = await harness.listSessions(5)
    assert.ok(Array.isArray(report.catalog.groups) && report.catalog.groups.length > 0, '模型目录为空')
    assert.ok(Array.isArray(report.catalog.failures))
    assert.deepEqual(report.sessions, { sessions: [] }, '隔离 home 不应包含用户会话')
    console.log(JSON.stringify({ ...report, catalog: { groups: report.catalog.groups.map(group => ({ id: group.id, models: group.models.map(item => item.id) })), failures: report.catalog.failures } }))
  } else if (mode === 'fault') {
    assert.ok(available, `模型目录没有初始化路由: ${provider}/${model}`)
    const errors = {}
    for (const [operation, invoke] of [
      ['rewind', () => harness.session('missing-session').rewind(1)],
      ['fork', () => harness.forkSession('missing-session', 1)],
    ]) {
      try { await invoke(); assert.fail(`${operation} 在禁用 session-controller 后仍然成功`) }
      catch (error) {
        assert.ok(!(error instanceof assert.AssertionError), `${operation} 缺少预期的服务故障`)
        errors[operation] = error instanceof Error ? error.message : String(error)
      }
    }
    console.log(JSON.stringify({ schemaVersion: 1, mode, disabled: 'session-controller', errors }))
  } else {
    assert.ok(available, `模型目录没有初始化路由: ${provider}/${model}`)
    const sessionId = `b3-${process.pid}`
    const first = await harness.run('Reply with exactly FIRST_B3_OK and do not use tools.', { sessionId, onNotification: notification => events.push(notification) })
    const turnText = turn => turn.events.filter(event => event.type === 'assistant/message').flatMap(event => event.data.message?.content ?? event.data.content ?? []).filter(block => block.type === 'text').map(block => block.text).join('')
    const expectedTurnTexts = mode === 'controlled-mock' ? ['B3_CONTROLLED_OK', 'B3_CONTROLLED_OK', 'B3_CONTROLLED_OK', 'B3_CONTROLLED_OK'] : ['FIRST_B3_OK', 'SECOND_B3_OK', 'QUESTION_B3_OK', null]
    assert.equal(turnText(first), expectedTurnTexts[0], '第一轮模型内容不符合受控响应')
    assert.ok(events.some(event => event.method === 'session.event' || event.type !== undefined), '第一轮必须收到流式 Session 事件')
    const firstHistory = await harness.sessionHistory(sessionId)
    const firstUserMessage = firstHistory.events.find(event => event.type === 'user/message' && event.data.source.kind === 'user')
    assert.ok(Number.isSafeInteger(firstUserMessage?.seq))
    const forkBoundary = firstHistory.events.findLast(event => event.type === 'turn/end')?.seq
    assert.ok(Number.isSafeInteger(forkBoundary))
    const second = await harness.run('Reply with exactly SECOND_B3_OK and do not use tools.', { sessionId })
    assert.equal(turnText(second), expectedTurnTexts[1], '第二轮模型内容不符合受控响应')
    const beforeRewind = await harness.sessionHistory(sessionId)
    const secondUserMessage = beforeRewind.events.find(event => event.type === 'user/message' && event.data.source.kind === 'user' && event.seq > firstUserMessage.seq)
    assert.ok(Number.isSafeInteger(secondUserMessage?.seq))
    const forked = await harness.forkSession(sessionId, forkBoundary)
    const forkHistory = await harness.sessionHistory(forked)
    const forkPrefix = firstHistory.events.filter(event => event.seq <= forkBoundary)
    assert.ok(forkPrefix.some(event => event.seq === forkBoundary && event.type === 'turn/end'))
    assert.deepEqual(forkHistory.events.slice(0, forkPrefix.length).map(event => [event.seq, event.type]), forkPrefix.map(event => [event.seq, event.type]), 'fork 必须保留边界内的精确历史前缀')
    const forkAppendedEvents = forkHistory.events.filter(event => event.seq > forkBoundary)
    const secondInput = beforeRewind.events.find(event => event.type === 'user/message' && event.seq > forkBoundary)
    assert.ok(secondInput && !forkHistory.events.some(event => event.seq === secondInput.seq && event.type === secondInput.type), 'fork 不得包含 fork 之后的第二轮用户输入')
    assert.ok(forkAppendedEvents.every(event => ['session/end-seed', 'session/title', 'session/title-updated'].includes(event.type)), `fork 只允许分支恢复标记和标题事件: ${JSON.stringify(forkAppendedEvents.map(event => ({ seq: event.seq, type: event.type })))}`)
    const boundary = firstUserMessage.seq
    await harness.session(sessionId).rewind(boundary)
    const afterRewind = await harness.sessionHistory(sessionId)
    const retainedPrefix = beforeRewind.events.filter(event => event.seq < boundary).map(event => [event.seq, event.type])
    assert.deepEqual(afterRewind.events.slice(0, retainedPrefix.length).map(event => [event.seq, event.type]), retainedPrefix, 'rewind 必须保留精确历史前缀')
    assert.ok(afterRewind.events.every(event => event.seq < boundary || ['step/end', 'turn/end', 'session/end-seed', 'model/selection'].includes(event.type)), 'rewind 不得保留被撤销的轮次内容')
    const removedUserText = firstUserMessage.data.content.filter(block => block.type === 'text').map(block => block.text).join('')
    assert.ok(!afterRewind.events.some(event => event.type === 'user/message' && event.data.content.some(block => block.type === 'text' && block.text === removedUserText)))
    assert.ok(!afterRewind.events.some(event => event.seq === secondUserMessage.seq && event.type === 'user/message'))
    const third = await harness.run('Use ask_user_question exactly once to ask whether to leave files unchanged. After the answer, reply exactly QUESTION_B3_OK. Do not modify files or use other tools.', { sessionId })
    assert.equal(turnText(third), expectedTurnTexts[2], '提问后的模型内容不符合受控响应')
    assert.ok(questions.length > 0, `模型轮次没有触发 user-question/ask: ${JSON.stringify(mockServer?.requests.map(item => ({ behavior: item.behavior, outcome: item.outcome })))}`)
    assert.equal(questions.length, 1)
    const listed = await harness.listSessions(20)
    assert.ok(listed.sessions.some(item => item.id === sessionId))
    assert.ok(listed.sessions.some(item => item.id === forked))
    await harness.close()
    const { harness: restored } = harnessFor('staged SDK resume')
    let fourth
    try {
      const resumed = await restored.resumeSession(sessionId)
      assert.equal(resumed.id, sessionId)
      const restoredHistory = await restored.sessionHistory(sessionId)
      const resumedUserText = restoredHistory.events.filter(event => event.type === 'user/message' && event.data.source.kind === 'user').flatMap(event => event.data.content).filter(block => block.type === 'text').map(block => block.text)
      assert.ok(!resumedUserText.includes(removedUserText), '重启后不得恢复被 rewind 的第一轮输入')
      assert.ok(!resumedUserText.includes('Reply with exactly SECOND_B3_OK and do not use tools.'), '重启后不得恢复被 rewind 的第二轮输入')
      assert.ok(resumedUserText.some(text => text.includes('Use ask_user_question exactly once')), '重启后必须保留 rewind 后的提问轮')
      assert.ok(restoredHistory.events.some(event => event.type === 'tool/call' && event.data.name === 'ask_user_question'), '重启后必须保留原生提问工具调用')
      const questionCall = restoredHistory.events.find(event => event.type === 'tool/call' && event.data.name === 'ask_user_question')
      const questionResult = restoredHistory.events.find(event => event.type === 'tool/result' && event.data.message.toolCallId === questionCall?.data.callId)
      assert.equal(questionResult?.data.message.isError, false, '重启后必须保留成功的提问回答')
      assert.ok(questionResult.data.message.content.some(block => block.type === 'text' && block.text.includes('B3 controlled answer')))
      fourth = await resumed.run('Continue the restored session without modifying files.')
      assert.equal(fourth.finishReason, 'completed')
      if (expectedTurnTexts[3] !== null) assert.equal(turnText(fourth), expectedTurnTexts[3], '恢复后的模型内容不符合受控响应')
      const continuedHistory = await restored.sessionHistory(sessionId)
      assert.ok(continuedHistory.events.length > afterRewind.events.length)
    } finally { await restored.close() }
    assert.deepEqual([first, second, third, fourth].map(turn => turn.finishReason), ['completed', 'completed', 'completed', 'completed'])
    Object.assign(report, { turns: [first, second, third, fourth].map(item => ({ sessionId: item.sessionId, finishReason: item.finishReason, eventCount: item.events.length })), boundary, forkBoundary, beforeRewind: beforeRewind.events.length, afterRewind: afterRewind.events.length, forked, forkEvents: forkHistory.events.length, questions, listed: listed.sessions.map(item => item.id), resumed: true, resumedTurn: true, eventCount: events.length })
    if (mockServer) {
      assert.equal(mockServer.requests.length, 5, '受控脚本必须完整消费五个模型请求')
      const finalRequest = JSON.stringify(mockServer.requests.at(-1)?.body)
      assert.ok(!finalRequest.includes(removedUserText) && !finalRequest.includes('SECOND_B3_OK'), '恢复后的模型请求不得包含已 rewind 的输入')
      assert.ok(finalRequest.includes('ask_user_question') && finalRequest.includes('Continue the restored session'), '恢复后的模型请求必须包含保留的提问轮和新输入')
      report.mock = { origin: 'loopback', requestCount: mockServer.requests.length, outcomes: mockServer.requests.map(item => item.outcome), questionToolCalls: mockServer.requests.filter(item => item.behavior === 'tool_call_success').length, restoredRequestPurgedRewind: true, restoredRequestIncludesQuestion: true }
      await mockServer.close()
    }
    console.log(JSON.stringify(report))
  }
} finally { await harness.close() }
