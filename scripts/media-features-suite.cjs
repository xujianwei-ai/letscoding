const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

/** Drive the real media/webview.js under linkedom and verify the three media
 * features (image input, image output, HTML preview) end to end at the
 * Webview boundary, without needing a model. */
async function run() {
  const { parseHTML, Event } = require('linkedom')
  const source = fs.readFileSync(path.resolve(__dirname, '../src/extension.ts'), 'utf8')
  const body = source.slice(source.indexOf('<body>'), source.indexOf('</body>') + 7)
    .replace(/\$\{iconUri\}/g, 'agent.svg').replace(/\$\{scriptUri\}/g, 'webview.js')
  const markup = `<!DOCTYPE html><html><head><title>Coding Agent</title></head>${body}</html>`
  const { document } = parseHTML(markup)
  document.defaultView.HTMLElement.prototype.scrollIntoView = () => {}
  document.defaultView.HTMLElement.prototype.focus = function () {}
  const posted = []
  const conversation = document.getElementById('conversation')
  conversation.clientHeight = 400
  conversation.scrollHeight = 400
  conversation.scrollTop = 0

  // Minimal FileReader that immediately resolves a fixed data URL.
  class FakeFileReader {
    readAsDataURL() { this.result = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='; this.onload?.() }
  }
  const context = {
    document, window: document.defaultView, console,
    acquireVsCodeApi: () => ({ postMessage: message => posted.push(message) }),
    setTimeout, clearTimeout, Event, URL, FileReader: FakeFileReader,
    confirm: () => true,
    requestAnimationFrame: cb => setTimeout(cb, 0),
    cancelAnimationFrame: clearTimeout,
  }
  context.globalThis = context
  vm.createContext(context)
  vm.runInContext(fs.readFileSync(path.resolve(__dirname, '../media/webview.js'), 'utf8'), context)
  const window = document.defaultView
  const input = document.getElementById('input')
  const send = document.getElementById('send')
  input.setSelectionRange = (s, e) => { input.selectionStart = s; input.selectionEnd = e }
  input.focus = () => {}
  const message = data => { const e = new Event('message'); e.data = data; window.dispatchEvent(e) }

  // Establish trusted, model-ready shell so send is enabled.
  message({ type: 'workspaceTrust', trusted: true })
  message({ type: 'modelCatalog', catalog: { groups: [{ id: 'deepseek-account', name: 'DeepSeek', models: [{ id: 'deepseek-flash', name: 'Flash' }] }], failures: [] } })
  message({ type: 'modelCatalogStatus', status: 'ready' })
  assert.equal(send.disabled, false, 'composer enabled for a trusted workspace')

  // ── 1. Image input via paste ─────────────────────────────────────────────
  const pngFile = { type: 'image/png', size: 100, name: 'shot.png' }
  const pasteEvent = new Event('paste')
  pasteEvent.clipboardData = { items: [{ type: 'image/png', getAsFile: () => pngFile }] }
  pasteEvent.preventDefault = () => { pasteEvent.defaultPrevented = true }
  input.dispatchEvent(pasteEvent)
  await new Promise(r => setTimeout(r, 10)) // FileReader resolves async
  const chips = document.querySelectorAll('#image-chips .image-chip')
  assert.equal(chips.length, 1, 'paste produces one image chip')
  assert.ok(chips[0].querySelector('img').src.startsWith('data:image/png;base64,'), 'chip shows a base64 thumbnail')

  // remove button clears the single chip
  chips[0].querySelector('button').click()
  assert.equal(document.querySelectorAll('#image-chips .image-chip').length, 0, 'chip remove button deletes the attachment')

  // re-add two images and send; postMessage must carry attachments
  input.dispatchEvent(pasteEvent)
  await new Promise(r => setTimeout(r, 10))
  input.dispatchEvent(pasteEvent)
  await new Promise(r => setTimeout(r, 10))
  assert.equal(document.querySelectorAll('#image-chips .image-chip').length, 2, 'two images queued')
  input.value = 'describe these'
  posted.length = 0
  send.click()
  const sent = posted.find(m => m.type === 'send')
  assert.ok(sent, 'send message posted')
  assert.equal(sent.attachments.length, 2, 'attachments ride along with the send')
  assert.ok(sent.attachments.every(a => a.type === 'image' && typeof a.data === 'string' && a.data.length > 0), 'attachments carry base64 data')
  assert.equal(sent.text, 'describe these')
  message({ type: 'busy', busy: false })
  console.log('PASS image input: paste → chips → remove → send with attachments')

  // ── 2. Image output rendering ────────────────────────────────────────────
  const dataImg = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='
  message({ type: 'assistant', text: `Here is the diagram:\n\n![arch](${dataImg})\n\nAnd a remote one: ![r](https://example.com/x.png)\n\nUnsafe: ![bad](file:///etc/passwd)` })
  await new Promise(r => setTimeout(r, 10))
  const assistantEl = [...document.querySelectorAll('.assistant')].at(-1)
  const renderedImgs = assistantEl.querySelectorAll('img.chat-image')
  assert.equal(renderedImgs.length, 2, 'only safe image sources render (data: and https:)')
  assert.ok([...renderedImgs].every(i => i.src.startsWith('data:image/') || i.src.startsWith('https://')), 'file: scheme is not rendered')
  // click zoom overlay
  renderedImgs[0].click()
  const zoom = document.querySelector('div[style*="z-index:10000"] img')
  assert.ok(zoom, 'clicking a chat image opens the zoom overlay')
  assert.equal(zoom.src, dataImg)
  zoom.parentElement.click() // overlay click closes
  await new Promise(r => setTimeout(r, 5))
  assert.equal(document.querySelector('div[style*="z-index:10000"]'), null, 'overlay click closes the zoom')
  console.log('PASS image output: markdown/data images render, unsafe schemes blocked, zoom works')

  // ── 3. HTML preview ──────────────────────────────────────────────────────
  message({ type: 'cleared' }) // isolate from the image-output assistant bubbles
  const htmlSnippet = '<h1>Hello</h1><p>world</p>'
  message({ type: 'assistant', text: `Try this:\n\n\`\`\`html\n${htmlSnippet}\n\`\`\`\n\nDone.` })
  await new Promise(r => setTimeout(r, 10))
  const htmlAssistant = [...document.querySelectorAll('.assistant')].at(-1)
  const previewBtn = htmlAssistant.querySelector('.html-preview-btn')
  assert.ok(previewBtn, 'HTML code block exposes a preview button')
  assert.equal(previewBtn.textContent, '预览')
  assert.ok(htmlAssistant.querySelector('.html-code-block'), 'renders a titled code-block card')
  previewBtn.click()
  const iframe = document.querySelector('iframe')
  assert.ok(iframe, 'preview opens an iframe')
  assert.equal(iframe.sandbox, 'allow-scripts', 'iframe is sandboxed to allow-scripts only')
  assert.ok(iframe.srcdoc.includes(htmlSnippet), 'srcdoc embeds the HTML source')
  // close via the × button (header button) or overlay click
  const modal = iframe.closest('div[style*="position:fixed"]') || iframe.parentElement.parentElement
  const closeBtn = [...modal.querySelectorAll('button')].find(b => b !== previewBtn && /×|✕|close/i.test(b.textContent)) 
  if (closeBtn) closeBtn.click(); else modal.click()
  await new Promise(r => setTimeout(r, 5))
  assert.equal(document.querySelector('iframe'), null, 'preview closes')
  console.log('PASS html preview: code block card → sandboxed iframe → close')

  console.log('All media feature checks passed')
}

if (require.main === module) void run().catch(error => { console.error(error); process.exitCode = 1 })
module.exports = { run }
