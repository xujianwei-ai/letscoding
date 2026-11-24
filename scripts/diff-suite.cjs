async function run() {
  const vscode = require('vscode')
  const { openChangedDiff } = await import('../out/diff.js')
  const path = require('node:path')
  const root = path.resolve(__dirname, '../../stage1-fixture')
  const file = path.join(root, 'calculator.js')
  const git = await vscode.extensions.getExtension('vscode.git').activate()
  const api = git.getAPI(1)
  console.log('Git repository API:', api.repositories.map(repository => repository.rootUri.fsPath))
  await openChangedDiff(root, file)
  for (let attempt = 0; attempt < 20; attempt++) {
    const tab = vscode.window.tabGroups.activeTabGroup.activeTab
    console.log('Diff tab:', tab?.label, JSON.stringify(tab?.input))
    if (tab?.input instanceof vscode.TabInputTextDiff) {
      const document = await vscode.workspace.openTextDocument(tab.input.original)
      const text = document.getText()
      if (!text.includes('left * right')) throw new Error('Git HEAD content provider did not return the baseline')
      console.log('Native Git Diff passed')
      return
    }
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  throw new Error('No native diff tab opened')
}
module.exports = { run }
