const assert = require('node:assert/strict')
const { spawn } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')
const { readJson, root, sha256 } = require('./runtime-closure.cjs')

const config = readJson(path.join(root, 'config/runtime-baseline.json'))
const staging = path.join(root, config.dsh.productionClosure.stagingDirectory)
const node = path.join(root, '.runtime-build/node/bin/node')
const networkSource = fs.readFileSync(path.join(root, 'src/runtime.ts'), 'utf8')
const networkFunctions = networkSource.slice(networkSource.indexOf('const PROXY_ENV_NAMES = '), networkSource.indexOf('/** A cached Host'))
const questionFixture = String.raw`const write = value => process.stdout.write(JSON.stringify(value) + '\n')
const pending = new Map()
let serial = 0
process.stdin.setEncoding('utf8')
let input = ''
process.stdin.on('data', chunk => {
  input += chunk
  while (input.includes('\n')) {
    const index = input.indexOf('\n')
    const line = input.slice(0, index)
    input = input.slice(index + 1)
    if (line.trim()) receive(JSON.parse(line))
  }
})
function receive(frame) {
  if (frame.id !== undefined && frame.method === undefined) {
    const callback = pending.get(frame.id)
    pending.delete(frame.id)
    if (frame.error) callback?.reject(new Error(frame.error.message))
    else callback?.resolve(frame.result)
    return
  }
  if (frame.method === 'initialize') {
    write({ id: frame.id, result: { serverInfo: { name: 'b3-question-fixture', version: '1' } } })
  } else if (frame.method === 'test/question') {
    const id = 'host-' + String(++serial)
    pending.set(id, { resolve: answer => write({ id: frame.id, result: { answer, error: null } }), reject: error => write({ id: frame.id, result: { answer: null, error: { message: error.message } } }) })
    write({ id, method: 'user-question/ask', params: { requestId: frame.params.requestId ?? id, sessionId: 'main', questions: [{ id: 'format', question: 'Leave files unchanged?', options: [{ label: 'Yes', value: 'yes' }] }] } })
  } else if (frame.method === 'test/cancel') {
    write({ method: 'user-question.cancelled', params: { requestId: frame.params.requestId, sessionId: 'main' } })
    write({ id: frame.id, result: {} })
  } else if (frame.method === 'test/late-answer') {
    const callback = pending.get(frame.params.requestId)
    if (callback) callback.resolve({ answers: [{ id: 'format', selected: ['late answer must be ignored'] }] })
    write({ id: frame.id, result: { answer: null } })
  } else if (frame.method === 'shutdown') {
    write({ id: frame.id, result: {} })
    process.exit(0)
  } else {
    write({ id: frame.id, error: { code: -32601, message: 'Unknown method' } })
  }
}
`

function report(mode, mock) {
  return new Promise((resolve, reject) => {
    const work = path.join(root, '.runtime-build/sdk-tmp', `${mode}-${process.pid}`)
    fs.mkdirSync(work, { recursive: true })
    const helper = path.join(staging, '.sdk-probe')
    fs.mkdirSync(helper, { recursive: true })
    fs.writeFileSync(path.join(helper, 'network.ts'), `export ${networkFunctions}`)
    fs.writeFileSync(path.join(helper, 'question-fixture.mjs'), questionFixture)
    const child = spawn(node, [path.join(root, 'scripts/runtime-sdk-probe.mjs')], {
      cwd: staging,
      env: {
        PATH: process.env.PATH,
        HOME: work,
        DSH_HOME: path.join(work, 'home'),
        DEEPSEEK_API_KEY: mode === 'controlled' ? process.env.DSH_TEST_API_KEY : mode === 'keyless' ? 'b3-non-routable-offline-probe' : undefined,
        DSH_PROBE_PROVIDER: mode === 'controlled-mock' ? 'deepseek-official' : mode === 'controlled' ? process.env.DSH_TEST_PROVIDER ?? 'deepseek-official' : undefined,
        DSH_PROBE_CREDENTIAL_SOURCE: mode === 'controlled' ? process.env.DSH_TEST_CREDENTIAL_SOURCE : undefined,
        DSH_PROBE_MODEL: mode === 'controlled' ? 'deepseek-flash' : undefined,
        DSH_RUNTIME_ROOT: staging,
        DSH_PROBE_HOME: path.join(work, 'home'),
        DSH_PROBE_WORKSPACE: path.join(work, 'workspace'),
        DSH_PROBE_NODE: node,
        DSH_PROBE_MODE: mode,
        DSH_PROBE_MOCK_SERVER: mode === 'controlled-mock' ? mock.path : undefined,
        DSH_PROBE_MOCK_EXPECTED: mode === 'controlled-mock' ? mock.path : undefined,
        DSH_PROBE_MOCK_SHA256: mode === 'controlled-mock' ? mock.sha256 : undefined,
        DSH_PROBE_DISABLE_CONTROLLER: mode === 'fault' ? '1' : undefined,
      },
      encoding: 'utf8',
    })
    let stdout = ''
    let stderr = ''
    const timeout = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`${mode} SDK probe timed out: ${stderr}`)) }, 180000)
    child.stdout.on('data', chunk => { stdout += chunk })
    child.stderr.on('data', chunk => { stderr += chunk })
    child.on('error', reject)
    child.on('close', code => {
      clearTimeout(timeout)
      if (code !== 0) {
        const detail = (stderr || stdout).replaceAll(root, '<extension>').replaceAll(work, '<isolated>')
        reject(new Error(`${mode} SDK probe failed (${code}): ${detail}`))
        return
      }
      try {
        const parsed = JSON.parse(stdout)
        if (parsed.mock) parsed.mock.helperSha256 = mock.sha256
        fs.mkdirSync(path.join(root, 'build'), { recursive: true })
        fs.writeFileSync(path.join(root, `build/runtime-sdk-${mode}-report.json`), JSON.stringify({ ...parsed, nodeSha256: sha256(fs.readFileSync(node)), isolatedHome: 'temporary', workspace: 'temporary' }, null, 2) + '\n')
        resolve(parsed)
      } catch (error) { reject(error) }
    })
  })
}

async function main() {
  const allowedFlags = new Set(['--controlled', '--controlled-mock'])
  assert.ok(process.argv.slice(2).every(flag => allowedFlags.has(flag)), `未知 runtime:sdk 参数: ${process.argv.slice(2).join(' ')}`)
  if (process.argv.includes('--controlled')) {
    assert.ok(process.env.DSH_TEST_API_KEY || process.env.DSH_TEST_CREDENTIAL_SOURCE, 'controlled 模式必须显式提供 DSH_TEST_API_KEY 或 DSH_TEST_CREDENTIAL_SOURCE')
    if (process.env.DSH_TEST_CREDENTIAL_SOURCE !== undefined) {
      assert.equal(process.env.DSH_TEST_PROVIDER ?? 'deepseek-official', 'deepseek-account', '账户凭据源只能配合 deepseek-account 路由')
      assert.ok(process.env.DSH_TEST_API_KEY === undefined, '账户凭据源不得与 API key 混用')
    }
  }
  const baseline = readJson(path.join(root, 'build/runtime-baseline.json'))
  const mockServer = path.join(baseline.dsh.repository, 'packages/test-support/llm-mock-server/lib/index.js')
  const mockSha256 = sha256(fs.readFileSync(mockServer))
  const closure = readJson(path.join(root, 'build/dsh-production-closure.json'))
  assert.equal(closure.status, 'artifact-inventory-complete')
  try {
    const keyless = await report('keyless')
    assert.equal(keyless.node, 'v24.9.0')
    const protocol = await report('question-protocol')
    assert.equal(protocol.signalAborted, true)
    const fault = await report('fault')
    const controlledMock = process.argv.includes('--controlled-mock') ? await report('controlled-mock', { path: mockServer, sha256: mockSha256 }) : undefined
    assert.ok(!process.argv.includes('--controlled-mock') || controlledMock?.mock?.requestCount === 5)
    const controlled = process.argv.includes('--controlled')
      ? await report('controlled')
      : { status: 'not-run', reason: '需显式 --controlled，以及 DSH_TEST_API_KEY 或 DSH_TEST_CREDENTIAL_SOURCE；不会自行发现账户凭据。' }
    console.log(JSON.stringify({ schemaVersion: 1, node: keyless.node, modelGroups: keyless.catalog.groups.map(group => group.id), isolatedSessions: keyless.sessions.sessions.length, questionCancellation: protocol, fault, controlledMock, controlled }))
    console.log(`Runtime SDK: staged Node/profile/model catalog/session catalog/question cancellation/missing-controller failures passed${controlledMock ? '; local controlled turns/history/fork/rewind/question/resume passed' : ''}`)
  } finally {
    fs.rmSync(path.join(root, '.runtime-build/sdk-tmp'), { recursive: true, force: true })
    fs.rmSync(path.join(staging, '.sdk-probe'), { recursive: true, force: true })
  }
}

if (require.main === module) main().catch(error => { console.error(error.stack); process.exitCode = 1 })
module.exports = { report, main }
