const assert = require('node:assert/strict')
const fs = require('node:fs')
const { pathToFileURL } = require('node:url')

function dataModule(source) { return 'data:text/javascript;base64,' + Buffer.from(source).toString('base64') }

async function run() {
  const vscode = dataModule(`
    export class ThemeColor { constructor(id) { this.id = id } }
    export class MarkdownString {
      value = ''
      appendMarkdown(text) { this.value += text }
      appendCodeblock(text) { this.value += text }
    }
    export const OverviewRulerLane = { Left: 1 }
    export const Uri = { parse: value => value }
    export const window = { createTextEditorDecorationType: options => ({ options, dispose() {} }) }
  `)
  let source = fs.readFileSync(require.resolve('../out/inlineDiff.js'), 'utf8')
  source = source.replace("from 'vscode'", `from ${JSON.stringify(vscode)}`)
    .replace("from 'diff'", `from ${JSON.stringify(pathToFileURL(require.resolve('diff')).href)}`)
  const { InlineDiffRenderer } = await import(dataModule(source))
  const renderer = new InlineDiffRenderer()
  assert.doesNotMatch(renderer.additions.options.gutterIconPath, /<text/i, 'Gutter plus must not depend on font metrics')
  assert.equal(renderer.modifications.options.gutterIconPath, undefined, 'Modified lines must not overlap the addition gutter icon')
  const calls = []
  const editor = {
    document: {
      languageId: 'javascript',
      getText: () => 'KEEP\nNEW\nTAIL\n',
      lineCount: 4,
      lineAt: line => ({ range: { start: { line }, end: { line } } }),
    },
    setDecorations(type, options) { calls.push(options) },
  }
  renderer.apply(editor, 'KEEP\nOLD\nREMOVED\nTAIL\n', ['file.js', 2])
  assert.equal(calls[0].length, 0, 'Replacement must not be marked as a pure addition')
  assert.deepEqual(calls[1].map(range => range.start.line), [1])
  assert.deepEqual(calls[2].map(change => change.range.start.line), [1])
  assert.equal(calls[2][0].renderOptions, undefined, 'Deleted source must not be overlaid on the modified line')
  assert.match(calls[2][0].hoverMessage.value, /privateCodingAgent.openDiff/)

  editor.document.getText = () => 'KEEP\nNEW\nADDED\nTAIL\n'
  editor.document.lineCount = 5
  calls.length = 0
  renderer.apply(editor, 'KEEP\nOLD\nTAIL\n')
  assert.deepEqual(calls[0].map(range => range.start.line), [2], 'Only the extra line is a pure addition')
  assert.deepEqual(calls[1].map(range => range.start.line), [1], 'The replaced line is modified')
  assert.deepEqual(calls[2].map(change => change.range.start.line), [1])
  assert.match(calls[2][0].hoverMessage.value, /删除 1 行/)

  calls.length = 0
  renderer.apply(editor, 'KEEP\nNEW\nADDED\nTAIL\n')
  assert.deepEqual(calls, [[], [], []], 'Identical text must have no stale decorations')
  renderer.dispose()
  console.log('Inline editor additions, replacement, deleted source and clearing passed')
}

run().catch(error => { console.error(error); process.exitCode = 1 })
