import { existsSync } from 'node:fs'
import { stat } from 'node:fs/promises'
import { resolve } from 'node:path'
import * as vscode from 'vscode'

const conflictEmitter = new vscode.EventEmitter<{ path: string, text: string }>()
export const onEditConflict = conflictEmitter.event

/** A prompt-time snapshot can warn about later external writes; it must never overwrite either version. */
export class EditConflictMonitor {
  private stamps = new Map<string, { mtimeMs: number, size: number }>()
  private snapshotPromise: Promise<void> | undefined

  snapshot(workspace: string): void {
    this.stamps.clear()
    this.snapshotPromise = this.capture(workspace)
  }

  clear(): void {
    this.stamps.clear()
    this.snapshotPromise = undefined
  }

  async watch(workspace: string, tool: string, argumentsText: unknown): Promise<void> {
    if (tool !== 'edit' && tool !== 'write' || typeof argumentsText !== 'string') return
    let path: string | undefined
    try { path = (JSON.parse(argumentsText) as { file_path?: unknown }).file_path as string | undefined } catch { return }
    if (typeof path !== 'string') return
    const absolute = resolve(workspace, path)
    await this.snapshotPromise
    const document = vscode.workspace.textDocuments.find(document => document.uri.fsPath === absolute && document.isDirty)
    if (document !== undefined) {
      this.warn(path, document.uri, '文件在编辑器中有未保存的修改。Agent 的修改可能与你的编辑重叠，请先保存、审查或撤销不需要的版本。')
      return
    }
    if (!existsSync(absolute)) return
    const previous = this.stamps.get(absolute)
    const current = await stat(absolute)
    if (previous !== undefined && (previous.mtimeMs !== current.mtimeMs || previous.size !== current.size)) {
      this.warn(path, vscode.Uri.file(absolute), '文件在本次任务开始后被外部修改。请比较 Agent 和你的修改，避免静默覆盖。')
    }
    this.stamps.set(absolute, { mtimeMs: current.mtimeMs, size: current.size })
  }

  private async capture(workspace: string): Promise<void> {
    for (const document of vscode.workspace.textDocuments) {
      if (document.uri.scheme === 'file') {
        const path = document.uri.fsPath
        if (document.isDirty) this.stamps.set(path, { mtimeMs: Number.NaN, size: -1 })
      }
    }
    await vscode.workspace.findFiles('**/*', '{**/node_modules/**,**/.git/**,**/.dsh-dev/**,**/.vscode-agent-dev/**,**/.venv/**}', 1000)
      .then(async files => Promise.all(files.map(async uri => {
        try {
          const info = await stat(uri.fsPath)
          if (!this.stamps.has(uri.fsPath)) this.stamps.set(uri.fsPath, { mtimeMs: info.mtimeMs, size: info.size })
        } catch { /* A concurrently removed file is handled by the write tool. */ }
      })))
  }

  private warn(path: string, uri: vscode.Uri, text: string): void {
    void vscode.window.showWarningMessage(`Agent 修改冲突：${path}`, '打开文件', '查看 Git Diff').then(choice => {
      if (choice === '打开文件') void vscode.window.showTextDocument(uri)
      if (choice === '查看 Git Diff') void vscode.commands.executeCommand('workbench.view.scm')
    })
    // Surface the condition in chat as well as VS Code's transient notification.
    conflictEmitter.fire({ path, text })
  }
}
