const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

async function run() {
  const { parseHTML, Event } = require('linkedom')
  const source = fs.readFileSync(path.resolve(__dirname, '../src/extension.ts'), 'utf8')
  const body = source.slice(source.indexOf('<body>'), source.indexOf('</body>') + 7)
    .replace(/\$\{iconUri\}/g, 'agent.svg').replace(/\$\{scriptUri\}/g, 'webview.js')
  const markup = `<!DOCTYPE html><html><head><title>Coding Agent</title></head>${body}</html>`
  const { document } = parseHTML(markup)
  document.defaultView.HTMLElement.prototype.scrollIntoView = () => {}
  let focused
  document.defaultView.HTMLElement.prototype.focus = function () {
    focused = this
    Object.defineProperty(document, 'activeElement', { configurable: true, value: this })
  }
  const posted = []
  const conversation = document.getElementById('conversation')
  conversation.clientHeight = 400
  conversation.scrollHeight = 1600
  conversation.scrollTop = 1200
  // linkedom has a read-only native select.value. Adapt it to browser semantics.
  Object.defineProperty(document.defaultView.HTMLSelectElement.prototype, 'value', {
    get() { return this.querySelector('option[selected]')?.value },
    set(value) {
      for (const option of this.options) {
        if (option.value === value) option.setAttribute('selected', '')
        else option.removeAttribute('selected')
      }
    },
  })
  const context = {
    document, window: document.defaultView, console,
    acquireVsCodeApi: () => ({ postMessage: message => posted.push(message) }),
    setTimeout, clearTimeout, Event, URL,
    confirm: () => true,
    requestAnimationFrame: callback => setTimeout(callback, 0),
    cancelAnimationFrame: clearTimeout,
  }
  context.globalThis = context
  vm.createContext(context)
  vm.runInContext(fs.readFileSync(path.resolve(__dirname, '../media/webview.js'), 'utf8'), context)
  const window = document.defaultView
  const send = document.getElementById('send')
  const permission = document.getElementById('permissionMode')
  const input = document.getElementById('input')
  input.setSelectionRange = (start, end) => { input.selectionStart = start; input.selectionEnd = end }
  input.focus = () => {}
  const message = data => {
    const event = new Event('message')
    event.data = data
    window.dispatchEvent(event)
  }
  assert.equal(posted.filter(item => item.type === 'ready').length, 1, 'The shell delegates trusted initialization to the extension')
  message({ type: 'workspaceTrust', trusted: false })
  assert.equal(document.getElementById('workspace-trust').hidden, false)
  assert.ok(source.includes('.workspace-trust-copy') && source.includes('#trust-workspace { flex: 0 0 auto; margin-left: auto;'), 'Trust guidance keeps the action at the trailing edge')
  assert.ok(send.disabled && input.disabled && permission.disabled && document.getElementById('model').disabled)
  const trustWorkspace = document.getElementById('trust-workspace')
  trustWorkspace.click()
  trustWorkspace.click()
  assert.equal(posted.filter(item => item.type === 'manageTrust').length, 1, 'Repeated clicks share one trust dialog')
  assert.ok(trustWorkspace.textContent.includes('等待'))
  message({ type: 'workspaceTrust', trusted: false })
  assert.equal(trustWorkspace.textContent, '信任此工作区', 'Cancelling the dialog resets the trust action')
  message({ type: 'workspaceTrust', trusted: true })
  assert.equal(document.getElementById('workspace-trust').hidden, true)
  assert.ok(!send.disabled && !input.disabled && !permission.disabled && !document.getElementById('model').disabled)
  input.value = 'first prompt'
  message({ type: 'workspaceTrust', trusted: true })
  send.click()
  assert.ok(!send.disabled && permission.disabled && input.value === '')
  assert.ok(send.classList.contains('stopping'))
  send.click()
  assert.equal(posted.filter(message => message.type === 'stop').length, 1)
  assert.ok(send.disabled)
  message({ type: 'busy', busy: false })
  conversation.scrollHeight = 1600
  conversation.scrollTop = 1200
  message({ type: 'assistantDelta', text: '流式第一段；' })
  await new Promise(resolve => setTimeout(resolve, 70))
  assert.equal(document.querySelector('.assistant').textContent, '流式第一段；', 'Deltas render before the final message')
  assert.equal(conversation.scrollTop, 1600, 'Streaming follows the conversation bottom')
  conversation.scrollTop = 300
  conversation.dispatchEvent(new Event('scroll'))
  message({ type: 'assistantDelta', text: '第二段。' })
  await new Promise(resolve => setTimeout(resolve, 70))
  assert.equal(document.querySelector('.assistant').textContent, '流式第一段；第二段。')
  assert.equal(conversation.scrollTop, 300, 'Reading history pauses output following')
  conversation.scrollTop = 1200
  conversation.dispatchEvent(new Event('scroll'))
  message({ type: 'assistantDelta', text: '恢复跟随。' })
  await new Promise(resolve => setTimeout(resolve, 70))
  assert.equal(conversation.scrollTop, 1600, 'Returning to the bottom resumes output following')
  const streamedReply = document.querySelector('.assistant')
  const streamedText = streamedReply.querySelector('.assistant-text')
  const stableTextNode = streamedText.firstChild
  assert.ok(streamedReply.classList.contains('streaming'), 'Growing replies opt out of skipped-content rendering')
  message({ type: 'assistantDelta', text: '**稳定节点**' })
  await new Promise(resolve => setTimeout(resolve, 70))
  assert.equal(streamedText.firstChild, stableTextNode, 'Streaming appends one text node instead of replacing the Markdown DOM')
  assert.equal(streamedText.querySelector('strong'), null, 'Incomplete Markdown stays plain while tokens arrive')
  message({ type: 'assistantReasoning', text: '开始下一段分析' })
  assert.ok(streamedText.querySelector('strong'), 'A process boundary renders the completed streamed segment once')
  assert.equal(streamedReply.classList.contains('streaming'), false)
  assert.ok(!document.querySelector('.assistant').textContent.includes('undefined'), 'Streaming boundaries never expose internal state')

  // ── Incremental streaming: completed blocks render live, tail stays plain ──
  message({ type: 'cleared' })
  conversation.getBoundingClientRect = () => ({ top: 100, height: 400 })
  message({ type: 'assistantDelta', text: '# 标题\n\n第一段正文。\n\n```js\nconst x = 1;\n```\n\n第二段' })
  await new Promise(resolve => setTimeout(resolve, 70))
  const liveBubble = document.querySelector('.assistant.streaming')
  assert.ok(liveBubble, 'Streaming bubble has .streaming class')
  const settledBlocks = liveBubble.querySelectorAll('.stream-settled')
  assert.ok(settledBlocks.length >= 1, 'Completed prefix renders into settled nodes')
  assert.ok(liveBubble.querySelector('h1'), 'Heading renders as <h1> during stream')
  assert.ok(liveBubble.querySelector('.code-block-wrapper'), 'Code block renders as code wrapper during stream')
  assert.ok(!liveBubble.querySelector('.stream-settled:last-of-type')?.textContent?.includes('第二段'), 'Unclosed tail stays as plain text')
  const tailNode = [...liveBubble.querySelector('.assistant-text').childNodes].find(n => n.nodeType === 3)
  assert.ok(tailNode && tailNode.textContent.includes('第二段'), 'Tail remains as a plain text node')
  message({ type: 'assistantDelta', text: '继续输出。\n\n' })
  await new Promise(resolve => setTimeout(resolve, 70))
  assert.ok(liveBubble.querySelector('.stream-settled:last-of-type')?.textContent?.includes('第二段'), 'Tail renders once it becomes safe')
  message({ type: 'busy', busy: false })
  message({ type: 'cleared' })
  conversation.getBoundingClientRect = () => ({ top: 100, height: 400 })
  message({ type: 'assistantReasoning', text: '第一步：阅读相关源码\n第二步：分析调用链' })
  await new Promise(resolve => setTimeout(resolve, 70))
  const reasoningCard = document.querySelector('.reasoning-card')
  assert.ok(reasoningCard, 'Reasoning card is rendered')
  assert.equal(reasoningCard.open, false, 'Reasoning stays collapsed while streaming to avoid layout flicker')
  assert.equal(reasoningCard.querySelector('summary').textContent, '思考过程')
  assert.equal(reasoningCard.querySelector('.reasoning-body').textContent, '第一步：阅读相关源码\n第二步：分析调用链')
  message({ type: 'cleared' })
  assert.equal(document.querySelectorAll('.reasoning-card').length, 0, 'Clear resets reasoning cards')
  message({ type: 'modelCatalog', catalog: { groups: [{ id: 'deepseek-account', name: 'DeepSeek', models: [{ id: 'deepseek-flash', name: 'DeepSeek Flash' }] }, { id: 'kimi-coding', name: 'Kimi', models: [{ id: 'k3.1-pro', name: 'Kimi Pro' }] }], failures: [] } })
  const catalogModel = document.getElementById('model')
  catalogModel.dispatchEvent(new Event('click'))
  catalogModel.dispatchEvent(new Event('click'))
  assert.equal(posted.filter(item => item.type === 'modelCatalog').length, 1, 'Catalog reads ignore duplicate activation while loading')
  message({ type: 'modelCatalogStatus', status: 'ready' })
  message({ type: 'user', text: '第一个问题', seq: 1 })
  message({ type: 'workspaceTrust', trusted: false })
  assert.equal(document.querySelectorAll('.user').length, 1, 'Changing trust does not discard the current conversation projection')
  assert.equal(document.querySelectorAll('.error').length, 0, 'Restricted Mode guidance is not an operation failure')
  message({ type: 'workspaceTrust', trusted: true })
  const firstPrompt = document.querySelector('.user')
  const sticky = document.getElementById('sticky-prompt')
  const promptRect = (element, naturalTop) => ({ top: naturalTop, height: 60 })
  firstPrompt.getBoundingClientRect = () => promptRect(firstPrompt, -20)
  conversation.dispatchEvent(new Event('scroll'))
  await new Promise(resolve => setTimeout(resolve, 10))
  assert.equal(sticky.classList.contains('visible'), true, 'The current user prompt has a sticky summary')
  assert.equal(sticky.style.top, '6px', 'The summary is fixed at the conversation top inset')
  conversation.scrollTop = 300
  conversation.dispatchEvent(new Event('scroll'))
  message({ type: 'user', text: '第二个问题', seq: 2, checkpointId: 'sticky-checkpoint' })
  const prompts = document.querySelectorAll('.user')
  const secondPrompt = [...prompts].find(element => element.classList?.contains('user') && element.textContent === '第二个问题')
  secondPrompt.getBoundingClientRect = () => promptRect(secondPrompt, 140)
  conversation.dispatchEvent(new Event('scroll'))
  await new Promise(resolve => setTimeout(resolve, 10))
  assert.equal(sticky.style.top, '0px', 'The next prompt naturally replaces the pinned summary')
  secondPrompt.getBoundingClientRect = () => promptRect(secondPrompt, 40)
  conversation.dispatchEvent(new Event('scroll'))
  await new Promise(resolve => setTimeout(resolve, 10))
  assert.equal(sticky.style.top, '6px', 'The new sticky summary stays at the top after replacement')
  const stickyToggle = sticky.querySelector('.prompt-toggle')
  assert.equal(sticky.classList.contains('visible'), true, 'The separate sticky summary follows the active question')
  assert.equal(sticky.textContent.includes('第二个问题'), true)
  sticky.querySelector('.user-collapsed').click()
  assert.equal(sticky.classList.contains('expanded'), false, 'Clicking the summary text opens editing, not reading expansion')
  assert.ok(sticky.querySelector('.history-edit'), 'The sticky summary opens the editor at the top')
  assert.equal(sticky.classList.contains('editing'), true)
  assert.equal(secondPrompt.querySelector('.history-edit'), null, 'Sticky editing leaves the original message unchanged')
  assert.equal(sticky.querySelector('textarea').value, '第二个问题')
  // History model picker: open the flyout and select Kimi
  const stickyModelButton = sticky.querySelector('.history-model')
  stickyModelButton.click()
  const stickyKimiRow = [...sticky.querySelectorAll('.history-model-menu .amo-model-menu-provider')].find(row => row.textContent.includes('Kimi'))
  assert.ok(stickyKimiRow, 'Kimi provider must be visible in the history model menu')
  // Trigger the provider hover to open its submenu
  stickyKimiRow.dispatchEvent(new Event('mouseenter', { bubbles: false }))
  const stickyKimiSubmenu = [...document.querySelectorAll('body > .amo-model-submenu')].at(-1)
  assert.ok(stickyKimiSubmenu, 'Kimi submenu must appear on provider hover')
  const stickyKimiOption = [...stickyKimiSubmenu.querySelectorAll('button')].find(button => button.textContent.includes('Kimi Pro'))
  assert.ok(stickyKimiOption, 'Kimi Pro model option must be visible in the submenu')
  stickyKimiOption.click()
  assert.equal(stickyModelButton.textContent, 'Kimi Pro', 'History model button updates to the selected model')
  sticky.querySelector('textarea').value = '从顶部修改并重新发送'
  sticky.querySelector('.history-send').click()
  const stickyResend = posted.filter(message => message.type === 'resend').at(-1)
  assert.equal(stickyResend.seq, 2)
  assert.equal(stickyResend.hasCheckpoint, true, 'Sticky resend preserves the code checkpoint rollback target')
  assert.equal(stickyResend.text, '从顶部修改并重新发送')
  assert.equal(JSON.stringify(stickyResend.route), JSON.stringify({ provider: 'kimi-coding', model: 'k3.1-pro' }))
  assert.equal(sticky.classList.contains('editing'), false, 'Submitting closes the sticky editor')
  assert.equal(secondPrompt.querySelector('.history-edit'), null, 'The original card remains intact after sticky resend')
  message({ type: 'busy', busy: false })
  await new Promise(resolve => setTimeout(resolve, 10))
  assert.equal(sticky.classList.contains('visible'), true, 'Submitting restores the sticky summary on the next frame')
  sticky.click()
  assert.ok(sticky.querySelector('.history-edit'), 'Blank space in the sticky card opens the same editor')
  conversation.dispatchEvent(new Event('scroll'))
  await new Promise(resolve => setTimeout(resolve, 10))
  assert.ok(sticky.querySelector('.history-edit'), 'Scrolling does not replace the sticky editor while it is focused')
  assert.equal(sticky.classList.contains('visible'), true)
  sticky.querySelector('.cancel').click()
  assert.equal(sticky.classList.contains('editing'), false)
  await new Promise(resolve => setTimeout(resolve, 10))
  assert.equal(sticky.classList.contains('visible'), true, 'Cancel restores the sticky summary without scrolling to history')
  const scrollBeforeExpand = conversation.scrollTop
  stickyToggle.click()
  assert.equal(sticky.classList.contains('expanded'), true, 'Only the top-right icon fully expands the prompt')
  assert.equal(stickyToggle.getAttribute('aria-expanded'), 'true')
  assert.equal(sticky.style.top, '6px', 'The expanded overlay remains anchored at the conversation top')
  assert.equal(conversation.scrollTop, scrollBeforeExpand, 'Expansion never scrolls or resizes the original history')
  stickyToggle.click()
  assert.equal(sticky.classList.contains('expanded'), false, 'The icon collapses the overlay in place')
  assert.equal(conversation.scrollTop, scrollBeforeExpand, 'Collapsing leaves the reading position unchanged')
  secondPrompt.querySelector('.history-toggle').click()
  assert.ok(secondPrompt.querySelector('.history-edit'))
  assert.equal(sticky.classList.contains('visible'), false, 'Editing never leaves a stale summary floating over replies')
  secondPrompt.querySelector('.cancel').click()
  await new Promise(resolve => setTimeout(resolve, 10))
  assert.equal(sticky.classList.contains('visible'), true, 'Closing the editor restores the sticky summary')
  message({ type: 'cleared' })
  message({ type: 'modelConfig', provider: 'deepseek-account', model: 'deepseek-flash', label: 'deepseek-account/deepseek-flash' })
  message({ type: 'modelCatalog', catalog: { groups: [{ id: 'deepseek-account', name: 'DeepSeek', models: [{ id: 'deepseek-flash', name: 'DeepSeek Flash' }] }, { id: 'kimi-coding', name: 'Kimi', models: [{ id: 'k3.1-pro', name: 'Kimi Pro' }] }], failures: [] } })
  const model = document.getElementById('model')
  // Select Kimi via the custom two-level menu: hover the provider row, click the model entry.
  model.click()
  const menu = document.getElementById('model-menu')
  assert.ok(!menu.hidden, 'Model menu must open on click')
  const kimiRow = [...menu.querySelectorAll('.amo-model-menu-provider')].find(row => row.textContent.includes('Kimi'))
  assert.ok(kimiRow, 'Kimi provider must be listed in the model menu')
  kimiRow.dispatchEvent(new Event('mouseenter', { bubbles: false }))
  const kimiSubmenu = [...document.querySelectorAll('body > .amo-model-submenu')].at(-1)
  assert.ok(kimiSubmenu, 'Kimi submenu must appear on provider hover')
  const kimiOption = [...kimiSubmenu.querySelectorAll('button')].find(button => button.textContent.includes('Kimi Pro'))
  assert.ok(kimiOption, 'Kimi Pro model option must be visible in the submenu')
  kimiOption.click()
  assert.equal(posted.at(-1).type, 'modelRoute')
  assert.equal(posted.at(-1).route.provider, 'kimi-coding')
  assert.equal(posted.at(-1).route.model, 'k3.1-pro')
  input.value = 'use the visible model'
  send.click()
  const routedSend = posted.filter(message => message.type === 'send').at(-1)
  assert.equal(routedSend.text, 'use the visible model')
  assert.equal(JSON.stringify(routedSend.route), JSON.stringify({ provider: 'kimi-coding', model: 'k3.1-pro' }))
  message({ type: 'busy', busy: false })
  // Re-select Kimi via the menu again to verify stale catalog handling.
  model.click()
  const menuAgain = document.getElementById('model-menu')
  const kimiRowAgain = [...menuAgain.querySelectorAll('.amo-model-menu-provider')].find(row => row.textContent.includes('Kimi'))
  kimiRowAgain.dispatchEvent(new Event('mouseenter', { bubbles: false }))
  const kimiSubmenuAgain = [...document.querySelectorAll('body > .amo-model-submenu')].at(-1)
  const kimiOptionAgain = [...kimiSubmenuAgain.querySelectorAll('button')].find(button => button.textContent.includes('Kimi Pro'))
  kimiOptionAgain.click()
  assert.equal(posted.at(-1).type, 'modelRoute')
  message({ type: 'modelConfig', provider: 'deepseek-account', model: 'deepseek-flash', label: 'deepseek-account/deepseek-flash' })
  message({ type: 'modelCatalog', catalog: { groups: [{ id: 'deepseek-account', name: 'DeepSeek', models: [{ id: 'deepseek-flash', name: 'DeepSeek Flash' }] }, { id: 'kimi-coding', name: 'Kimi', models: [{ id: 'k3.1-pro', name: 'Kimi Pro' }] }], failures: [] } })
  assert.equal(model.dataset.value, JSON.stringify(['kimi-coding', 'k3.1-pro']), 'A stale directory response must not reset a newer user choice')
  const failedSelectionId = posted.at(-1).selectionId
  message({ type: 'modelConfig', provider: 'deepseek-account', model: 'deepseek-flash', label: 'deepseek-account/deepseek-flash', selectionId: failedSelectionId })
  assert.equal(model.dataset.value, JSON.stringify(['deepseek-account', 'deepseek-flash']), 'Failed model selection restores the effective route')
  assert.ok(!send.disabled && !document.getElementById('session-select').disabled
    && !document.getElementById('model').disabled && !document.getElementById('refresh-sessions').disabled)
  assert.equal(posted.filter(message => message.type === 'send').length, 2)
  const picker = document.getElementById('session-select')
  message({ type: 'sessionList', sessions: [], activeSessionId: '' })
  picker.click()
  assert.equal(picker.getAttribute('aria-expanded'), 'true')
  assert.ok(!document.getElementById('session-menu').hidden)
  assert.equal(document.querySelector('.session-empty').textContent, '暂无历史会话')
  message({ type: 'sessionList', sessions: [
    { id: 'session-one', title: 'first chat', cwd: '/workspace', createdAt: 1, updatedAt: 2 },
    { id: 'session-two', title: 'second chat', cwd: '/workspace', createdAt: 1, updatedAt: 3 },
  ], activeSessionId: 'session-one' })
  assert.equal(document.querySelectorAll('.session-row').length, 2)
  assert.equal(picker.textContent, 'first chat')
  const sessionKeydown = key => {
    const event = new window.Event('keydown', { bubbles: true, cancelable: true })
    event.key = key
    document.dispatchEvent(event)
  }
  picker.click()
  sessionKeydown('ArrowDown')
  assert.equal(focused?.getAttribute('aria-label'), 'second chat')
  sessionKeydown('Home')
  assert.equal(focused?.getAttribute('aria-label'), 'first chat')
  sessionKeydown('End')
  assert.equal(focused?.getAttribute('aria-label'), 'second chat')
  const remove = document.querySelector('.session-delete')
  assert.equal(remove.getAttribute('aria-label'), '删除会话：first chat')
  remove.click()
  assert.equal(posted.at(-1).type, 'sessionDelete')
  assert.equal(posted.at(-1).sessionId, 'session-one')
  assert.equal(posted.filter(message => message.type === 'sessionSelect').length, 0, 'Delete must not select the row')
  assert.equal(posted.at(-1).session.id, 'session-one')
  assert.equal(document.querySelectorAll('.session-row').length, 1, 'Row must be removed immediately')
  assert.equal(document.getElementById('session-menu').hidden, false, 'Deletion must keep the menu open')
  assert.equal(picker.textContent, '新会话')
  assert.equal(picker.disabled, false, 'Deletion must not disable the picker')
  message({ type: 'sessionList', sessions: [
    { id: 'session-one', title: 'first chat', cwd: '/workspace', createdAt: 1, updatedAt: 2 },
    { id: 'session-two', title: 'second chat', cwd: '/workspace', createdAt: 1, updatedAt: 3 },
  ], activeSessionId: 'session-one' })
  assert.equal(document.querySelectorAll('.session-row').length, 1, 'Stale refresh must not resurrect a deleting Session')
  assert.equal(picker.textContent, '新会话')
  message({ type: 'sessionDeleted', sessionId: 'session-one', activeSessionId: '' })
  message({ type: 'cleared' })
  message({ type: 'sessionList', sessions: [{ id: 'session-two', title: 'second chat', cwd: '/workspace', createdAt: 1, updatedAt: 3 }], activeSessionId: '' })
  message({ type: 'sessionListStatus', status: 'ready' })
  assert.equal(picker.textContent, '新会话')
  assert.equal(picker.disabled, false)
  assert.equal(document.querySelectorAll('.session-row').length, 1)
  // Cleanup remains in progress: the next Session can still be selected immediately.
  document.querySelector('.session-option').click()
  assert.equal(posted.at(-1).type, 'sessionSelect')
  assert.equal(posted.at(-1).sessionId, 'session-two')
  picker.disabled = false
  picker.click()
  document.querySelector('.session-option').click()
  assert.equal(posted.at(-1).type, 'sessionSelect')
  assert.equal(posted.at(-1).sessionId, 'session-two')
  assert.ok(document.getElementById('session-menu').hidden)
  assert.equal(document.getElementById('session-status').textContent, '正在恢复…')
  message({ type: 'sessionList', sessions: [{ id: 'session-two', title: 'second chat', cwd: '/workspace', createdAt: 1, updatedAt: 3 }], activeSessionId: 'session-two' })
  assert.equal(document.getElementById('session-status').textContent, '正在恢复…', 'A list refresh must not complete an in-flight restore')
  message({ type: 'sessionSelected', session: { id: 'session-two' } })
  assert.equal(document.getElementById('session-status').textContent, '已恢复')
  message({ type: 'busy', busy: false })
  assert.ok(!send.disabled && !permission.disabled)
  message({ type: 'tool', callId: 'test', tool: 'bash', arguments: JSON.stringify({ command: 'npm test' }) })
  message({ type: 'toolResult', callId: 'test', text: 'test output', error: true })
  assert.equal(document.querySelector('[data-call-id="test"] .tool-state').textContent, '失败')
  message({ type: 'testResult', callId: 'test', status: 'failed', label: '测试失败 · 退出码 1', details: '1 项失败' })
  assert.equal(document.querySelectorAll('.test-failed').length, 1)
  message({ type: 'verificationReport', report: { status: 'failed', rerunCommand: "python -m unittest 'test_string_utils.TestStringBehaviors.test_truncate'", files: [{ path: 'test_string_utils.py', uri: 'file:///workspace/test_string_utils.py' }], failures: [{ name: 'test_truncate (test_string_utils.TestStringBehaviors.test_truncate)', resolved: false, location: { path: 'test_string_utils.py', uri: 'file:///workspace/test_string_utils.py', line: 12 }, message: 'AssertionError' }], runs: [{ status: 'failed', label: '测试失败', rerunCommand: "python -m unittest 'test_string_utils.TestStringBehaviors.test_truncate'" }] } })
  assert.equal(document.querySelectorAll('.verification-failure').length, 1)
  assert.equal(document.querySelector('.rerun-tests').textContent, '重跑失败测试')
  document.querySelector('.rerun-tests').click()
  assert.equal(posted.at(-1).type, 'rerunTests')
  message({ type: 'tool', callId: 'edit-1', tool: 'edit', arguments: JSON.stringify({ file_path: 'calculator.js', old_string: 'a', new_string: 'b' }) })
  message({ type: 'toolResult', callId: 'edit-1', tool: 'edit', checkpointSeq: 7, text: 'Updated file', error: false })
  const diffButton = document.querySelector('[data-call-id="edit-1"] .tool-group-header .tool-diff')
  assert.ok(diffButton, 'Every successful edit must have a visible Diff button in its collapsed title')
  diffButton.click()
  assert.equal(posted.at(-1).type, 'openDiff')
  assert.equal(posted.at(-1).path, 'calculator.js')
  assert.equal(posted.at(-1).seq, 7)
  assert.ok(document.getElementById('diff-visible'), 'Diff must also be available directly in the top bar')
  document.getElementById('diff-visible').click()
  assert.equal(posted.at(-1).type, 'openDiff')
  message({ type: 'conflict', path: 'calculator.js', text: '未保存修改' })
  assert.equal(document.querySelector('.conflict'), null, 'External edit warnings must not be inserted into chat history')
  input.value = 'read @calc'
  input.setSelectionRange(input.value.length, input.value.length)
  input.dispatchEvent(new window.Event('input', { bubbles: true }))
  message({ type: 'fileList', files: [
    { path: 'calculator.js', uri: 'file:///workspace/calculator.js' },
    { path: 'nested/calculation.js', uri: 'file:///workspace/nested/calculation.js' },
    { path: 'node_modules/calculator.js', uri: 'file:///workspace/node_modules/calculator.js' },
  ] })
  // Dependency exclusion belongs to workspaceFiles(); the UI filters the explicit index it receives.
  assert.equal(document.querySelectorAll('.file-option').length, 3)
  assert.equal(document.querySelector('.file-option .file-name').textContent, 'calculation.js')
  const keydown = key => {
    const event = new Event('keydown', { bubbles: true, cancelable: true })
    event.key = key
    input.dispatchEvent(event)
  }
  keydown('ArrowDown')
  keydown('Enter')
  assert.ok(input.value.includes('@calculator.js '))
  assert.equal(document.querySelector('#input-highlight .file-mention').textContent, '@calculator.js', 'Selected file must be blue in the composer')
  assert.equal(document.querySelector('#input-highlight').textContent, input.value, 'Highlight must preserve the exact input text')
  input.dispatchEvent(new window.Event('scroll'))
  input.value = 'read @nested/calculation.js '
  input.dispatchEvent(new window.Event('input', { bubbles: true }))
  assert.equal(document.querySelector('#input-highlight .file-mention'), null, 'Unselected file text must not be highlighted')
  input.value = 'read @calculator.js '
  input.dispatchEvent(new window.Event('input', { bubbles: true }))
  assert.equal(document.querySelectorAll('#input-highlight .file-mention').length, 1, 'Editing must update mention highlighting')
  input.value = 'read @calculator'
  input.dispatchEvent(new window.Event('input', { bubbles: true }))
  assert.equal(document.querySelector('#input-highlight .file-mention'), null, 'Incomplete file query must not be highlighted')
  input.value = '@calculator.js '
  input.dispatchEvent(new window.Event('input', { bubbles: true }))
  assert.equal(document.querySelectorAll('#input-highlight .file-mention').length, 1, 'Reference at the start must be highlighted')
  message({ type: 'busy', busy: false })
  // New messages without seq must be clickable immediately (using -1 placeholder)
  message({ type: 'user', text: 'new message without seq' })
  const newMsg = document.querySelector('.user')
  assert.ok(newMsg, 'New user message must render')
  newMsg.querySelector('.history-toggle').click()
  assert.ok(newMsg.querySelector('.history-edit'), 'New message without seq must be clickable')
  newMsg.querySelector('.cancel').click()
  // After messageSeq arrives, the placeholder must be updated
  message({ type: 'messageSeq', from: -1, seq: 99 })
  assert.equal(newMsg.dataset.userSeq, '99')
  newMsg.querySelector('.history-toggle').click()
  assert.ok(newMsg.querySelector('.history-edit'), 'Message must remain clickable after seq update')
  newMsg.querySelector('.cancel').click()
  message({ type: 'cleared' })
  message({ type: 'user', seq: 5, checkpointId: 'checkpoint-test', text: 'original historical prompt' })
  const historical = document.querySelector('.user')
  const openHistory = new Event('keydown', { bubbles: true, cancelable: true })
  openHistory.key = 'Enter'
  historical.dispatchEvent(openHistory)
  assert.ok(historical.querySelector('.history-edit'), 'Enter on an original message opens its editor, not the sticky overlay')
  historical.querySelector('.cancel').click()
  historical.querySelector('.history-toggle').click()
  const historyInput = historical.querySelector('textarea')
  assert.equal(historyInput.value, 'original historical prompt')
  historyInput.value = 'edited historical prompt'
  // History model picker: open the flyout and select Kimi
  const historicalModelButton = historical.querySelector('.history-model')
  historicalModelButton.click()
  const historicalKimiRow = [...historical.querySelectorAll('.history-model-menu .amo-model-menu-provider')].find(row => row.textContent.includes('Kimi'))
  assert.ok(historicalKimiRow, 'Kimi provider must be visible in the history model menu')
  historicalKimiRow.dispatchEvent(new Event('mouseenter', { bubbles: false }))
  const historicalKimiSubmenu = [...document.querySelectorAll('body > .amo-model-submenu')].at(-1)
  const historicalKimiOption = [...historicalKimiSubmenu.querySelectorAll('button')].find(button => button.textContent.includes('Kimi Pro'))
  assert.ok(historicalKimiOption, 'Kimi Pro model option must be visible in the submenu')
  historicalKimiOption.click()
  assert.equal(historicalModelButton.textContent, 'Kimi Pro', 'History model button updates to the selected model')
  historical.querySelector('.history-edit .actions button:last-child').click()
  const resend = posted.filter(message => message.type === 'resend').at(-1)
  assert.equal(resend.seq, 5)
  assert.equal(resend.text, 'edited historical prompt')
  assert.equal(resend.references.length, 0)
  assert.equal(resend.hasCheckpoint, true)
  assert.equal(JSON.stringify(resend.route), JSON.stringify({ provider: 'kimi-coding', model: 'k3.1-pro' }))
  assert.ok(historical.textContent.includes('original historical prompt'))
  historical.querySelector('.history-toggle').click()
  assert.equal(historical.querySelector('.history-edit'), null, 'Running must prevent editing another turn')
  message({ type: 'busy', busy: false })
  message({ type: 'status', status: 'running', text: '正在准备回滚…' })
  assert.equal(document.getElementById('status').textContent, '正在准备回滚…', 'Resend preparation has immediate visible feedback')
  historical.querySelector('.history-toggle').click()
  assert.ok(historical.querySelector('.history-edit'), 'History editor should reopen after resend finishes')
  const resendCountBeforeCancel = posted.filter(message => message.type === 'resend').length
  historical.querySelector('.cancel').click()
  assert.equal(posted.filter(message => message.type === 'resend').length, resendCountBeforeCancel, 'Cancelling history editing must not submit another resend')
  message({ type: 'cleared' })
  message({ type: 'user', seq: 6, text: 'legacy historical prompt' })
  const legacy = document.querySelector('[data-user-seq="6"]')
  message({ type: 'messageSeq', from: 6, seq: 7 })
  assert.equal(legacy.dataset.userSeq, '7')
  legacy.querySelector('.history-toggle').click()
  assert.ok(legacy.querySelector('.history-edit'), 'Legacy messages must be editable before any checkpoint arrives')
  assert.ok(legacy.querySelector('.history-edit').textContent.includes('没有代码快照'))
  legacy.querySelector('textarea').value = 'legacy fork only'
  legacy.querySelector('.history-edit .actions button:last-child').click()
  const legacyResend = posted.filter(message => message.type === 'resend').at(-1)
  assert.equal(legacyResend.seq, 7)
  assert.equal(legacyResend.hasCheckpoint, false)
  assert.equal(legacyResend.text, 'legacy fork only')
  message({ type: 'busy', busy: false })
  legacy.querySelector('.history-toggle').click()
  message({ type: 'messageCheckpoint', seq: 7, checkpointId: 'checkpoint-late', files: ['late.txt'] })
  assert.ok(legacy.querySelector('.history-edit').textContent.includes('回滚后续代码与对话'), 'An open editor must observe a late checkpoint')
  legacy.querySelector('textarea').dispatchEvent(new Event('click', { bubbles: true, cancelable: true }))
  assert.ok(legacy.querySelector('.history-edit'), 'Clicking inside the editor must not reopen or cancel it')
  legacy.querySelector('.cancel').click()
  legacy.querySelector('.history-toggle').click()
  assert.ok(legacy.querySelector('.history-edit').textContent.includes('回滚后续代码与对话'), 'Late checkpoints must update the existing message')
  legacy.querySelector('textarea').value = 'edited after checkpoint arrived'
  legacy.querySelector('.history-edit .actions button:last-child').click()
  assert.equal(posted.filter(message => message.type === 'resend').at(-1).hasCheckpoint, true)
  assert.equal(posted.filter(message => message.type === 'resend').at(-1).text, 'edited after checkpoint arrived')
  message({ type: 'busy', busy: false })
  message({ type: 'checkpointRestored', text: '已恢复代码', canUndo: true })
  document.querySelector('.checkpoint-restored button').click()
  assert.equal(posted.at(-1).type, 'undoRestore')
  message({ type: 'busy', busy: false })
  message({ type: 'cleared' })
  assert.equal(document.querySelectorAll('.tool-call').length, 0)
  assert.equal(document.querySelectorAll('.test-result').length, 0)
  console.log('Webview busy, failure, conflict, @ keyboard and clear behavior passed')
  await permissionMenu()
  await approvalCard()
  await onboarding()
}

/** Approval card: embedded card with allow-once, always-allow, reject, cancel. */
async function approvalCard() {
  const { parseHTML, Event } = require('linkedom')
  const source = fs.readFileSync(path.resolve(__dirname, '../src/extension.ts'), 'utf8')
  const body = source.slice(source.indexOf('<body>'), source.indexOf('</body>') + 7)
    .replace(/\$\{iconUri\}/g, 'agent.svg').replace(/\$\{scriptUri\}/g, 'webview.js')
  const { document } = parseHTML(`<!DOCTYPE html><html><head></head>${body}</html>`)
  const posted = []
  const context = { document, window: document.defaultView, console, URL,
    acquireVsCodeApi: () => ({ postMessage: message => posted.push(message) }),
    setTimeout, clearTimeout, Event, confirm: () => true,
    requestAnimationFrame: callback => setTimeout(callback, 0), cancelAnimationFrame: clearTimeout,
  }
  document.defaultView.HTMLElement.prototype.scrollIntoView = () => {}
  context.globalThis = context
  vm.createContext(context)
  vm.runInContext(fs.readFileSync(path.resolve(__dirname, '../media/webview.js'), 'utf8'), context)
  const message = data => { const event = new Event('message'); event.data = data; context.window.dispatchEvent(event) }
  message({ type: 'workspaceTrust', trusted: true })
  message({ type: 'modelCatalog', catalog: { groups: [{ id: 'deepseek-account', name: 'DeepSeek', models: [{ id: 'deepseek-flash', name: 'DeepSeek Flash' }] }], failures: [] } })

  // No approval card initially
  assert.equal(document.getElementById('approval-card'), null, 'No approval card before request')

  // Receive an approval request
  message({ type: 'approvalRequest', requestId: 'req-1', tool: 'bash', reason: '需要执行 shell 命令' })
  const card = document.getElementById('approval-card')
  assert.ok(card, 'Approval card appears')
  assert.ok(card.textContent.includes('bash'), 'Card shows tool name')
  assert.ok(card.textContent.includes('需要执行 shell 命令'), 'Card shows reason')

  // Click 允许一次
  const buttons = card.querySelectorAll('button')
  const allowOnce = [...buttons].find(b => b.textContent === '允许一次')
  allowOnce.click()
  assert.equal(posted.at(-1).type, 'approvalResponse')
  assert.equal(posted.at(-1).outcome, 'allowed-once')
  assert.equal(document.getElementById('approval-card'), null, 'Card dismissed after response')

  // New request: test 始终允许此工具
  message({ type: 'approvalRequest', requestId: 'req-2', tool: 'edit', reason: '需要写入文件' })
  const card2 = document.getElementById('approval-card')
  assert.ok(card2, 'Second approval card appears')
  const allowAlways = [...card2.querySelectorAll('button')].find(b => b.textContent === '始终允许此工具')
  allowAlways.click()
  // Should send both allowToolForSession and approvalResponse
  const allowToolMsg = posted.find(m => m.type === 'allowToolForSession')
  assert.ok(allowToolMsg, 'allowToolForSession sent')
  assert.equal(allowToolMsg.tool, 'edit')
  const responseMsg = posted.filter(m => m.type === 'approvalResponse').at(-1)
  assert.equal(responseMsg.outcome, 'allowed-once')
  assert.equal(document.getElementById('approval-card'), null, 'Card dismissed after always-allow')

  // Memory chip appears after approvalMemory message
  message({ type: 'approvalMemory', tools: ['edit'] })
  const memBar = document.getElementById('approval-memory')
  assert.equal(memBar.style.display, 'flex', 'Memory chip visible')
  assert.ok(memBar.textContent.includes('edit'), 'Memory chip shows tool name')

  // Clear memory
  document.getElementById('approval-memory-clear').click()
  assert.equal(posted.at(-1).type, 'clearApprovalMemory')
  message({ type: 'approvalMemory', tools: [] })
  assert.equal(memBar.style.display, 'none', 'Memory chip hidden after clear')

  // New request: test 拒绝
  message({ type: 'approvalRequest', requestId: 'req-3', tool: 'write', reason: '需要创建文件' })
  const card3 = document.getElementById('approval-card')
  const reject = [...card3.querySelectorAll('button')].find(b => b.textContent === '拒绝')
  reject.click()
  assert.equal(posted.at(-1).type, 'approvalResponse')
  assert.equal(posted.at(-1).outcome, 'rejected')

  // Card exposes exactly three actions (no duplicate × cancel button); Esc is
  // the only cancellation affordance, covered by the Esc test below.
  message({ type: 'approvalRequest', requestId: 'req-4', tool: 'glob', reason: '需要搜索文件' })
  const card4 = document.getElementById('approval-card')
  const labels4 = [...card4.querySelectorAll('button')].map(b => b.textContent)
  assert.deepEqual(labels4, ['允许一次', '始终允许此工具', '拒绝'], 'Approval card has exactly three actions')
  assert.ok(card4.textContent.includes('Esc = 取消'), 'Card hints at Esc cancellation')

  // Esc key also cancels
  message({ type: 'approvalRequest', requestId: 'req-5', tool: 'grep', reason: '需要搜索内容' })
  const card5 = document.getElementById('approval-card')
  assert.ok(card5, 'Card for Esc test appears')
  const escEvent = new Event('keydown', { bubbles: true, cancelable: true })
  escEvent.key = 'Escape'
  document.dispatchEvent(escEvent)
  assert.equal(posted.at(-1).type, 'approvalResponse')
  assert.equal(posted.at(-1).outcome, 'cancelled', 'Esc key cancels approval')
  assert.equal(document.getElementById('approval-card'), null, 'Card dismissed after Esc')

  console.log('Approval card actions, memory chip and Esc cancellation passed')
}

/** Permission menu: custom dropdown with three modes, risk confirmation for full access. */
async function permissionMenu() {
  const { parseHTML, Event } = require('linkedom')
  const source = fs.readFileSync(path.resolve(__dirname, '../src/extension.ts'), 'utf8')
  const body = source.slice(source.indexOf('<body>'), source.indexOf('</body>') + 7)
    .replace(/\$\{iconUri\}/g, 'agent.svg').replace(/\$\{scriptUri\}/g, 'webview.js')
  const { document } = parseHTML(`<!DOCTYPE html><html><head></head>${body}</html>`)
  const posted = []
  const context = { document, window: document.defaultView, console, URL,
    acquireVsCodeApi: () => ({ postMessage: message => posted.push(message) }),
    setTimeout, clearTimeout, Event, confirm: () => true,
    requestAnimationFrame: callback => setTimeout(callback, 0), cancelAnimationFrame: clearTimeout,
  }
  document.defaultView.HTMLElement.prototype.scrollIntoView = () => {}
  context.globalThis = context
  vm.createContext(context)
  vm.runInContext(fs.readFileSync(path.resolve(__dirname, '../media/webview.js'), 'utf8'), context)
  const message = data => { const event = new Event('message'); event.data = data; context.window.dispatchEvent(event) }
  message({ type: 'workspaceTrust', trusted: true })
  message({ type: 'modelCatalog', catalog: { groups: [{ id: 'deepseek-account', name: 'DeepSeek', models: [{ id: 'deepseek-flash', name: 'DeepSeek Flash' }] }], failures: [] } })

  const permissionBtn = document.getElementById('permissionMode')
  const permissionMenu = document.getElementById('permission-menu')
  assert.ok(permissionBtn, 'Permission button exists')
  assert.ok(permissionMenu, 'Permission menu exists')
  assert.equal(permissionBtn.textContent, '工作区可写', 'Default permission is workspace-write')
  assert.equal(permissionBtn.classList.contains('danger'), false, 'Default is not danger mode')

  // Open menu
  permissionBtn.click()
  assert.equal(permissionMenu.hidden, false, 'Menu opens on click')
  const options = document.querySelectorAll('.permission-option')
  assert.equal(options.length, 3, 'Three permission options')
  assert.equal(options[0].dataset.value, 'read-only')
  assert.equal(options[1].dataset.value, 'workspace-write')
  assert.equal(options[2].dataset.value, 'danger-full-access')
  assert.equal(options[1].querySelector('.permission-check').style.visibility, 'visible', 'Current mode is checked')

  // Select read-only
  options[0].click()
  assert.equal(permissionMenu.hidden, true, 'Menu closes after selection')
  assert.equal(posted.at(-1).type, 'permissionMode')
  assert.equal(posted.at(-1).value, 'read-only')

  // Simulate config update from extension
  message({ type: 'config', permissionMode: 'read-only' })
  assert.equal(permissionBtn.textContent, '🔒 只读 · 写入审批')
  assert.equal(permissionBtn.classList.contains('danger'), false)

  // Select full-access (extension will show risk dialog; webview just sends the request)
  permissionBtn.click()
  assert.equal(permissionMenu.hidden, false)
  document.querySelectorAll('.permission-option')[2].click()
  assert.equal(posted.at(-1).type, 'permissionMode')
  assert.equal(posted.at(-1).value, 'danger-full-access')

  // Extension confirms and updates UI
  message({ type: 'config', permissionMode: 'danger-full-access' })
  assert.equal(permissionBtn.textContent, '⚠️ 完全访问')
  assert.equal(permissionBtn.classList.contains('danger'), true)
  assert.equal(permissionBtn.title, '沙箱: 无限制 · 审批: 从不询问')

  // Click outside closes menu
  permissionBtn.click()
  assert.equal(permissionMenu.hidden, false)
  document.body.click()
  assert.equal(permissionMenu.hidden, true, 'Click outside closes permission menu')

  // Approval memory bar follows the permission mode: visible in modes that can
  // raise approval prompts, hidden under danger-full-access without losing the
  // memory itself, and restored when switching back.
  const memBar = document.getElementById('approval-memory')
  message({ type: 'config', permissionMode: 'read-only' })
  message({ type: 'approvalMemory', tools: ['edit'] })
  assert.equal(memBar.style.display, 'flex', 'Memory bar visible in read-only mode')
  message({ type: 'config', permissionMode: 'workspace-write' })
  assert.equal(memBar.style.display, 'flex', 'Memory bar visible in workspace-write mode')
  message({ type: 'config', permissionMode: 'danger-full-access' })
  assert.equal(memBar.style.display, 'none', 'Memory bar hidden in full-access mode')
  message({ type: 'config', permissionMode: 'read-only' })
  assert.equal(memBar.style.display, 'flex', 'Memory bar restored when switching back')

  console.log('Permission menu three modes, risk confirmation trigger and UI sync passed')
}
/** Drive the approved provider/configuration route without exposing a key. */
async function onboarding() {
  const { parseHTML, Event } = require('linkedom')
  const source = fs.readFileSync(path.resolve(__dirname, '../src/extension.ts'), 'utf8')
  const body = source.slice(source.indexOf('<body>'), source.indexOf('</body>') + 7)
    .replace(/\$\{iconUri\}/g, 'agent.svg').replace(/\$\{scriptUri\}/g, 'webview.js')
  const { document } = parseHTML(`<!DOCTYPE html><html><head></head>${body}</html>`)
  const posted = []
  const context = { document, window: document.defaultView, console, URL,
    acquireVsCodeApi: () => ({ postMessage: message => posted.push(message) }),
    setTimeout, clearTimeout, Event, confirm: () => true,
    requestAnimationFrame: callback => setTimeout(callback, 0), cancelAnimationFrame: clearTimeout,
  }
  document.defaultView.HTMLElement.prototype.scrollIntoView = () => {}
  document.defaultView.confirm = () => true
  context.globalThis = context
  vm.createContext(context)
  vm.runInContext(fs.readFileSync(path.resolve(__dirname, '../media/webview.js'), 'utf8'), context)
  const message = data => { const event = new Event('message'); event.data = data; context.window.dispatchEvent(event) }
  message({ type: 'workspaceTrust', trusted: true })
  message({ type: 'modelCatalog', catalog: { groups: [], failures: [] } })
  assert.equal(document.getElementById('amo-provider-view').hidden, false, 'No models opens provider selection')
  assert.equal(document.getElementById('input').disabled, true, 'Composer cannot send without a model')
  assert.equal(document.querySelectorAll('.amo-provider').length, 19)
  const search = document.getElementById('amo-provider-search')
  search.value = 'openrouter'
  search.dispatchEvent(new Event('input'))
  assert.equal(document.querySelectorAll('.amo-provider').length, 1)
  document.querySelector('.amo-provider').click()
  assert.equal(document.getElementById('amo-config-view').hidden, false)
  assert.equal(document.getElementById('amo-url').value, 'https://openrouter.ai/api/v1')
  const key = document.getElementById('amo-key')
  key.value = 'temporary-test-key'
  key.dispatchEvent(new Event('input'))
  await new Promise(resolve => setTimeout(resolve, 750))
  const discovery = posted.find(item => item.type === 'discoverModels')
  assert.ok(discovery, 'Typing a key schedules wire discovery')
  assert.equal(discovery.params.apiKey, 'temporary-test-key')
  message({ type: 'discoverModelsResult', requestId: discovery.requestId, models: [
    { id: 'vendor/model-a', name: 'Model A', contextWindow: 200000, inputModalities: ['text'] },
    { id: 'vendor/model-b', name: 'Model B', inputModalities: ['text', 'image'] },
  ] })
  assert.equal(document.querySelectorAll('.amo-model-option').length, 2)
  // Multi-select: default selects first; clicking second adds it to selection
  document.querySelectorAll('.amo-model-option')[1].click()
  document.getElementById('amo-alias').value = 'My coding model'
  document.getElementById('amo-test').click()
  const test = posted.find(item => item.type === 'testModel')
  assert.equal(test.params.model, 'vendor/model-a', 'First selected model is used for the test connection')
  assert.equal(test.params.modelName, 'My coding model')
  message({ type: 'testModelResult', requestId: test.requestId, result: { provider: 'openrouter', model: 'vendor/model-a', durationMs: 24 } })
  assert.match(document.getElementById('amo-test-result').textContent, /连接成功.*24 ms/)
  document.getElementById('amo-save').click()
  const saved = posted.find(item => item.type === 'saveCustomProvider')
  assert.equal(saved.params.models.length, 2, 'Both selected models are saved')
  assert.equal(saved.params.models[0].id, 'vendor/model-a')
  assert.equal(saved.params.models[1].id, 'vendor/model-b')
  assert.deepEqual(saved.params.models[1].input, ['text', 'image'])
  message({ type: 'modelCatalog', catalog: { groups: [{ id: 'openrouter', name: 'OpenRouter', models: saved.params.models }], failures: [] } })
  message({ type: 'saveCustomProviderResult', requestId: saved.requestId, result: { provider: 'openrouter' } })
  assert.equal(document.getElementById('model-onboarding').hidden, true)
  assert.equal(key.value, '', 'A saved secret is discarded from the Webview')
  assert.equal(document.getElementById('input').disabled, false)
  document.getElementById('amo-menu-add').click()
  document.getElementById('amo-custom-provider').click()
  document.getElementById('amo-route').value = 'local-api'
  document.getElementById('amo-url').value = 'http://127.0.0.1:8080/v1'
  document.getElementById('amo-rediscover').click()
  const failedDiscovery = posted.filter(item => item.type === 'discoverModels').at(-1)
  assert.equal(failedDiscovery.params.provider, 'local-api', 'A custom endpoint attempts model discovery')
  message({ type: 'discoverModelsResult', requestId: failedDiscovery.requestId, error: 'listing unavailable' })
  assert.equal(document.getElementById('amo-save').disabled, true, 'Failed discovery does not invent a model')
  document.getElementById('amo-manual-id').value = 'manual-model'
  document.getElementById('amo-add-manual').click()
  assert.equal(document.querySelectorAll('.amo-model-option').length, 1, 'Discovery failure retains a manual fallback')
  document.getElementById('amo-save').click()
  const manual = posted.filter(item => item.type === 'saveCustomProvider').at(-1)
  assert.equal(manual.params.provider, 'local-api')
  assert.equal(manual.params.models[0].input[0], 'text')
  message({ type: 'modelCatalog', catalog: { groups: [{ id: 'local-api', name: '我的模型服务', models: manual.params.models }], failures: [] } })
  message({ type: 'saveCustomProviderResult', requestId: manual.requestId, result: { provider: 'local-api' } })
  document.getElementById('amo-menu-manage').click()
  assert.equal(document.getElementById('amo-manage-view').hidden, false)
  document.getElementById('amo-manage-add').click()
  document.getElementById('amo-custom-provider').click()
  document.getElementById('amo-back').click()
  assert.equal(document.getElementById('amo-manage-view').hidden, false, 'Cancel adding a service returns to management')
  assert.equal(document.getElementById('amo-config-view').hidden, true)
  document.getElementById('amo-back').click()
  assert.equal(document.getElementById('amo-provider-view').hidden, false, 'Cancel from manage returns to provider selection')
  document.getElementById('amo-menu-manage').click()
  document.querySelector('#amo-manage-list .amo-text-button').click()
  const configRequest = posted.find(item => item.type === 'providerConfig')
  assert.equal(configRequest.params.provider, 'local-api')
  message({ type: 'providerConfigResult', requestId: configRequest.requestId, result: {
    provider: 'local-api', displayName: '我的模型服务', baseURL: 'http://127.0.0.1:8080/v1', api: 'openai-completions',
    models: [{ id: 'manual-model', name: 'Manual alias', inputModalities: ['text'] }], hasCredential: false,
  } })
  assert.equal(document.getElementById('amo-alias').value, 'Manual alias')
  document.getElementById('amo-test').click()
  const retainedTest = posted.filter(item => item.type === 'testModel').at(-1)
  assert.equal('apiKey' in retainedTest.params, false, 'Editing never reads back the existing credential')
  message({ type: 'testModelResult', requestId: retainedTest.requestId, result: { provider: 'local-api', model: 'manual-model', durationMs: 18 } })
  document.getElementById('amo-alias').value = 'Renamed model'
  document.getElementById('amo-save').click()
  const edited = posted.filter(item => item.type === 'saveCustomProvider').at(-1)
  assert.equal('apiKey' in edited.params, false, 'A blank edit retains the existing credential')
  assert.equal(edited.params.models[0].name, 'Renamed model')
  message({ type: 'modelCatalog', catalog: { groups: [{ id: 'local-api', name: '我的模型服务', models: edited.params.models }], failures: [] } })
  message({ type: 'saveCustomProviderResult', requestId: edited.requestId, result: { provider: 'local-api' } })
  document.getElementById('amo-menu-manage').click()
  document.querySelectorAll('#amo-manage-list .amo-text-button')[1].click()
  message({ type: 'modelCatalog', catalog: { groups: [], failures: [] } })
  assert.equal(document.getElementById('amo-provider-view').hidden, false, 'Deleting the last service reopens onboarding')
  console.log('Model onboarding discovery, editing, retention, deletion and manual fallback passed')
}

module.exports = { run }
if (require.main === module) void run().catch(error => { console.error(error); process.exitCode = 1 })
