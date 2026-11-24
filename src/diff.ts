import { isAbsolute, relative, resolve } from 'node:path'
import { stat } from 'node:fs/promises'
import * as vscode from 'vscode'

/** Track only successful, ordinary in-workspace mutations for the diff command. */
export function changedPath(tool: string, argumentsText: unknown, workspace: string): string | undefined {
  if (tool !== 'edit' && tool !== 'write' || typeof argumentsText !== 'string') return undefined
  try {
    const path = (JSON.parse(argumentsText) as { file_path?: unknown }).file_path
    if (typeof path !== 'string' || path.trim() === '') return undefined
    const absolute = resolve(workspace, path)
    const local = relative(workspace, absolute)
    if (local === '..' || local.startsWith('../') || local.startsWith('..\\') || isAbsolute(local)) return undefined
    return absolute
  } catch { return undefined }
}

/** Compare the actual working file against HEAD using the installed Git extension API. */
export async function openChangedDiff(workspace: string, paths: string[] = []): Promise<void> {
  const repository = await headRepository(workspace)
  if (repository === undefined) {
    void vscode.window.showInformationMessage('当前目录没有 Git 基线；请先在项目内创建初始提交。')
    await vscode.commands.executeCommand('workbench.view.scm')
    return
  }
  if (paths.length > 1) {
    const selected = await vscode.window.showQuickPick([
      { label: '查看工作区全部修改', value: '' },
      ...paths.map(path => ({ label: relative(workspace, path), value: path })),
    ], { title: '选择本轮 Agent 修改的文件' })
    if (selected === undefined) return
    if (selected.value === '') {
      await vscode.commands.executeCommand('workbench.view.scm')
      return
    }
    return openChangedDiff(workspace, [selected.value])
  }
  const path = paths[0]
  if (path === undefined) {
    await vscode.commands.executeCommand('workbench.view.scm')
    return
  }
  console.log('[Coding Agent] Opening native diff:', path)
  const original = repository.api.toGitUri(vscode.Uri.file(path), 'HEAD')
  let exists = true
  try { await stat(path) } catch { exists = false }
  if (!exists) {
    void vscode.window.showInformationMessage('文件已删除，Git 源代码管理可查看删除内容。')
    await vscode.commands.executeCommand('workbench.view.scm')
    return
  }
  await vscode.commands.executeCommand('vscode.diff', original, vscode.Uri.file(path), `Agent 修改：${relative(workspace, path)}`)
}

interface GitRepository { rootUri: vscode.Uri; api: GitApi }
interface GitApi {
  repositories: GitRepository[]
  toGitUri(uri: vscode.Uri, ref: string): vscode.Uri
  getRepository(uri: vscode.Uri): GitRepository | null
  onDidOpenRepository(listener: (repository: GitRepository) => void): vscode.Disposable
  openRepository(uri: vscode.Uri): Thenable<GitRepository | null>
}
interface GitExtension { getAPI(version: 1): GitApi }

async function repositories(): Promise<GitRepository[]> {
  const extension = vscode.extensions.getExtension<GitExtension>('vscode.git')
  if (extension === undefined) return []
  const git = extension.isActive ? extension.exports : await extension.activate()
  return git.getAPI(1).repositories.map(repository => ({ ...repository, api: git.getAPI(1) }))
}

async function headRepository(workspace: string): Promise<GitRepository | undefined> {
  const available = await repositories()
  let repository = available.find(item => item.rootUri.fsPath === workspace)
  if (repository !== undefined) return repository
  const extension = vscode.extensions.getExtension<GitExtension>('vscode.git')
  if (extension === undefined) return undefined
  const api = extension.exports.getAPI(1)
  const discovered = await Promise.race([
    new Promise<GitRepository>(resolve => {
      const listener = api.onDidOpenRepository(repository => {
        listener.dispose()
        resolve(repository)
      })
    }),
    new Promise<undefined>(resolve => setTimeout(() => resolve(undefined), 2000)),
  ])
  return discovered === undefined ? undefined : { ...discovered, api }
}
