import * as vscode from 'vscode'
import { diffLines } from 'diff'

/** Non-invasive editor decorations: deleted source remains available in the hover. */
export class InlineDiffRenderer implements vscode.Disposable {
  private readonly additions = vscode.window.createTextEditorDecorationType({
    isWholeLine: true,
    backgroundColor: new vscode.ThemeColor('diffEditor.insertedLineBackground'),
    gutterIconPath: vscode.Uri.parse('data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIxNiIgaGVpZ2h0PSIxNiIgdmlld0JveD0iMCAwIDE2IDE2Ij48cGF0aCBzdHJva2U9IiM0YWJmNmEiIHN0cm9rZS13aWR0aD0iMiIgZD0iTTggM3YxME0zIDhoMTAiLz48L3N2Zz4='),
    gutterIconSize: 'contain',
    overviewRulerColor: new vscode.ThemeColor('editorGutter.addedBackground'),
    overviewRulerLane: vscode.OverviewRulerLane.Left,
  })
  private readonly modifications = vscode.window.createTextEditorDecorationType({
    isWholeLine: true,
    backgroundColor: new vscode.ThemeColor('diffEditor.insertedLineBackground'),
    gutterIconSize: 'contain',
    overviewRulerColor: new vscode.ThemeColor('editorGutter.modifiedBackground'),
    overviewRulerLane: vscode.OverviewRulerLane.Left,
  })
  private readonly deletions = vscode.window.createTextEditorDecorationType({
    isWholeLine: true,
    gutterIconPath: vscode.Uri.parse('data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIxNiIgaGVpZ2h0PSIxNiIgdmlld0JveD0iMCAwIDE2IDE2Ij48cGF0aCBzdHJva2U9IiNmMTQ1NGUiIHN0cm9rZS13aWR0aD0iMiIgZD0iTTMgOGgxMCIvPjwvc3ZnPg=='),
    gutterIconSize: 'contain',
    overviewRulerColor: new vscode.ThemeColor('editorGutter.deletedBackground'),
    overviewRulerLane: vscode.OverviewRulerLane.Left,
  })

  apply(editor: vscode.TextEditor, before: string, diffArguments?: [string, number, string?]): void {
    const after = editor.document.getText()
    const changes = diffLines(before.replace(/\r\n/g, '\n'), after.replace(/\r\n/g, '\n'))
    const added: vscode.Range[] = []
    const modified: vscode.Range[] = []
    const deleted: vscode.DecorationOptions[] = []
    let line = 0
    for (let index = 0; index < changes.length; index++) {
      const change = changes[index]
      const lines = change.value.split('\n')
      if (lines.at(-1) === '') lines.pop()
      if (change.removed) {
        const next = changes[index + 1]
        const target = Math.min(line, Math.max(0, editor.document.lineCount - 1))
        const range = editor.document.lineAt(target).range
        const markdown = new vscode.MarkdownString(undefined, true)
        markdown.isTrusted = true
        markdown.appendMarkdown(`**删除 ${lines.length} 行（本轮修改前）**\n\n`)
        markdown.appendCodeblock(lines.join('\n'), editor.document.languageId)
        if (diffArguments !== undefined) markdown.appendMarkdown(`\n[打开完整前后对比](command:privateCodingAgent.openDiff?${encodeURIComponent(JSON.stringify(diffArguments))})`)
        // An editor decoration cannot reserve the multi-line height required for
        // deleted source. The native inline Diff owns that layout; never overlay it here.
        deleted.push({ range, hoverMessage: markdown })
        if (next?.added === true) {
          index++
          const replacement = count(next.value)
          // jsdiff pairs unequal replacements as deletion + addition: keep pure additions green.
          for (let offset = 0; offset < replacement; offset++) {
            if (line + offset >= editor.document.lineCount) continue
            if (offset < lines.length) modified.push(editor.document.lineAt(line + offset).range)
            else added.push(editor.document.lineAt(line + offset).range)
          }
          line += replacement
        }
        continue
      }
      if (change.added) {
        for (let offset = 0; offset < lines.length; offset++) {
          if (line + offset < editor.document.lineCount) added.push(editor.document.lineAt(line + offset).range)
        }
      }
      line += lines.length
    }
    editor.setDecorations(this.additions, added)
    editor.setDecorations(this.modifications, modified)
    editor.setDecorations(this.deletions, deleted)
  }

  clear(editor: vscode.TextEditor): void {
    editor.setDecorations(this.additions, [])
    editor.setDecorations(this.modifications, [])
    editor.setDecorations(this.deletions, [])
  }

  dispose(): void {
    this.additions.dispose()
    this.modifications.dispose()
    this.deletions.dispose()
  }
}

function count(value: string): number {
  const lines = value.split('\n')
  if (lines.at(-1) === '') lines.pop()
  return lines.length
}
