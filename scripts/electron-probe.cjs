const WebSocket = require('ws')

async function main() {
  const targets = await (await fetch('http://127.0.0.1:9333/json/list')).json()
  const ws = new WebSocket(targets[0].webSocketDebuggerUrl)
  await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject) })
  const expression = `(async () => {
    console.log('electron probe: importing runtime')
    const { createHarness, developmentRepository } = await import('file:///home/shang/python/%E6%B6%8C%E7%8E%B0/vscode-coding-agent/out/runtime.js')
    console.log('electron probe: creating harness', process.execPath, process.versions.electron)
    const harness = createHarness({ dshRepository: developmentRepository(), dshHome: '/home/shang/python/涌现/.dsh-dev', cwd: '/home/shang/python/涌现/stage0-fixture', provider: 'deepseek-account', model: 'deepseek-flash' })
    try {
      harness.client.start()
      harness.client.onRequest(async () => ({ outcome: 'rejected' }))
      await harness.start()
      console.log('electron probe: initialized')
      const result = await harness.run('Reply exactly: VS Code Electron Node OK. Do not use tools.')
      console.log('electron probe: finished', result.finalResponse)
      return { electron: process.versions.electron, response: result.finalResponse, finishReason: result.finishReason }
    } finally { await harness.close() }
  })()`
  const result = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Probe timeout')), 45000)
    ws.on('message', raw => {
      const message = JSON.parse(raw)
      if (message.id !== 1) return
      clearTimeout(timer)
      resolve(message)
    })
    ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression: `console.log('CDP probe', typeof require, typeof globalThis.require, process.execPath); ({electron: process.versions.electron})`, returnByValue: true, includeCommandLineAPI: true } }))
  })
  console.log(JSON.stringify(result, null, 2))
  ws.close()
}
main().catch(error => { console.error(error); process.exitCode = 1 })
