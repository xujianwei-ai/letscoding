import { basename } from 'node:path'
import * as vscode from 'vscode'

export const MAX_SELECTION_CHARACTERS = 20_000
export const MAX_REFERENCE_FILE_BYTES = 64 * 1024
/** Chat-rendered workspace images (script-produced output) are bounded to keep postMessage and the DOM light. */
export const MAX_CHAT_IMAGE_BYTES = 5 * 1024 * 1024
export const IMAGE_EXTENSIONS = /\.(?:png|jpe?g|gif|webp|bmp|svg)$/i

/** True when a markdown/`<img>` src is a workspace-relative image path the webview cannot load directly. */
export function isWorkspaceImageReference(src: string): boolean {
  return IMAGE_EXTENSIONS.test(src) && !/^(?:data:|https?:|blob:|vscode-resource:|vscode-webview-resource:)/i.test(src)
}

/** Resolve a workspace-relative image reference to a loadable webview URI, or a readable rejection.
 * Rejects path escape, non-workspace, non-file, non-image-extension and oversized targets. */
export async function resolveWorkspaceImage(webview: vscode.Webview, relativePath: string): Promise<string> {
  const workspace = vscode.workspace.workspaceFolders?.[0]?.uri
  if (workspace === undefined) throw new Error('请先打开一个单项目工作区。')
  if (relativePath.includes('\0')) throw new Error('图片路径无效。')
  const uri = vscode.Uri.joinPath(workspace, relativePath)
  // The resolved target must stay inside the single workspace folder; joinPath already
  // normalizes `..`, so a folder mismatch means the path escaped the workspace root.
  if (vscode.workspace.getWorkspaceFolder(uri)?.uri.fsPath !== workspace.fsPath) throw new Error('图片不属于当前工作区。')
  if (!IMAGE_EXTENSIONS.test(uri.fsPath)) throw new Error('只允许渲染图片文件（png/jpg/gif/webp/bmp/svg）。')
  const stat = await vscode.workspace.fs.stat(uri)
  if (stat.type !== vscode.FileType.File) throw new Error('图片不是可读取的普通文件。')
  if (stat.size > MAX_CHAT_IMAGE_BYTES) throw new Error(`图片超过 ${Math.round(MAX_CHAT_IMAGE_BYTES / 1024 / 1024)} MiB，请直接在工作区打开查看。`)
  return webview.asWebviewUri(uri).toString()
}

export interface FileReference { path: string, uri: string }

/** Use VS Code's index, but never enumerate dependency stores, VCS internals or local Agent data. */
export async function workspaceFiles(): Promise<FileReference[]> {
  const uris = await vscode.workspace.findFiles('**/*', '{**/node_modules/**,**/.git/**,**/.dsh-dev/**,**/.vscode-agent-dev/**,**/.venv/**,**/dist/**,**/out/**}', 1000)
  return uris.filter(uri => uri.scheme === 'file' && vscode.workspace.getWorkspaceFolder(uri) !== undefined)
    .map(uri => ({ path: vscode.workspace.asRelativePath(uri, false), uri: uri.toString() }))
    .filter(file => commonTextFile(file.path))
    .sort((left, right) => left.path.localeCompare(right.path))
}

/**
 * All workspace files, including images and other binary artifacts. Used for
 * clickable inline file references in chat output (e.g. `sunset.png`), where the
 * file does not need to be readable as text.
 */
export async function allWorkspaceFiles(): Promise<FileReference[]> {
  const uris = await vscode.workspace.findFiles('**/*', '{**/node_modules/**,**/.git/**,**/.dsh-dev/**,**/.vscode-agent-dev/**,**/.venv/**,**/dist/**,**/out/**}', 1000)
  return uris.filter(uri => uri.scheme === 'file' && vscode.workspace.getWorkspaceFolder(uri) !== undefined)
    .map(uri => ({ path: vscode.workspace.asRelativePath(uri, false), uri: uri.toString() }))
    .sort((left, right) => left.path.localeCompare(right.path))
}

/** Keep @ completion focused on files that can provide useful text context. */
export function commonTextFile(path: string): boolean {
  const name = path.split('/').pop()?.toLowerCase() ?? ''
  if (name.startsWith('.env') || /(?:^|\/)(?:__pycache__|\.pytest_cache|\.mypy_cache|\.ruff_cache|\.cache|coverage|\.nyc_output|\.idea|target|build|vendor)(?:\/|$)/i.test(path)) return false
  if (/\.(?:pyc|pyo|pyd|class|jar|war|o|obj|a|so|dll|dylib|exe|bin|dat|db|sqlite3?|log|tmp|bak|swp|min\.js|min\.css|map)$/i.test(name)) return false
  if (/\.(?:png|jpe?g|gif|webp|ico|bmp|svg|mp[34]|wav|ogg|avi|mov|zip|rar|7z|gz|tgz|bz2|xz|pdf|docx?|xlsx?|pptx?|ttf|otf|woff2?|eot)$/i.test(name)) return false
  if (name === 'package-lock.json' || name === 'pnpm-lock.yaml' || name === 'yarn.lock' || name.endsWith('.tsbuildinfo')) return false
  return !/\.[a-z0-9]+$/i.test(name) || /\.(?:[cm]?[jt]sx?|py|pyi|java|go|rs|c|cc|cpp|cxx|h|hh|hpp|cs|php|rb|swift|kt|kts|scala|sh|bash|zsh|fish|ps1|sql|lua|r|dart|vue|svelte|astro|html?|css|scss|sass|less|json|jsonc|ya?ml|toml|ini|cfg|conf|xml|md|mdx|txt|rst|csv|graphql|gql|proto|dockerfile|makefile|cmake|gradle|properties|editorconfig|gitignore|gitattributes|npmrc|nvmrc)$/i.test(name)
}

/** Resolve only explicit, indexed workspace references. Content is bounded before entering a prompt. */
export async function promptWithFileReferences(prompt: string, references: unknown): Promise<string> {
  if (!Array.isArray(references)) return prompt
  const sections: string[] = []
  for (const value of references.slice(0, 10)) {
    if (value === null || typeof value !== 'object') continue
    const reference = value as { path?: unknown, uri?: unknown }
    if (typeof reference.path !== 'string' || typeof reference.uri !== 'string') continue
    if (!prompt.includes(`@${reference.path}`)) continue
    const uri = vscode.Uri.parse(reference.uri, true)
    if (uri.scheme !== 'file' || vscode.workspace.getWorkspaceFolder(uri) === undefined
      || vscode.workspace.asRelativePath(uri, false) !== reference.path
      || uri.toString() !== reference.uri) continue
    const stat = await vscode.workspace.fs.stat(uri)
    if (stat.type !== vscode.FileType.File) throw new Error(`@${reference.path} 不是可读取的普通文件。`)
    if (stat.size > MAX_REFERENCE_FILE_BYTES) throw new Error(`@${reference.path} 超过 64 KiB，请选中相关代码后提问，或让 Agent 使用读取工具分段读取。`)
    const bytes = await vscode.workspace.fs.readFile(uri)
    const text = Buffer.from(bytes).toString('utf8')
    if (text.includes('\0')) throw new Error(`@${reference.path} 是二进制文件，不能作为文本上下文。`)
    const language = (await vscode.workspace.openTextDocument(uri)).languageId
    sections.push(`<referenced-file>\n路径：${reference.path}\n\`\`\`${language}\n${text}\n\`\`\`\n</referenced-file>`)
  }
  return sections.length === 0 ? prompt : `${prompt}\n\n以下是用户通过 @ 明确引用的文件：\n${sections.join('\n\n')}`
}

/** Only ordinary workspace files are sent; untitled, output and external files stay private. */
export interface EditorContext {
  path: string
  uri: string
  language: string
  cursorLine: number
  cursorColumn: number
  selection?: {
    startLine: number
    endLine: number
    text: string
    truncated: boolean
  }
}

export function captureEditorContext(editor: vscode.TextEditor | undefined = vscode.window.activeTextEditor): EditorContext | undefined {
  if (editor === undefined || editor.document.uri.scheme !== 'file' || editor.document.isClosed) return undefined
  if (vscode.workspace.getWorkspaceFolder(editor.document.uri) === undefined) return undefined
  const selection = editor.selection
  const context: EditorContext = {
    path: vscode.workspace.asRelativePath(editor.document.uri, false),
    uri: editor.document.uri.toString(),
    language: editor.document.languageId,
    cursorLine: selection.active.line + 1,
    cursorColumn: selection.active.character + 1,
  }
  if (selection.isEmpty) return context
  const text = editor.document.getText(selection)
  return {
    ...context,
    selection: {
      startLine: selection.start.line + 1,
      endLine: selection.end.line + 1,
      text: text.slice(0, MAX_SELECTION_CHARACTERS),
      truncated: text.length > MAX_SELECTION_CHARACTERS,
    },
  }
}

/** Delimit editor data so it cannot be mistaken for part of the user's typed instruction. */
export function promptWithEditorContext(prompt: string, context: EditorContext | undefined): string {
  if (context === undefined) return prompt
  const lines = [
    prompt,
    '',
    '<editor-context>',
    `当前文件：${context.path}`,
    `光标位置：第 ${context.cursorLine} 行，第 ${context.cursorColumn} 列。`,
  ]
  if (context.selection === undefined) {
    lines.push('用户未选择代码；需要查看文件时请使用读取工具，不要假设文件内容。')
  } else {
    lines.push(`用户选中了第 ${context.selection.startLine}–${context.selection.endLine} 行。`)
    if (context.selection.truncated) lines.push(`选区过大，以下仅包含前 ${MAX_SELECTION_CHARACTERS} 个字符；需要完整内容时请使用读取工具。`)
    lines.push('选中代码：', '```' + context.language, context.selection.text, '```')
  }
  lines.push('以上是与用户提问分开的编辑器上下文。')
  lines.push('</editor-context>')
  return lines.join('\n')
}

export function contextLabel(context: EditorContext): string {
  const range = context.selection === undefined
    ? `:${context.cursorLine}`
    : `:${context.selection.startLine}${context.selection.endLine === context.selection.startLine ? '' : `–${context.selection.endLine}`}`
  return `${basename(context.path)}${range}`
}

export async function openEditorReference(value: unknown): Promise<void> {
  if (value === null || typeof value !== 'object') return
  const reference = value as { uri?: unknown, line?: unknown }
  if (typeof reference.uri !== 'string' || typeof reference.line !== 'number'
    || !Number.isSafeInteger(reference.line) || reference.line < 1) return
  const uri = vscode.Uri.parse(reference.uri, true)
  if (uri.scheme !== 'file' || vscode.workspace.getWorkspaceFolder(uri) === undefined) return
  const document = await vscode.workspace.openTextDocument(uri)
  const line = Math.min(reference.line - 1, document.lineCount - 1)
  const position = new vscode.Position(line, 0)
  await vscode.window.showTextDocument(document, { selection: new vscode.Selection(position, position), preview: false })
}
