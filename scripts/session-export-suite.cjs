const assert = require('node:assert/strict')
const path = require('node:path')

async function run() {
  const { sessionToMarkdown, sessionExportFilename } = await import('../out/sessionExport.js')

  // Empty history still produces a valid header.
  const empty = sessionToMarkdown({
    session: { id: 'session-1', title: '空会话', cwd: '/work', createdAt: 1700000000000, updatedAt: 1700000000000 },
    events: [],
  })
  assert.ok(empty.includes('# 空会话'))
  assert.ok(empty.includes('session-1'))
  assert.ok(empty.includes('/work'))

  // Override title takes precedence.
  const withOverride = sessionToMarkdown({
    session: { id: 'session-1', title: '默认', cwd: '/work', createdAt: 1700000000000, updatedAt: 1700000000000 },
    events: [],
  }, '用户重命名')
  assert.ok(withOverride.includes('# 用户重命名'))
  assert.ok(!withOverride.includes('# 默认'))

  // User + assistant turns render in order.
  const history = {
    session: { id: 'session-2', title: 't', cwd: '/work', createdAt: 0, updatedAt: 0 },
    events: [
      { type: 'user/message', seq: 1, time: 0, data: { source: { kind: 'user' }, content: [{ type: 'text', text: '请修复登录页' }] } },
      { type: 'assistant/message', seq: 2, time: 1, data: { message: { content: [{ type: 'text', text: '我先看代码。' }] } } },
      { type: 'assistant/attempt', seq: 3, time: 2, data: { message: { content: [{ type: 'reasoning', text: '分析步骤1' }, { type: 'text', text: '最终回答' }] } } },
      { type: 'tool/call', seq: 4, time: 3, data: { name: 'read_file', arguments: { path: 'src/login.ts' } } },
      { type: 'tool/result', seq: 5, time: 4, data: { result: 'file contents here' } },
    ],
  }
  const md = sessionToMarkdown(history)
  const userIdx = md.indexOf('## 👤 用户')
  const assistantIdx = md.indexOf('## 🤖 助手')
  const toolIdx = md.indexOf('🔧 **read_file**')
  const resultIdx = md.indexOf('↩ **结果**')
  assert.ok(userIdx > 0 && assistantIdx > userIdx && toolIdx > assistantIdx && resultIdx > toolIdx, 'Sections render in order')
  assert.ok(md.includes('请修复登录页'))
  assert.ok(md.includes('最终回答'))
  assert.ok(md.includes('<details><summary>思考过程</summary>'))
  assert.ok(md.includes('分析步骤1'))

  // Code fences inside text are escaped.
  const fenced = sessionToMarkdown({
    session: { id: 's3', title: 't', cwd: '/', createdAt: 0, updatedAt: 0 },
    events: [
      { type: 'assistant/attempt', seq: 1, time: 0, data: { message: { content: [{ type: 'reasoning', text: '```js\nfoo\n```' }] } } },
      { type: 'assistant/message', seq: 2, time: 1, data: { message: { content: [{ type: 'text', text: 'done' }] } } },
    ],
  })
  assert.ok(fenced.includes('``\\`js'), 'Triple backticks escaped in reasoning')

  // Filename sanitization strips path separators and trims length.
  const filename = sessionExportFilename('修复登录页面/Bug', 'session-abc123def456')
  assert.equal(filename, '修复登录页面 Bug-session-abc1.md')
  assert.ok(!filename.includes('/'))
  assert.ok(!filename.includes(':'))

  // Very long titles get trimmed but stay non-empty.
  const longTitle = 'x'.repeat(200)
  const longName = sessionExportFilename(longTitle, 'session-abc')
  assert.ok(longName.length < 100)
  assert.ok(longName.endsWith('.md'))

  // Empty title falls back to a stable name.
  const fallback = sessionExportFilename('   ', 'session-abc')
  assert.equal(fallback, 'session-session-abc.md'.replace('session-abc', 'session-abc'))

  console.log('Session export markdown and filename sanitization passed')
}

run().catch(error => { console.error(error); process.exit(1) })
