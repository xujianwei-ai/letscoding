import { randomBytes } from 'node:crypto'
import { appendFile, mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import * as vscode from 'vscode'
import { AgentController } from './agentController.js'
import { errorText } from './diagnostics.js'
import { allWorkspaceFiles, captureEditorContext, contextLabel, openEditorReference, promptWithEditorContext, promptWithFileReferences, workspaceFiles } from './context.js'
import { onEditConflict } from './conflicts.js'
import { confirmRestore } from './checkpoints.js'
import { sessionExportFilename, sessionToMarkdown } from './sessionExport.js'
import type { SdkModelCatalog } from '@deepseek-ai/dsh-sdk-client'
import { migrateRemovedBuiltinRoute as migrateModelRoute } from './modelRouting.js'
import type { ModelRoute } from './modelRouting.js'

function isModelRoute(value: unknown): value is ModelRoute {
  return value !== null && typeof value === 'object'
    && typeof (value as ModelRoute).provider === 'string' && (value as ModelRoute).provider.length > 0
    && typeof (value as ModelRoute).model === 'string' && (value as ModelRoute).model.length > 0
}

function isCatalog(value: unknown): value is SdkModelCatalog {
  if (value === null || typeof value !== 'object') return false
  const catalog = value as Partial<SdkModelCatalog>
  return Array.isArray(catalog.groups) && Array.isArray(catalog.failures)
    && catalog.groups.every(group => group !== null && typeof group === 'object'
      && typeof group.id === 'string' && typeof group.name === 'string' && Array.isArray(group.models)
      && group.models.every(model => model !== null && typeof model === 'object'
        && typeof model.id === 'string' && typeof model.name === 'string'))
}

export function activate(context: vscode.ExtensionContext): void {
  const output = vscode.window.createOutputChannel('Coding Agent', { log: true })
  context.subscriptions.push(output)
  output.appendLine('Coding Agent extension activated')
  // One controller survives Webview disposal and recreation, so the current Host
  // and persisted-session selection are not silently lost when the view closes.
  const controller = new AgentController(context, message => {
    output.appendLine(`Agent event: ${String(message.type)}`)
    void activeWebview?.postMessage(message)
  })
  context.subscriptions.push(controller)
  // Pre-warm the read-only DSH Host as soon as the extension activates so the
  // first webview ready event does not pay the Host startup cost.
  if (vscode.workspace.isTrusted) void controller.warmupReadHost().catch(() => undefined)
  context.subscriptions.push(vscode.window.onDidCloseTerminal(terminal => {
    void controller.finishRerun(terminal, terminal.exitStatus?.code).catch(error => report(error, '读取测试重跑结果失败'))
  }))
  context.subscriptions.push(vscode.window.onDidStartTerminalShellExecution(event => {
    void controller.finishRerunExecution(event.terminal, event.execution.commandLine.value, undefined, true)
  }))
  context.subscriptions.push(vscode.window.onDidEndTerminalShellExecution(event => {
    void controller.finishRerunExecution(event.terminal, event.execution.commandLine.value, event.exitCode, false).catch(error => report(error, '读取测试重跑结果失败'))
  }))
  context.subscriptions.push(vscode.workspace.registerTextDocumentContentProvider('coding-agent-checkpoint', {
    async provideTextDocumentContent(uri) {
      const query = new URLSearchParams(uri.query)
      const sessionId = query.get('sessionId')
      const workspace = query.get('workspace')
      const path = query.get('path')
      const userSeq = Number(query.get('userSeq'))
      if (sessionId === null || workspace === null || path === null || !Number.isSafeInteger(userSeq) || userSeq < 0) throw new Error('代码对比参数无效。')
      return (await controller.checkpointBaseline(sessionId, userSeq, path, workspace)).toString('utf8')
    },
  }))
  let indexedFiles: Awaited<ReturnType<typeof workspaceFiles>> = []
  let indexedAllFiles: Awaited<ReturnType<typeof workspaceFiles>> = []
  let indexedVersion = 0
  const fileWatcher = vscode.workspace.createFileSystemWatcher('**/*')
  const invalidateFiles = (): void => { indexedFiles = []; indexedVersion++ }
  fileWatcher.onDidCreate(invalidateFiles, undefined, context.subscriptions)
  fileWatcher.onDidDelete(invalidateFiles, undefined, context.subscriptions)
  context.subscriptions.push(fileWatcher)

  // --- P0-1/P0-3: File deletion protection and audit log ---
  const auditLogPath = resolve(context.globalStorageUri.fsPath, 'operations.log')
  const logOperation = async (op: string, detail: string): Promise<void> => {
    try {
      await mkdir(context.globalStorageUri.fsPath, { recursive: true })
      const line = `${new Date().toISOString()} ${op} ${detail}\n`
      await appendFile(auditLogPath, line, 'utf8')
    } catch { /* audit log failure must not break extension */ }
  }
  // Log file modifications for audit trail
  const logFileChange = async (op: 'CREATE' | 'MODIFY' | 'DELETE', uri: vscode.Uri): Promise<void> => {
    const workspace = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath
    if (workspace === undefined || !uri.fsPath.startsWith(workspace)) return
    if (isProtected(uri.fsPath)) return
    if (!isSourceFile(uri.fsPath)) return
    await logOperation(op, vscode.workspace.asRelativePath(uri, false))
  }
  const protectedPaths = new Set([
    '.git', 'node_modules', '.dsh-dev', '.vscode-agent-dev', '.venv',
    '.env', '.env.local', '.env.development', '.env.production',
  ])
  const isProtected = (fsPath: string): boolean => {
    const parts = fsPath.split(/[\\/]/)
    return parts.some(part => protectedPaths.has(part))
  }
  const isSourceFile = (fsPath: string): boolean => {
    return /\.(ts|tsx|js|jsx|json|cjs|mjs|mts|md|svg|yml|yaml)$/.test(fsPath)
  }
  context.subscriptions.push(vscode.workspace.onWillDeleteFiles(async event => {
    const workspace = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath
    if (workspace === undefined) return
    const files = event.files.filter(uri => {
      const path = uri.fsPath
      // Never block deletions outside the workspace
      if (!path.startsWith(workspace)) return false
      // Skip protected/system paths (they are not tracked by checkpoints anyway)
      if (isProtected(path)) return false
      // Only intercept source/config files that checkpoints would track
      return isSourceFile(path)
    })
    if (files.length === 0) return
    const fileList = files.map(uri => vscode.workspace.asRelativePath(uri, false)).join('\n')
    const message = files.length === 1
      ? `即将删除文件：${fileList}`
      : `即将删除 ${files.length} 个文件：\n${fileList}`
    const choice = await vscode.window.showWarningMessage(
      message,
      { modal: true, detail: '此操作将永久删除文件，且可能无法通过检查点恢复。' },
      '删除',
      '取消',
    )
    if (choice !== '删除') {
      event.waitUntil(Promise.reject(new Error('用户取消了文件删除')))
      return
    }
    // Audit log the deletion
    for (const uri of files) {
      await logFileChange('DELETE', uri)
    }
  }))
  // Audit log file creations and modifications (from Agent tools)
  context.subscriptions.push(vscode.workspace.onDidCreateFiles(event => {
    for (const uri of event.files) void logFileChange('CREATE', uri)
  }))
  // Note: VS Code does not expose onDidChangeFiles; file modifications are tracked
  // through the file watcher and document save events instead.
  let activeWebview: vscode.Webview | undefined
  let catalogRequest = 0
  let catalogLoading = false
  let sessionRequest = 0
  let sessionLoading = false
  let fileRequest = 0
  let fileListing: Promise<void> | undefined
  const report = (error: unknown, fallback: string): void => {
    output.appendLine(`${fallback}: ${errorText(error)}`)
    void activeWebview?.postMessage({ type: 'error', text: `${fallback}：${error instanceof Error ? error.message : errorText(error)}` })
  }
  const sendModelConfiguration = (webview: vscode.Webview, selectionId?: number): void => {
    const route = currentModelRoute()
    void webview.postMessage({ type: 'modelConfig', ...route, label: `${route.provider}/${route.model}`, ...selectionId === undefined ? {} : { selectionId } })
  }
  let modelSelection = Promise.resolve()
  const saveModelRoute = async (route: ModelRoute): Promise<void> => {
    const config = vscode.workspace.getConfiguration('privateCodingAgent')
    await config.update('provider', route.provider, vscode.ConfigurationTarget.Workspace)
    await config.update('model', route.model, vscode.ConfigurationTarget.Workspace)
  }
  const selectModel = (route: ModelRoute, webview: vscode.Webview, selectionId?: number): Promise<void> => {
    const pending = modelSelection.then(async () => {
      const catalog = await controller.modelCatalog()
      // DeepSeek built-ins (deepseek-account / deepseek-official) and the user's
      // custom `deepseek` preset are interchangeable for model selection purposes.
      const DEEPSEEK_FAMILY = ['deepseek', 'deepseek-account', 'deepseek-official']
      const providerMatched = DEEPSEEK_FAMILY.includes(route.provider)
        ? catalog.groups.some(group => DEEPSEEK_FAMILY.includes(group.id) && group.models.some(model => model.id === route.model))
        : catalog.groups.some(group => group.id === route.provider && group.models.some(model => model.id === route.model))
      if (!providerMatched) {
        if (catalog.groups.length === 0 && catalog.failures.length === 0) {
          throw new Error('当前 DSH 目录中没有可用模型。请先通过“添加模型服务”配置 API Key / 其他模型；扩展默认复用 DSH_HOME 或 ~/.dsh，也可在 privateCodingAgent.dshHome 中指定已有 DSH 目录。')
        }
        throw new Error(`模型 ${route.provider}/${route.model} 不在当前 DSH 目录中，请重新选择。目录读取失败：${catalog.failures.map(failure => `${failure.id}: ${failure.message}`).join('；') || '无'}`)
      }
      await saveModelRoute(route)
      void webview.postMessage({ type: 'modelCatalog', catalog })
      sendModelConfiguration(webview, selectionId)
    })
    modelSelection = pending.catch(error => {
      output.appendLine(`Model configuration failed: ${errorText(error)}`)
      void webview.postMessage({ type: 'error', text: `模型设置保存失败：${error instanceof Error ? error.message : errorText(error)}` })
      sendModelConfiguration(webview, selectionId)
    })
    return pending
  }
  const sendEditorContext = (webview: vscode.Webview): void => {
    const context = captureEditorContext()
    void webview.postMessage({ type: 'editorContext', context, label: context === undefined ? '' : contextLabel(context) })
  }
  const migrateRemovedBuiltinRoute = async (webview: vscode.Webview, catalog: SdkModelCatalog): Promise<void> => {
    const previous = currentModelRoute()
    const config = vscode.workspace.getConfiguration('privateCodingAgent')
    const migrated = await migrateModelRoute(previous, catalog, (provider, model) => config.update(provider, model, vscode.ConfigurationTarget.Workspace))
    if (migrated === undefined) return
    output.appendLine(`Removed built-in model migrated: ${previous.provider}/${previous.model} -> ${migrated.provider}/${migrated.model}`)
    sendModelConfiguration(webview)
    void webview.postMessage({ type: 'status', status: 'idle',
      text: `旧内置模型 ${previous.provider}/${previous.model} 已移除，已恢复为 ${migrated.provider}/${migrated.model}；历史会话保留，后续消息将使用新模型。` })
  }
  const restoreTrustedWorkspace = async (webview: vscode.Webview): Promise<void> => {
    if (!vscode.workspace.isTrusted) {
      void webview.postMessage({ type: 'workspaceTrust', trusted: false })
      await controller.restoreSelection()
      return
    }
    void webview.postMessage({ type: 'workspaceTrust', trusted: true })
    void webview.postMessage({ type: 'modelCatalogStatus', status: 'loading' })
    // Load model catalog and session list in parallel; both are independent
    // read-only queries that share the same warm read-Host.
    const [catalog, sessionResult] = await Promise.all([
      controller.modelCatalog(),
      controller.listSessions(),
    ])
    await migrateRemovedBuiltinRoute(webview, catalog)
    if (vscode.workspace.isTrusted && activeWebview === webview) void webview.postMessage({ type: 'modelCatalog', catalog })
    if (vscode.workspace.isTrusted && activeWebview === webview) {
      void webview.postMessage({ type: 'sessionList', sessions: sessionResult.sessions, activeSessionId: controller.persistedSessionId })
    }
    await controller.restoreSelection()
  }
  context.subscriptions.push(vscode.workspace.onDidGrantWorkspaceTrust(() => {
    if (activeWebview === undefined) return
    void restoreTrustedWorkspace(activeWebview).catch(error => report(error, '信任工作区后初始化失败'))
  }))
  context.subscriptions.push(vscode.commands.registerCommand('privateCodingAgent.openDiff', async (path: string, userSeq: number, sessionId?: string) => {
    await controller.openDiff(path, userSeq, sessionId).catch(error => report(error, '打开代码对比失败'))
  }))
  if (process.env.VSCODE_AGENT_DEBUG === '1') {
    context.subscriptions.push(vscode.commands.registerCommand('privateCodingAgent.modelCatalog', async () => controller.modelCatalog()))
    context.subscriptions.push(vscode.commands.registerCommand('privateCodingAgent.debugController', () => controller))
    context.subscriptions.push(vscode.commands.registerCommand('privateCodingAgent.rerunVerification', async (command: string) => {
      await controller.rerunVerification(command)
    }))
    context.subscriptions.push(vscode.commands.registerCommand('privateCodingAgent.openTestLocation', async (uriText: string, line: number) => {
      const uri = vscode.Uri.parse(uriText)
      const document = await vscode.workspace.openTextDocument(uri)
      const target = Math.max(0, Math.min(line - 1, document.lineCount - 1))
      const editor = await vscode.window.showTextDocument(document, { preview: false })
      editor.selection = new vscode.Selection(target, 0, target, 0)
      editor.revealRange(new vscode.Range(target, 0, target, 0), vscode.TextEditorRevealType.InCenter)
    }))
  }
  const modelError = (error: unknown, params: { apiKey?: unknown }): string => {
    let text = errorText(error)
    if (typeof params?.apiKey === 'string' && params.apiKey.length > 0) {
      for (const secret of new Set([params.apiKey, params.apiKey.trim()])) {
        if (secret.length > 0) text = text.replaceAll(secret, '[已隐藏的 API Key]')
      }
    }
    return text
  }
  const provider: vscode.WebviewViewProvider = {
    resolveWebviewView(view) {
      activeWebview = view.webview
      view.webview.options = {
        enableScripts: true,
        localResourceRoots: [context.extensionUri],
      }
      view.webview.html = html(view.webview, context.extensionUri)
      sendModelConfiguration(view.webview)
      sendEditorContext(view.webview)
      view.webview.onDidReceiveMessage(message => {
        if (!vscode.workspace.isTrusted && !['ready', 'manageTrust', 'fileList'].includes(String(message?.type))) return
        output.appendLine(`Webview message: ${String(message?.type)}`)
        if (message.type === 'ready') {
          void sendModelConfiguration(view.webview)
          void sendEditorContext(view.webview)
          // Send the current permission mode so the webview can sync its UI
          const currentPermissionMode = context.workspaceState.get<'read-only' | 'workspace-write' | 'danger-full-access'>('permissionMode') ?? 'workspace-write'
          void view.webview.postMessage({ type: 'config', permissionMode: currentPermissionMode })
          void restoreTrustedWorkspace(view.webview).catch(error => report(error, '初始化工作区失败'))
        }
        if (message.type === 'discoverModels') {
          void controller.discoverModels(message.params).then(models => {
            void view.webview.postMessage({ type: 'discoverModelsResult', requestId: message.requestId, models })
          }, error => void view.webview.postMessage({ type: 'discoverModelsResult', requestId: message.requestId, error: modelError(error, message.params) }))
          return
        }
        if (message.type === 'testModel') {
          void controller.testModel(message.params).then(result => {
            void view.webview.postMessage({ type: 'testModelResult', requestId: message.requestId, result })
          }, error => void view.webview.postMessage({ type: 'testModelResult', requestId: message.requestId, error: modelError(error, message.params) }))
          return
        }
        if (message.type === 'saveCustomProvider') {
          void controller.saveProvider(message.params).then(result => {
            const selection = modelSelection.then(async () => {
              await saveModelRoute({ provider: result.provider, model: message.params.models[0].id.trim() })
              const catalog = await controller.modelCatalog()
              void view.webview.postMessage({ type: 'modelCatalog', catalog })
              sendModelConfiguration(view.webview)
            })
            modelSelection = selection.catch(() => undefined)
            return selection.then(() => {
              void view.webview.postMessage({ type: 'saveCustomProviderResult', requestId: message.requestId, result })
            }, error => {
              void view.webview.postMessage({ type: 'saveCustomProviderResult', requestId: message.requestId,
                error: `模型服务已保存，但选择或刷新目录失败：${modelError(error, message.params)}` })
            })
          }, error => void view.webview.postMessage({ type: 'saveCustomProviderResult', requestId: message.requestId, error: modelError(error, message.params) }))
          return
        }
        if (message.type === 'providerConfig') {
          void controller.providerConfig(message.params).then(result => {
            void view.webview.postMessage({ type: 'providerConfigResult', requestId: message.requestId, result })
          }, error => void view.webview.postMessage({ type: 'providerConfigResult', requestId: message.requestId, error: modelError(error, message.params) }))
          return
        }
        if (message.type === 'deleteCustomProvider') {
          const provider = message.params.provider
          const attemptDelete = async (retried: boolean): Promise<void> => {
            try {
              await controller.deleteProvider(message.params)
              if (currentModelRoute().provider === provider) {
                const config = vscode.workspace.getConfiguration('privateCodingAgent')
                await config.update('provider', undefined, vscode.ConfigurationTarget.Workspace)
                await config.update('model', undefined, vscode.ConfigurationTarget.Workspace)
              }
              const catalog = await controller.modelCatalog()
              void view.webview.postMessage({ type: 'modelCatalog', catalog })
              void view.webview.postMessage({ type: 'deleteCustomProviderResult', requestId: message.requestId })
            } catch (error) {
              const text = modelError(error, message.params)
              // Retry once on settings conflict (stale revision from optimistic locking)
              if (!retried && (text.includes('settings/conflict') || text.includes('revision'))) {
                output.appendLine(`[Model] Delete conflicted for ${provider}, retrying with fresh revision…`)
                return attemptDelete(true)
              }
              void view.webview.postMessage({ type: 'deleteCustomProviderResult', requestId: message.requestId, error: text })
            }
          }
          void attemptDelete(false)
          return
        }
        if (message.type === 'manageTrust') {
          void vscode.commands.executeCommand('workbench.trust.manage').then(() => {
            void view.webview.postMessage({ type: 'workspaceTrust', trusted: vscode.workspace.isTrusted })
          }, error => report(error, '打开工作区信任设置失败'))
        }
        if (message.type === 'openContext') {
          void openEditorReference(message.reference).catch(error => report(error, '打开编辑器引用失败'))
        }
        if (message.type === 'openExternal' && typeof message.url === 'string') {
          // Route external http(s) links through VS Code so they open in the
          // system browser instead of being blocked by the webview sandbox.
          const url = message.url as string
          if (/^https?:\/\//.test(url)) {
            void vscode.env.openExternal(vscode.Uri.parse(url))
          }
        }
        if (message.type === 'openFile' && typeof message.path === 'string') {
          void (async () => {
            try {
              const workspace = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath
              if (workspace === undefined) return
              const path = message.path as string
              if (path.includes('..') || path.startsWith('/') || /^[A-Za-z]:/.test(path)) return
              const uri = vscode.Uri.joinPath(vscode.Uri.file(workspace), path)
              // Images and other binaries cannot be opened as text documents;
              // route them through the default editor (image preview, hex, etc.).
              if (/\.(?:png|jpe?g|gif|webp|ico|bmp|svg|pdf|zip|mp[34]|wav|ogg|avi|mov)$/i.test(path)) {
                await vscode.commands.executeCommand('vscode.open', uri)
                return
              }
              const document = await vscode.workspace.openTextDocument(uri)
              await vscode.window.showTextDocument(document, { preview: false })
            } catch (error) {
              void view.webview.postMessage({ type: 'error', text: `打开文件失败：${errorText(error)}` })
            }
          })()
        }
        if (message.type === 'fileList') {
          if (!vscode.workspace.isTrusted) {
            void view.webview.postMessage({ type: 'fileList', files: [], allFiles: [] })
            return
          }
          const request = ++fileRequest
          const version = indexedVersion
          if (indexedFiles.length > 0) {
            void view.webview.postMessage({ type: 'fileList', files: indexedFiles, allFiles: indexedAllFiles })
            return
          }
          fileListing ??= Promise.all([workspaceFiles(), allWorkspaceFiles()]).then(([text, all]) => {
            if (version === indexedVersion) { indexedFiles = text; indexedAllFiles = all }
          }).catch(error => report(error, '工作区文件索引读取失败'))
            .finally(() => { fileListing = undefined })
          void fileListing.then(() => {
            if (request === fileRequest && activeWebview === view.webview) void view.webview.postMessage({ type: 'fileList', files: indexedFiles, allFiles: indexedAllFiles })
          })
        }
        if (message.type === 'sessionList') {
          if (controller === undefined || sessionLoading) return
          sessionLoading = true
          void view.webview.postMessage({ type: 'sessionListStatus', status: 'loading' })
          const request = ++sessionRequest
          void controller.listSessions().then(result => {
            if (request !== sessionRequest || activeWebview !== view.webview) return
            void view.webview.postMessage({ type: 'sessionList', sessions: result.sessions, activeSessionId: controller?.persistedSessionId })
          }, error => {
            report(error, '历史会话读取失败')
            void view.webview.postMessage({ type: 'sessionListStatus', status: 'error' })
          }).finally(() => { sessionLoading = false })
        }
        if (message.type === 'sessionSelect' && typeof message.sessionId === 'string' && message.sessionId.length > 0) {
          void view.webview.postMessage({ type: 'sessionListStatus', status: 'loading' })
          const request = ++sessionRequest
          void controller?.selectSession(message.sessionId).then(() => {
            if (request !== sessionRequest || activeWebview !== view.webview) return
            void view.webview.postMessage({ type: 'sessionListStatus', status: 'ready' })
          }, error => {
            report(error, '会话切换失败')
            void view.webview.postMessage({ type: 'sessionListStatus', status: 'error' })
          })
        }
        if (message.type === 'sessionDelete' && typeof message.sessionId === 'string') {
          // The Webview has already removed the row. No modal, preliminary list query,
          // or disabled picker: DSH/checkpoint cleanup runs behind the active workflow.
          const sessionId = message.sessionId
          const session = message.session as { cwd?: unknown } | undefined
          const workspace = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath
          if (session?.cwd !== workspace) {
            void view.webview.postMessage({ type: 'sessionDeleted', sessionId, session, error: true, activeSessionId: controller.persistedSessionId })
            report(new Error('会话已删除或不属于当前工作区。'), '会话删除失败')
            return
          }
          void controller.deleteSession(sessionId).then(() => {
            void view.webview.postMessage({ type: 'sessionDeleted', sessionId, activeSessionId: controller.persistedSessionId })
          }, async error => {
            const result = await controller.listSessions().catch(() => undefined)
            const restorable = result?.sessions.some(item => item.id === sessionId) ?? false
            report(new Error(`${error instanceof Error ? error.message : errorText(error)}${restorable ? '' : '；请刷新会话列表或重载窗口。'}`), '会话删除失败')
            void view.webview.postMessage({ type: 'sessionDeleted', sessionId, session, error: true, restorable, activeSessionId: controller.persistedSessionId })
          })
        }
        if (message.type === 'modelCatalog') {
          const request = ++catalogRequest
          if (controller === undefined || catalogLoading) return
          catalogLoading = true
          void view.webview.postMessage({ type: 'modelCatalogStatus', status: 'loading' })
          void controller.modelCatalog().then(catalog => {
            if (request === catalogRequest) void view.webview.postMessage({ type: 'modelCatalog', catalog })
          }, (error: unknown) => {
            output.appendLine(`Model catalog failed: ${errorText(error)}`)
            if (request === catalogRequest) void view.webview.postMessage({ type: 'modelCatalogStatus', status: 'error',
              text: `模型目录读取失败：${error instanceof Error ? error.message : errorText(error)}` })
          }).finally(() => { catalogLoading = false })
        }
        if (message.type === 'readFileForImage' && typeof message.path === 'string') {
          void (async () => {
            try {
              const uri = vscode.Uri.file(message.path)
              const data = await vscode.workspace.fs.readFile(uri)
              const base64 = Buffer.from(data).toString('base64')
              const ext = message.path.toLowerCase().split('.').pop() ?? 'png'
              const mime = ext === 'jpg' ? 'image/jpeg' : `image/${ext}`
              void view.webview.postMessage({
                type: 'imageFileRead',
                path: message.path,
                data: base64,
                mimeType: mime,
                name: message.path.split('/').pop() ?? 'image',
              })
            } catch (error) {
              void view.webview.postMessage({ type: 'error', text: `读取图片失败: ${errorText(error)}` })
            }
          })()
          return
        }
        if (message.type === 'send' && typeof message.text === 'string') {
          const editorContext = captureEditorContext()
          const runTarget = controller.prepareRun()
          view.webview.postMessage({ type: 'busy', busy: true, sessionId: runTarget })
          void (async () => {
            const route = isModelRoute(message.route) ? message.route : undefined
            if (route !== undefined) await selectModel(route, view.webview)
            controller.editorContext = editorContext
            const prompt = await promptWithFileReferences(message.text, message.references)
            const contentBlocks = buildContentBlocks(promptWithEditorContext(prompt, editorContext), message.attachments)
            await controller.run(contentBlocks, message.text, runTarget, route)
          })().catch(error => {
            output.appendLine(errorText(error))
            void view.webview.postMessage({ type: 'error', text: errorText(error) })
          })
        }
        if (message.type === 'resend' && typeof message.seq === 'number' && typeof message.text === 'string') {
          if (!message.text.trim() && (!message.attachments || message.attachments.length === 0)) return
          const targetSessionId = message.sessionId || controller.persistedSessionId
          if (!targetSessionId) {
            void view.webview.postMessage({ type: 'error', text: '当前没有可恢复的历史会话，请先发送一条消息创建会话。' })
            return
          }
          void view.webview.postMessage({ type: 'busy', busy: true, sessionId: targetSessionId })
          void view.webview.postMessage({ type: 'status', status: 'running', text: '正在准备回滚…', sessionId: targetSessionId })
          void (async () => {
            const started = performance.now()
            // Kick off the expensive work immediately and let it overlap with the
            // user's confirmation: the restore preview scans snapshot files, and the
            // Host warmup resumes a cold session. The dialog wording only needs the
            // cheap index-only checkpoint probe, so it opens without waiting for
            // either of them.
            const previewPromise = controller.previewRestore(message.seq, targetSessionId)
              .catch(error => {
                output.appendLine(`History restore preview failed: ${errorText(error)}`)
                return undefined
              })
            controller.warmupRewind(targetSessionId)
            const hasCheckpoint = await controller.hasCheckpointFor(message.seq, targetSessionId)
              .catch(() => false)
            const dirty = vscode.workspace.textDocuments.filter(document => document.uri.scheme === 'file' && document.isDirty)
            const decision = await confirmRestore(message.text, { dirtyEditors: dirty.length }, hasCheckpoint)
            if (decision === 'cancel') {
              await view.webview.postMessage({ type: 'busy', busy: false })
              return
            }
            const plan = decision === 'restore' ? await previewPromise : undefined
            output.appendLine(`History restore preview: ${Math.round(performance.now() - started)}ms`)
            void view.webview.postMessage({ type: 'status', status: 'running', text: '正在回滚并重新发送…', sessionId: targetSessionId })
            for (const document of dirty) if (!await document.save()) {
              await view.webview.postMessage({ type: 'busy', busy: false })
              return
            }
            const route = isModelRoute(message.route) ? message.route : undefined
            if (route !== undefined) await selectModel(route, view.webview)
            const editorContext = captureEditorContext()
            controller.editorContext = editorContext
            const prompt = await promptWithFileReferences(message.text, message.references)
            const contentBlocks = buildContentBlocks(promptWithEditorContext(prompt, editorContext), message.attachments)
            await controller.resendFromHistory(message.seq, contentBlocks, message.text, route, plan, decision === 'restore', targetSessionId)
            output.appendLine(`History rollback and resend: ${Math.round(performance.now() - started)}ms total, targetSessionId=${targetSessionId}`)
          })().catch(error => report(error, '历史恢复并重发失败'))
        }
        if (message.type === 'undoRestore') void controller.undoRestore().catch(error => report(error, '撤销代码恢复失败'))
        if (message.type === 'queue' && typeof message.text === 'string') {
          const editorContext = captureEditorContext()
          const sessionId = typeof message.sessionId === 'string' ? message.sessionId : controller.persistedSessionId
          void (async () => {
            const route = isModelRoute(message.route) ? message.route : undefined
            const prompt = await promptWithFileReferences(message.text, message.references)
            const contentBlocks = buildContentBlocks(promptWithEditorContext(prompt, editorContext), message.attachments)
            const queued = controller.queueMessage(contentBlocks, message.text, route, sessionId)
            if (queued === undefined) {
              // Turn already finished between Webview and extension: send normally.
              if (route !== undefined) await selectModel(route, view.webview)
              controller.editorContext = editorContext
              await controller.run(contentBlocks, message.text, sessionId, route)
            }
          })().catch(error => {
            output.appendLine(errorText(error))
            void view.webview.postMessage({ type: 'error', text: errorText(error) })
          })
        }
        if (message.type === 'queueAction' && typeof message.action === 'string') {
          if (message.action === 'steer') void controller.steerQueued(message.sessionId).catch(error => report(error, '立即执行排队消息失败'))
          if (message.action === 'cancel') controller.cancelQueued(message.sessionId)
        }
        if (message.type === 'steer' && typeof message.text === 'string') {
          const editorContext = captureEditorContext()
          const runTarget = controller.prepareRun()
          void (async () => {
            const route = isModelRoute(message.route) ? message.route : undefined
            if (route !== undefined) await selectModel(route, view.webview)
            controller.editorContext = editorContext
            const prompt = await promptWithFileReferences(message.text, message.references)
            const contentBlocks = buildContentBlocks(promptWithEditorContext(prompt, editorContext), message.attachments)
            await controller.steerQueued(runTarget)
            await controller.run(contentBlocks, message.text, runTarget, route)
          })().catch(error => {
            output.appendLine(errorText(error))
            void view.webview.postMessage({ type: 'error', text: errorText(error) })
          })
        }
        if (message.type === 'stop') void controller?.stop(message.sessionId).catch(error => report(error, '停止任务失败'))
        if (message.type === 'new') controller.newSession()
        if (message.type === 'openDiff') void controller.openDiff(typeof message.path === 'string' ? message.path : undefined, typeof message.seq === 'number' ? message.seq : undefined, message.sessionId).catch(error => report(error, '打开代码对比失败'))
        if (message.type === 'openLocation' && typeof message.uri === 'string') void (async () => {
          const uri = vscode.Uri.parse(message.uri)
          if (uri.scheme !== 'file' || vscode.workspace.getWorkspaceFolder(uri)?.uri.fsPath !== vscode.workspace.workspaceFolders?.[0]?.uri.fsPath) throw new Error('失败位置不属于当前工作区。')
          const document = await vscode.workspace.openTextDocument(uri)
          const line = Math.max(0, Math.min(Number(message.line) - 1 || 0, document.lineCount - 1))
          const editor = await vscode.window.showTextDocument(document, { preview: false })
          editor.selection = new vscode.Selection(line, 0, line, 0)
          editor.revealRange(new vscode.Range(line, 0, line, 0), vscode.TextEditorRevealType.InCenter)
        })().catch(error => report(error, '打开失败测试位置失败'))
        if (message.type === 'rerunTests' && typeof message.command === 'string') void controller.rerunVerification(message.command).catch(error => report(error, '重跑失败测试失败'))
        if (message.type === 'resume') void controller?.resume(message.sessionId)
        if (message.type === 'renameSession' && typeof message.sessionId === 'string' && typeof message.title === 'string') {
          void controller.renameSession(message.sessionId, message.title).then(() => {
            void view.webview.postMessage({ type: 'sessionRenamed', sessionId: message.sessionId, title: message.title.trim() })
          }, error => {
            report(error, '会话重命名失败')
            void view.webview.postMessage({ type: 'sessionRenamed', sessionId: message.sessionId, error: errorText(error) })
          })
        }
        if (message.type === 'exportSession' && typeof message.sessionId === 'string') {
          void (async () => {
            try {
              const history = await controller.sessionHistory(message.sessionId)
              // Apply the user's rename override when present so the export header matches the UI.
              const overrides = (await controller.listSessions()).sessions.find(s => s.id === message.sessionId)
              const markdown = sessionToMarkdown(history, overrides?.title)
              const suggestedName = sessionExportFilename(overrides?.title ?? history.session.title, history.session.id)
              const workspace = vscode.workspace.workspaceFolders?.[0]?.uri
              const target = await vscode.window.showSaveDialog({
                defaultUri: workspace === undefined ? vscode.Uri.file(suggestedName) : vscode.Uri.joinPath(workspace, suggestedName),
                filters: { 'Markdown': ['md'] },
                saveLabel: '导出会话',
              })
              if (target === undefined) {
                void view.webview.postMessage({ type: 'sessionExported', sessionId: message.sessionId, cancelled: true })
                return
              }
              await vscode.workspace.fs.writeFile(target, Buffer.from(markdown, 'utf8'))
              void view.webview.postMessage({ type: 'sessionExported', sessionId: message.sessionId, path: target.fsPath })
              void view.webview.postMessage({ type: 'status', status: 'idle', text: `会话已导出：${target.fsPath}` })
            } catch (error) {
              report(error, '导出会话失败')
              void view.webview.postMessage({ type: 'sessionExported', sessionId: message.sessionId, error: errorText(error) })
            }
          })()
        }
        if (message.type === 'answerQuestions') controller?.answerQuestions(message.id, message.answers, message.sessionId)
        if (message.type === 'permissionMode' && (message.value === 'read-only' || message.value === 'workspace-write' || message.value === 'danger-full-access')) {
          void controller.setPermissionMode(message.value, message.sessionId).catch(error => report(error, '权限模式设置失败'))
        }
        if (message.type === 'approvalResponse' && typeof message.requestId === 'string') {
          controller.handleApprovalResponse(message.requestId, message.outcome, message.sessionId)
        }
        if (message.type === 'allowToolForSession' && typeof message.tool === 'string') {
          controller.allowToolForSession(message.tool, message.sessionId)
        }
        if (message.type === 'clearApprovalMemory') {
          controller.clearApprovalMemory(message.sessionId)
        }
        if (message.type === 'modelRoute') {
          const route: unknown = message.route
          const valid = route !== null && typeof route === 'object'
            && typeof (route as ModelRoute).provider === 'string' && (route as ModelRoute).provider.length > 0
            && typeof (route as ModelRoute).model === 'string' && (route as ModelRoute).model.length > 0
          if (!valid) return
          const selected = route as ModelRoute
          const selectionId = typeof message.selectionId === 'number' && Number.isSafeInteger(message.selectionId) ? message.selectionId : undefined
          void selectModel(selected, view.webview, selectionId).catch(() => { /* reported with the effective route restored */ })
        }
      })
      // Closing the view releases DOM resources, not the user's running Agent Host.
      view.onDidDispose(() => { activeWebview = undefined })
    },
  }
  const updateEditorContext = (): void => { if (activeWebview !== undefined) sendEditorContext(activeWebview) }
  context.subscriptions.push(vscode.window.onDidChangeActiveTextEditor(updateEditorContext))
  context.subscriptions.push(vscode.window.onDidChangeTextEditorSelection(updateEditorContext))
  context.subscriptions.push(vscode.window.registerWebviewViewProvider('privateCodingAgent.chat', provider, { webviewOptions: { retainContextWhenHidden: true } }))
  context.subscriptions.push(onEditConflict(conflict => {
    void activeWebview?.postMessage({ type: 'conflict', ...conflict })
  }))
  context.subscriptions.push(vscode.commands.registerCommand('privateCodingAgent.newSession', () => { controller.newSession() }))
  context.subscriptions.push(vscode.commands.registerCommand('privateCodingAgent.stop', () => controller?.stop().catch(error => report(error, '停止 Host 失败'))))
  context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(event => {
    if (!event.affectsConfiguration('privateCodingAgent')) return
    // SessionRuntime reads the route once at the next send boundary. Restarting
    // from each provider/model write would capture a half-updated route.
    if (activeWebview !== undefined) sendModelConfiguration(activeWebview)
  }))
  if (process.env.VSCODE_AGENT_DEBUG === '1') {
    context.subscriptions.push(vscode.commands.registerCommand('privateCodingAgent.initializeWorkspace', async () => {
      if (activeWebview === undefined) throw new Error('Agent 视图尚未打开。')
      await restoreTrustedWorkspace(activeWebview)
    }))
  }
  context.subscriptions.push(vscode.commands.registerCommand('privateCodingAgent.testHost', async () => {
    const test = new AgentController(context, message => output.appendLine(`Host test: ${JSON.stringify(message)}`))
    try { await test.run('Reply exactly: VS Code Electron Node OK. Do not use tools.') }
    finally { await test.dispose() }
  }))
}

/** Build DSH content blocks from a text prompt and optional image attachments. */
function buildContentBlocks(
  text: string,
  attachments?: Array<{ type: 'image', data: string, mimeType: string, name?: string }>,
): string | Array<{ type: 'text', text: string } | { type: 'image', data: string, mimeType: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif', name?: string }> {
  if (!attachments || attachments.length === 0) return text
  const blocks: Array<{ type: 'text', text: string } | { type: 'image', data: string, mimeType: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif', name?: string }> = []
  if (text.trim()) blocks.push({ type: 'text', text })
  for (const att of attachments) {
    if (att.type === 'image' && typeof att.data === 'string' && typeof att.mimeType === 'string') {
      const mime = normalizeImageMime(att.mimeType)
      if (mime === undefined) continue
      blocks.push({ type: 'image', data: att.data, mimeType: mime, name: att.name })
    }
  }
  return blocks.length === 1 && blocks[0].type === 'text' ? blocks[0].text : blocks
}

function normalizeImageMime(mime: string): 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif' | undefined {
  if (mime === 'image/png' || mime === 'image/jpeg' || mime === 'image/webp' || mime === 'image/gif') return mime
  // Handle common aliases
  if (mime === 'image/jpg') return 'image/jpeg'
  return undefined
}

export function currentModelRoute(): ModelRoute {
  const config = vscode.workspace.getConfiguration('privateCodingAgent')
  return {
    provider: config.get<string>('provider') || 'deepseek-account',
    model: config.get<string>('model') || 'deepseek-flash',
  }
}

export function html(webview: vscode.Webview, extensionUri: vscode.Uri): string {
  const nonce = randomBytes(16).toString('base64')
  const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', 'webview.js'))
  const iconUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', 'agent.svg'))

  // Read user-customizable style settings
  const config = vscode.workspace.getConfiguration('privateCodingAgent')
  const chatFontSize = config.get<number>('chatFontSize') ?? 13.5
  const chatLineHeight = config.get<number>('chatLineHeight') ?? 1.7
  const chatFontFamily = config.get<string>('chatFontFamily') || ''
  const codeFontSize = config.get<number>('codeFontSize') ?? 12.5
  const reasoningFontSize = config.get<number>('reasoningFontSize') ?? 12

  // Build dynamic font-family declaration
  const fontFamilyDecl = chatFontFamily
    ? `font-family: ${chatFontFamily};`
    : ''

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} data: blob:; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">

  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Coding Agent</title>
  <style>
    :root { color-scheme: var(--vscode-color-scheme, dark); }
    * { box-sizing: border-box; }
    html, body { margin: 0; padding: 0; min-height: 100%; }
    body { display: flex; flex-direction: column; height: 100vh; overflow: hidden; font-family: var(--vscode-font-family); color: var(--vscode-foreground); font-size: 13px; }
    button, select, textarea { font: inherit; }
    button { display: inline-flex; align-items: center; justify-content: center; border: 0; cursor: pointer; }
    button:disabled { opacity: .4; cursor: default; }
    button svg, .icon { width: 16px; height: 16px; flex: 0 0 auto; }
    #topbar { flex: 0 0 auto; display: flex; align-items: center; gap: 4px; padding: 10px 10px 8px; position: relative; }
    #session-picker { position: relative; flex: 1; min-width: 0; }
    #session-select { width: 100%; height: 28px; padding: 3px 22px 3px 6px; border: 1px solid transparent; border-radius: 5px; color: var(--vscode-foreground); background: transparent; font-size: 12px; text-align: left; text-overflow: ellipsis; overflow: hidden; white-space: nowrap; }
    #session-picker::after { content: ''; pointer-events: none; position: absolute; right: 7px; top: 11px; border: 4px solid transparent; border-top-color: var(--vscode-foreground); }
    #session-select::after { content: none; }
    #session-select:hover, #session-select:focus-visible { background: var(--vscode-toolbar-hoverBackground); border-color: var(--vscode-input-border, transparent); outline: none; }
    #session-menu { position: absolute; z-index: 20; top: 31px; left: 0; right: 0; max-height: min(360px, 60vh); overflow-y: auto; padding: 4px; border: 1px solid var(--vscode-widget-border, var(--vscode-input-border)); border-radius: 6px; background: var(--vscode-editorWidget-background); box-shadow: 0 4px 12px var(--vscode-widget-shadow); }
    #session-menu[hidden] { display: none; }
    .session-option, .session-delete { min-height: 28px; border-radius: 4px; background: transparent; color: var(--vscode-foreground); }
    .session-option { display: flex; width: 100%; gap: 8px; padding: 4px 84px 4px 7px; text-align: left; }
    .session-option:hover, .session-option:focus-visible, .session-option[aria-selected="true"] { background: var(--vscode-list-hoverBackground); outline: none; }
    .session-option[aria-selected="true"] { color: var(--vscode-list-activeSelectionForeground); background: var(--vscode-list-activeSelectionBackground); }
    .session-title { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .session-time { margin-left: auto; flex: 0 0 auto; font-size: 11px; color: var(--vscode-descriptionForeground); }
    .session-delete { position: absolute; top: 0; right: 3px; width: 26px; padding: 5px; visibility: hidden; color: var(--vscode-descriptionForeground); }
    .session-rename { position: absolute; top: 0; right: 55px; width: 26px; padding: 5px; visibility: hidden; color: var(--vscode-descriptionForeground); background: transparent; border: none; border-radius: 4px; cursor: pointer; }
    .session-export { position: absolute; top: 0; right: 29px; width: 26px; padding: 5px; visibility: hidden; color: var(--vscode-descriptionForeground); background: transparent; border: none; border-radius: 4px; cursor: pointer; }
    .session-row { position: relative; }
    .session-row:hover .session-delete, .session-row:focus-within .session-delete,
    .session-row:hover .session-rename, .session-row:focus-within .session-rename,
    .session-row:hover .session-export, .session-row:focus-within .session-export { visibility: visible; }
    .session-delete:hover, .session-delete:focus-visible { color: var(--vscode-errorForeground); background: var(--vscode-toolbar-hoverBackground); outline: none; }
    .session-rename:hover, .session-rename:focus-visible,
    .session-export:hover, .session-export:focus-visible { color: var(--vscode-foreground); background: var(--vscode-toolbar-hoverBackground); outline: none; }
    .session-empty { padding: 8px; color: var(--vscode-descriptionForeground); }
    #model option, #model optgroup { color: var(--vscode-dropdown-foreground, var(--vscode-foreground)) !important; background: var(--vscode-dropdown-background, var(--vscode-editorWidget-background, #252526)) !important; }
    #permissionMode option { color: var(--vscode-dropdown-foreground, var(--vscode-foreground)); background: var(--vscode-dropdown-background, var(--vscode-editorWidget-background, #252526)); }
    #model optgroup { font-style: normal; font-weight: 600; }
    .icon-button { width: 28px; height: 28px; padding: 5px; border-radius: 5px; background: transparent; color: var(--vscode-descriptionForeground); }
    .icon-button:hover { background: var(--vscode-toolbar-hoverBackground); color: var(--vscode-foreground); }
    .icon-button:active { transform: scale(0.92); opacity: 0.85; }
    #session-status { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); }
    #tools { position: relative; flex: 0 0 auto; display: none; gap: 2px; padding: 0 10px 8px; }
    #tools.visible { display: flex; }
    #tools .icon-button { width: 30px; height: 30px; }
    #tools-note { margin-left: auto; align-self: center; font-size: 11px; color: var(--vscode-descriptionForeground); }
    #conversation-shell { position: relative; flex: 1 1 auto; min-height: 0; display: flex; flex-direction: column; }
    #conversation { flex: 1 1 auto; min-height: 0; overflow-y: auto; padding: 6px 14px 16px; scrollbar-width: thin; position: relative; }
    #scroll-to-bottom { position: sticky; bottom: 8px; left: 50%; transform: translateX(-50%); z-index: 5; width: 32px; height: 32px; padding: 6px; border: 1px solid var(--vscode-widget-border, var(--vscode-input-border)); border-radius: 50%; background: var(--vscode-input-background); color: var(--vscode-descriptionForeground); cursor: pointer; opacity: 0.9; box-shadow: 0 2px 8px rgba(0,0,0,0.15); display: flex; align-items: center; justify-content: center; }
    #scroll-to-bottom:hover { background: var(--vscode-toolbar-hoverBackground); color: var(--vscode-foreground); opacity: 1; }
    #scroll-to-bottom svg { width: 16px; height: 16px; }
    #scroll-to-bottom[hidden] { display: none; }
    #model-onboarding { flex: 1 1 auto; min-height: 0; overflow-y: auto; padding: 6px 14px 16px; }
    #sticky-prompt { position: absolute; z-index: 4; top: 6px; left: 14px; right: 14px; max-height: calc(100% - 12px); display: none; overflow-y: auto; overscroll-behavior: contain; padding: 10px 12px; border: 1px solid var(--vscode-widget-border, var(--vscode-input-border)); border-radius: 8px; color: var(--vscode-input-foreground); background: var(--vscode-input-background); box-shadow: 0 8px 12px -8px var(--vscode-widget-shadow, #000); }
    #sticky-prompt.visible { display: block; }
    #sticky-prompt .user-collapsed { cursor: pointer; }
    #sticky-prompt.editing { cursor: default; border-color: var(--vscode-focusBorder); border-radius: 12px; }
    #sticky-prompt .history-edit { flex-shrink: 0; }
    .prompt-toggle { position: absolute; top: 5px; right: 5px; display: inline-flex; width: 24px; height: 24px; padding: 5px; border-radius: 4px; color: var(--vscode-descriptionForeground); background: var(--vscode-input-background); }
    .prompt-toggle:hover { color: var(--vscode-foreground); background: var(--vscode-toolbar-hoverBackground); }
    .prompt-toggle svg { width: 14px; height: 14px; }
    #sticky-prompt.expanded .prompt-toggle svg { transform: rotate(180deg); }
    #log { display: flex; flex-direction: column; gap: 18px; }
    #empty { display: flex; flex-direction: column; align-items: center; justify-content: center; min-height: 160px; text-align: center; color: var(--vscode-descriptionForeground); }
    #empty[hidden] { display: none; }
    #empty h1 { margin: 0 0 10px; color: var(--vscode-foreground); font-size: 20px; font-weight: 500; }
    #empty p { margin: 0; font-size: 12px; line-height: 1.6; }
    #empty img { width: 38px; height: 38px; margin-bottom: 18px; opacity: .75; }
    #workspace-trust { align-self: stretch; display: flex; align-items: center; flex-wrap: wrap; gap: 12px; padding: 14px; border: 1px solid var(--vscode-widget-border, var(--vscode-input-border)); border-radius: 8px; line-height: 1.6; }
    #workspace-trust[hidden] { display: none; }
    .workspace-trust-copy { flex: 1 1 180px; min-width: 0; }
    .workspace-trust-copy strong { font-size: 14px; }
    .workspace-trust-copy p { margin: 4px 0 0; color: var(--vscode-descriptionForeground); }
    #trust-workspace { flex: 0 0 auto; margin-left: auto; padding: 6px 12px; white-space: nowrap; border-radius: 5px; color: var(--vscode-button-foreground); background: var(--vscode-button-background); }
    #trust-workspace:hover:not(:disabled) { background: var(--vscode-button-hoverBackground); }
    .message { white-space: pre-wrap; overflow-wrap: anywhere; line-height: 1.65; font-size: 13px; content-visibility: auto; contain-intrinsic-size: auto 80px; }
    .user { position: relative; align-self: stretch; width: 100%; padding: 10px 12px; border: 1px solid var(--vscode-widget-border, var(--vscode-input-border)); border-radius: 8px; color: var(--vscode-input-foreground); background: var(--vscode-input-background); }
    .user:hover { border-color: var(--vscode-focusBorder); }
    .user-collapsed { display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 4; overflow: hidden; white-space: pre-wrap; overflow-wrap: anywhere; line-height: 1.65; padding-right: 32px; }
    #sticky-prompt.expanded .user-collapsed { display: block; -webkit-line-clamp: unset; }
    .user-collapsed::after { content: ''; position: absolute; right: 0; bottom: 0; width: 50px; height: 24px; background: linear-gradient(transparent, var(--vscode-input-background) 80%); }
    #sticky-prompt.expanded .user-collapsed::after { content: none; }
    .history-toggle { position: absolute; top: 5px; right: 5px; display: none; width: 24px; height: 24px; padding: 5px; border-radius: 4px; color: var(--vscode-descriptionForeground); background: var(--vscode-input-background); }
    .user:hover .history-toggle, .user:focus-within .history-toggle { display: inline-flex; }
    .history-toggle:hover { color: var(--vscode-foreground); background: var(--vscode-toolbar-hoverBackground); }
    .history-toggle svg { width: 14px; height: 14px; }
    .history-edit { display: grid; margin: -10px -12px; cursor: default; }
    .history-edit textarea { width: 100%; min-height: 64px; max-height: 220px; resize: vertical; padding: 12px 12px 4px; border: 0; outline: 0; color: var(--vscode-input-foreground); background: transparent; line-height: 1.5; }
    .history-edit .actions { display: flex; align-items: center; gap: 5px; padding: 5px 7px 7px; }
    .history-edit .history-hint { flex: 1; font-size: 10px; line-height: 1.4; color: var(--vscode-descriptionForeground); }
    .history-edit .history-model { max-width: 135px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--vscode-descriptionForeground); font-size: 12px; }
    .history-edit button, .checkpoint-restored button { padding: 5px 8px; border-radius: 5px; color: var(--vscode-button-foreground); background: var(--vscode-button-background); }
    .history-edit .cancel { width: 30px; height: 30px; padding: 7px; color: var(--vscode-descriptionForeground); background: transparent; }
    .history-edit .cancel:hover { background: var(--vscode-toolbar-hoverBackground); }
    .history-edit .history-send { display: inline-flex; align-items: center; justify-content: center; width: 30px; height: 30px; padding: 6px; border-radius: 7px; }
    .history-edit .history-send svg, .history-edit .cancel svg { width: 16px; height: 16px; }
    .user:has(.history-edit) { padding: 10px 12px; border-radius: 12px; box-shadow: 0 2px 8px var(--vscode-widget-shadow, transparent); }
    .user:has(.history-edit):focus-within { border-color: var(--vscode-focusBorder); box-shadow: 0 0 0 1px var(--vscode-focusBorder); }
    .checkpoint-restored { display: flex; align-items: center; gap: 8px; padding: 8px; border: 1px solid var(--vscode-textLink-foreground); border-radius: 6px; font-size: 12px; }
    .context-ref { display: block; width: fit-content; margin: 0 0 6px; padding: 2px 6px; border-radius: 4px; color: var(--vscode-textLink-foreground); background: var(--vscode-textCodeBlock-background); font: 11px var(--vscode-editor-font-family); }
    .context-ref:hover { background: var(--vscode-toolbar-hoverBackground); }
    #context-preview { flex: 0 0 auto; align-self: center; max-width: 160px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; padding: 3px 6px; border-radius: 5px; color: var(--vscode-descriptionForeground); background: transparent; font: 11px var(--vscode-editor-font-family); }
    #context-preview:hover { color: var(--vscode-textLink-foreground); background: var(--vscode-toolbar-hoverBackground); }
    #context-preview[hidden] { display: none; }
    .assistant { padding: 0; }
    /* A growing response must not enter Chromium's skipped-content lifecycle.
       Stable text-only streaming avoids repaint flashes; Markdown is rendered once settled. */
    .assistant.streaming { content-visibility: visible; }
    .assistant .assistant-text { line-height: ${chatLineHeight}; font-size: ${chatFontSize}px; ${fontFamilyDecl} }
    .assistant .assistant-content { display: block; white-space: normal; }
    /* Markdown rendered content - Cursor/Codex style */
    .assistant .markdown-body { line-height: ${chatLineHeight}; font-size: ${chatFontSize}px; ${fontFamilyDecl} color: var(--vscode-foreground); white-space: normal; }
    .assistant .markdown-body h1 { font-size: 1.6em; font-weight: 700; margin: 1em 0 0.5em; padding-bottom: 0.3em; border-bottom: 1px solid var(--vscode-widget-border, transparent); letter-spacing: -0.02em; }
    .assistant .markdown-body h2 { font-size: 1.4em; font-weight: 700; margin: 1em 0 0.5em; padding-bottom: 0.25em; border-bottom: 1px solid var(--vscode-widget-border, transparent); letter-spacing: -0.01em; }
    .assistant .markdown-body h3 { font-size: 1.2em; font-weight: 600; margin: 0.9em 0 0.4em; }
    .assistant .markdown-body h4 { font-size: 1.1em; font-weight: 600; margin: 0.8em 0 0.3em; }
    .assistant .markdown-body h5 { font-size: 1em; font-weight: 600; margin: 0.7em 0 0.25em; }
    .assistant .markdown-body h6 { font-size: 0.95em; font-weight: 600; margin: 0.7em 0 0.25em; color: var(--vscode-descriptionForeground); }
    .assistant .markdown-body p { margin: 0.5em 0; }
    .assistant .markdown-body strong { font-weight: 600; color: var(--vscode-foreground); }
    .assistant .markdown-body em { font-style: italic; }
    .assistant .markdown-body del { opacity: 0.65; }
    .assistant .markdown-body ul, .assistant .markdown-body ol { margin: 0.5em 0; padding-left: 1.6em; }
    .assistant .markdown-body li { margin: 0.25em 0; line-height: 1.6; }
    .assistant .markdown-body li::marker { color: var(--vscode-descriptionForeground); }
    .assistant .markdown-body blockquote { margin: 0.7em 0; padding: 0.5em 1em; border-left: 3px solid var(--vscode-textLink-foreground, var(--vscode-widget-border)); color: var(--vscode-descriptionForeground); background: var(--vscode-textCodeBlock-background); border-radius: 0 6px 6px 0; }
    .assistant .markdown-body code { padding: 0.2em 0.4em; border-radius: 4px; font-size: ${codeFontSize * 0.92}px; font-family: var(--vscode-editor-font-family); background: var(--vscode-textCodeBlock-background); }
    .assistant .markdown-body pre.code-block { margin: 0.8em 0; padding: 0; border-radius: 8px; overflow: hidden; font-size: ${codeFontSize}px; line-height: 1.5; font-family: var(--vscode-editor-font-family); background: var(--vscode-textCodeBlock-background); }
    .assistant .markdown-body pre.code-block code { padding: 0; background: none; }
    .assistant .markdown-body a { color: var(--vscode-textLink-foreground); text-decoration: none; border-bottom: 1px solid transparent; transition: border-color 0.15s; }
    .assistant .markdown-body a:hover { border-bottom-color: var(--vscode-textLink-foreground); }
    .assistant .markdown-body hr { margin: 1em 0; border: none; border-top: 1px solid var(--vscode-widget-border, transparent); }
    .assistant .markdown-body br { display: block; content: ''; margin: 0.15em 0; }
    .assistant .markdown-body table { border-collapse: collapse; width: 100%; margin: 0.8em 0; font-size: ${chatFontSize * 0.95}px; }
    .assistant .markdown-body th { padding: 10px 14px; text-align: left; border-bottom: 2px solid var(--vscode-widget-border); font-weight: 600; background: var(--vscode-editorWidget-background); }
    .assistant .markdown-body td { padding: 10px 14px; border-bottom: 1px solid var(--vscode-widget-border); }
    .assistant .markdown-body tr:hover td { background: var(--vscode-list-hoverBackground); }
    .assistant .markdown-body .table-wrapper { margin: 0.8em 0; overflow-x: auto; border: 1px solid var(--vscode-widget-border); border-radius: 8px; }
    .assistant .markdown-body .table-wrapper table { margin: 0; }
    .assistant .markdown-body .code-block-wrapper { margin: 0.8em 0; border: 1px solid var(--vscode-widget-border); border-radius: 8px; overflow: hidden; }
    .assistant .markdown-body .code-block-wrapper pre { margin: 0; padding: 12px 14px; background: var(--vscode-textCodeBlock-background); overflow-x: auto; font-size: ${codeFontSize}px; line-height: 1.5; }
    /* Syntax highlighting tokens — VS Code fallback palette (Dark+ inspired) */
    .code-hl .tk-comment { color: #6a9955; font-style: italic; opacity: 0.9; }
    .code-hl .tk-string { color: #ce9178; }
    .code-hl .tk-keyword { color: #569cd6; font-weight: 500; }
    .code-hl .tk-number { color: #b5cea8; }
    .code-hl .tk-fn { color: #dcdcaa; }
    .code-hl .tk-attr { color: #9cdcfe; }  /* --option, attribute */
    .code-hl .tk-path { color: #4ec9b0; }  /* /file/path */
    .code-hl .tk-url { color: #4ec9b0; text-decoration: underline; text-decoration-style: dotted; }
    .code-hl .tk-add { color: #4ec9b0; background: rgba(78, 201, 176, 0.08); display: inline-block; padding: 0 2px; }
    .code-hl .tk-del { color: #f48771; background: rgba(244, 135, 113, 0.08); display: inline-block; padding: 0 2px; }
    /* Light theme overrides */
    .vscode-light .code-hl .tk-comment, .vscode-high-contrast-light .code-hl .tk-comment { color: #008000; }
    .vscode-light .code-hl .tk-string, .vscode-high-contrast-light .code-hl .tk-string { color: #a31515; }
    .vscode-light .code-hl .tk-keyword, .vscode-high-contrast-light .code-hl .tk-keyword { color: #0000ff; }
    .vscode-light .code-hl .tk-number, .vscode-high-contrast-light .code-hl .tk-number { color: #098658; }
    .vscode-light .code-hl .tk-fn, .vscode-high-contrast-light .code-hl .tk-fn { color: #795e26; }
    .vscode-light .code-hl .tk-attr, .vscode-high-contrast-light .code-hl .tk-attr { color: #0451a5; }
    .vscode-light .code-hl .tk-path, .vscode-high-contrast-light .code-hl .tk-path { color: #267f99; }
    .vscode-light .code-hl .tk-url, .vscode-high-contrast-light .code-hl .tk-url { color: #267f99; }
    /* Inline code color hints — commands / URLs / paths / flags / keyboard shortcuts */
    .assistant .markdown-body code.inline-cmd { color: #569cd6; font-weight: 500; }
    .assistant .markdown-body code.inline-url { color: #4ec9b0; text-decoration: underline; text-decoration-style: dotted; text-underline-offset: 3px; }
    .assistant .markdown-body code.inline-path { color: #4ec9b0; }
    .assistant .markdown-body code.inline-flag { color: #9cdcfe; }
    .assistant .markdown-body code.inline-kbd { color: #dcdcaa; background: var(--vscode-keybindingLabel-background, rgba(128,128,128,0.17)); border: 1px solid var(--vscode-keybindingLabel-border, rgba(128,128,128,0.35)); border-bottom-width: 2px; padding: 1px 5px; border-radius: 4px; }
    .vscode-light .assistant .markdown-body code.inline-cmd, .vscode-high-contrast-light .assistant .markdown-body code.inline-cmd { color: #0000ff; }
    .vscode-light .assistant .markdown-body code.inline-url, .vscode-high-contrast-light .assistant .markdown-body code.inline-url { color: #267f99; }
    .vscode-light .assistant .markdown-body code.inline-path, .vscode-high-contrast-light .assistant .markdown-body code.inline-path { color: #267f99; }
    .vscode-light .assistant .markdown-body code.inline-flag, .vscode-high-contrast-light .assistant .markdown-body code.inline-flag { color: #0451a5; }
    .vscode-light .assistant .markdown-body code.inline-kbd, .vscode-high-contrast-light .assistant .markdown-body code.inline-kbd { color: #795e26; }
    /* Autolinked bare URLs — same style as markdown links */
    .assistant .markdown-body a.autolink,
    .assistant .markdown-body a { color: var(--vscode-textLink-foreground, #4ec9b0); text-decoration: underline; text-decoration-style: dotted; text-underline-offset: 3px; cursor: pointer; }
    .assistant .markdown-body a.autolink:hover,
    .assistant .markdown-body a:hover { color: var(--vscode-textLink-activeForeground, #6ee7d8); text-decoration-style: solid; }
    .vscode-light .assistant .markdown-body a.autolink, .vscode-high-contrast-light .assistant .markdown-body a.autolink,
    .vscode-light .assistant .markdown-body a, .vscode-high-contrast-light .assistant .markdown-body a { color: #006ab1; }
    .vscode-light .assistant .markdown-body a.autolink:hover, .vscode-high-contrast-light .assistant .markdown-body a.autolink:hover,
    .vscode-light .assistant .markdown-body a:hover, .vscode-high-contrast-light .assistant .markdown-body a:hover { color: #0090dd; }
    /* Bare-URL autolinks (GFM autolink literals) */
    .assistant .markdown-body a.autolink { color: var(--vscode-textLink-foreground, #4ec9b0); text-decoration: underline; text-decoration-style: dotted; text-underline-offset: 3px; cursor: pointer; }
    .assistant .markdown-body a.autolink:hover { color: var(--vscode-textLink-activeForeground, #6ee7d8); text-decoration-style: solid; }
    .assistant .markdown-body .html-code-block { margin: 0.8em 0; border: 1px solid var(--vscode-widget-border); border-radius: 8px; overflow: hidden; }
    .tool { font: 12px var(--vscode-editor-font-family); color: var(--vscode-descriptionForeground); background: var(--vscode-textCodeBlock-background); padding: 8px; max-height: 180px; overflow: auto; }
    .tool-call { border: 1px solid var(--vscode-widget-border, transparent); border-radius: 6px; overflow: hidden; color: var(--vscode-descriptionForeground); background: var(--vscode-textCodeBlock-background); }
    /* DSH-style process group: contains reasoning + tool items */
    .process-group summary .process-group-summary { font-weight: 500; }
    .process-group .reasoning-card { margin: 4px 9px; border-style: solid; }
    .process-group .reasoning-card summary { padding: 5px 8px; font-size: 11px; opacity: 0.85; }
    .process-group .reasoning-body { max-height: 240px; font-size: 11.5px; }
    .tool-group-list { border-top: 1px solid var(--vscode-widget-border, transparent); }
    .tool-group-item { border-bottom: 1px solid var(--vscode-widget-border, transparent); padding: 0; }
    .tool-group-item:last-child { border-bottom: none; }
    .tool-group-header { display: flex; gap: 7px; align-items: center; padding: 7px 9px; font-size: 12px; }
    .tool-call summary { display: flex; gap: 7px; align-items: center; cursor: pointer; list-style: none; font-size: 12px; padding: 7px 9px; }
    .tool-call summary::-webkit-details-marker { display: none; }
    .tool-call summary::before { content: ''; width: 5px; height: 5px; border-right: 1px solid currentColor; border-bottom: 1px solid currentColor; transform: rotate(-45deg); }
    .tool-call[open] summary::before { transform: rotate(45deg); }
    .tool-state { margin-left: auto; font-size: 11px; }
    .tool-done .tool-state { color: var(--vscode-charts-green); }
    .tool-error .tool-state { color: var(--vscode-errorForeground); }
    .tool-command { font-family: var(--vscode-editor-font-family); font-size: 11px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; padding: 0 9px 7px 21px; }
    .tool-call:not([open]) .tool-command { display: none; }
    .tool-diff { flex: 0 0 auto; margin: 0; padding: 3px 7px; border-radius: 4px; color: var(--vscode-textLink-foreground); background: transparent; font-size: 11px; }
    .tool-diff:hover { background: var(--vscode-toolbar-hoverBackground); }
    .tool-detail { max-height: 240px; overflow: auto; white-space: pre-wrap; overflow-wrap: anywhere; font: 11px/1.5 var(--vscode-editor-font-family); margin: 0; padding: 9px; border-top: 1px solid var(--vscode-widget-border, transparent); }
    .error { color: var(--vscode-errorForeground); font-size: 12px; line-height: 1.5; }
    /* 思考过程卡片：折叠式，避免打断对话节奏 */
    .reasoning-card { border: 1px dashed var(--vscode-widget-border, var(--vscode-input-border, transparent)); border-radius: 6px; overflow: hidden; color: var(--vscode-descriptionForeground); background: var(--vscode-textCodeBlock-background, var(--vscode-input-background)); font-size: 12px; }
    .reasoning-card summary { display: flex; align-items: center; gap: 7px; cursor: pointer; list-style: none; padding: 6px 9px; font-size: 12px; user-select: none; }
    .reasoning-card summary::-webkit-details-marker { display: none; }
    .reasoning-card summary::before { content: ''; width: 5px; height: 5px; border-right: 1px solid currentColor; border-bottom: 1px solid currentColor; transform: rotate(-45deg); transition: transform 0.12s ease; }
    .reasoning-card[open] summary::before { transform: rotate(45deg); }
    .reasoning-card summary::after { content: ''; margin-left: auto; width: 0; height: 0; border: 4px solid transparent; border-top-color: currentColor; opacity: 0.4; }
    .reasoning-body { margin: 0; padding: 8px 10px; max-height: 300px; overflow: auto; white-space: pre-wrap; overflow-wrap: anywhere; font: ${reasoningFontSize}px/1.55 var(--vscode-editor-font-family); border-top: 1px solid var(--vscode-widget-border, transparent); color: var(--vscode-descriptionForeground); }
    .test-result { display: flex; align-items: center; gap: 10px; padding: 7px 9px; border: 1px solid var(--vscode-widget-border, transparent); border-radius: 6px; font-size: 12px; }
    .test-result span { color: var(--vscode-descriptionForeground); }
    .test-passed strong { color: var(--vscode-charts-green); }
    .test-failed strong { color: var(--vscode-errorForeground); }
    #verification-report { display: grid; gap: 8px; padding: 10px; border: 1px solid var(--vscode-widget-border); border-radius: 7px; }
    #verification-report button { justify-self: start; max-width: 100%; padding: 4px 7px; border: 0; border-radius: 4px; color: var(--vscode-textLink-foreground); background: transparent; overflow: hidden; text-overflow: ellipsis; text-align: left; }
    #verification-report button:hover { background: var(--vscode-toolbar-hoverBackground); }
    #verification-report .rerun-tests { color: var(--vscode-button-foreground); background: var(--vscode-button-background); }
    .verification-failure { display: grid; gap: 3px; font-size: 11px; }
    .verification-failure span { overflow-wrap: anywhere; color: var(--vscode-descriptionForeground); }
    .conflict { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; padding: 9px; border: 1px solid var(--vscode-inputValidation-warningBorder, var(--vscode-editorWarning-foreground)); border-radius: 7px; background: var(--vscode-inputValidation-warningBackground, transparent); }
    .conflict span { flex: 1 1 180px; font-size: 12px; line-height: 1.5; }
    .conflict button { padding: 5px 8px; border-radius: 5px; color: var(--vscode-button-foreground); background: var(--vscode-button-background); }
    #status { min-height: 16px; margin: 12px 0 0; font-size: 11px; color: var(--vscode-descriptionForeground); }
    #status.error { color: var(--vscode-errorForeground); }
    #bottom { flex: 0 0 auto; padding: 8px 10px 10px; position: relative; }
    #queue-list { display: flex; flex-direction: column; gap: 5px; margin-bottom: 7px; }
    #queue-list:empty { display: none; }
    .queue-item { display: flex; align-items: center; gap: 6px; padding: 6px 8px 6px 10px; border: 1px dashed var(--vscode-input-border, var(--vscode-widget-border)); border-radius: 8px; background: var(--vscode-input-background); font-size: 12px; }
    .queue-item .queue-label { flex: 0 0 auto; padding: 1px 6px; border-radius: 4px; background: var(--vscode-badge-background, var(--vscode-button-secondaryBackground)); color: var(--vscode-badge-foreground, var(--vscode-foreground)); font-size: 10px; }
    .queue-item .queue-text { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--vscode-descriptionForeground); }
    .queue-item .queue-actions { flex: 0 0 auto; display: flex; gap: 4px; }
    .queue-item button { padding: 3px 8px; border-radius: 4px; font-size: 11px; }
    .queue-item .queue-steer { color: var(--vscode-button-foreground); background: var(--vscode-button-background); }
    .queue-item .queue-steer:hover { background: var(--vscode-button-hoverBackground); }
    .queue-item .queue-cancel { color: var(--vscode-descriptionForeground); background: transparent; }
    .queue-item .queue-cancel:hover { background: var(--vscode-toolbar-hoverBackground); color: var(--vscode-errorForeground); }
    #composer { position: relative; border: 1px solid var(--vscode-input-border, var(--vscode-widget-border)); border-radius: 12px; background: var(--vscode-input-background); box-shadow: 0 2px 8px var(--vscode-widget-shadow, transparent); overflow: visible; }
    #file-picker { position: absolute; bottom: calc(100% + 7px); left: 0; right: 0; max-height: 260px; overflow-y: auto; padding: 4px; border: 1px solid var(--vscode-widget-border, var(--vscode-input-border)); border-radius: 8px; background: var(--vscode-editorWidget-background, var(--vscode-input-background)); box-shadow: 0 5px 18px var(--vscode-widget-shadow, transparent); z-index: 10; }
    #file-picker[hidden] { display: none; }
    .file-option { display: flex; width: 100%; justify-content: flex-start; gap: 8px; padding: 6px 8px; border-radius: 4px; color: var(--vscode-foreground); background: transparent; text-align: left; }
    .file-option.active, .file-option:hover { background: var(--vscode-list-activeSelectionBackground); color: var(--vscode-list-activeSelectionForeground); }
    .file-name { flex: 0 0 auto; font-size: 12px; }
    .file-path { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--vscode-descriptionForeground); font-size: 11px; }
    #file-empty { padding: 8px; color: var(--vscode-descriptionForeground); font-size: 12px; }
    #composer:focus-within { border-color: var(--vscode-focusBorder); box-shadow: 0 0 0 1px var(--vscode-focusBorder); }
    #input-editor { position: relative; min-height: 64px; max-height: 180px; overflow: hidden; }
    #input-highlight, #input { position: absolute; inset: 0; display: block; width: 100%; height: 100%; min-height: 64px; margin: 0; padding: 12px 12px 4px; border: 0; outline: 0; font-family: var(--vscode-font-family); font-size: 13px; font-weight: 400; line-height: 1.5; letter-spacing: normal; tab-size: 4; white-space: pre-wrap; overflow-wrap: anywhere; word-break: normal; }
    #input-highlight { z-index: 0; overflow: hidden; color: var(--vscode-input-foreground); pointer-events: none; }
    #input-highlight .file-mention { color: var(--vscode-textLink-foreground); border-radius: 3px; background: var(--vscode-textCodeBlock-background); }
    #input { position: relative; z-index: 1; max-height: 180px; resize: none; overflow-y: auto; color: transparent; caret-color: var(--vscode-input-foreground); background: transparent; -webkit-text-fill-color: transparent; }
    #input::selection { background: var(--vscode-editor-selectionBackground); }
    #input:placeholder-shown { -webkit-text-fill-color: var(--vscode-input-placeholderForeground); }
    #input::placeholder { color: var(--vscode-input-placeholderForeground); }
    #input:disabled { opacity: .6; }
    @media (max-width: 310px) {
      #model { max-width: 110px; }
      #permissionMode { max-width: 92px; font-size: 11px; }
    }
    #composer-toolbar { display: flex; align-items: center; gap: 5px; padding: 5px 7px 7px; }
    .route-select { height: 28px; min-width: 0; padding: 3px 5px; border: 0; border-radius: 5px; outline: none; color: var(--vscode-foreground); background: transparent; font-size: 12px; }
    .route-select:hover { background: var(--vscode-toolbar-hoverBackground); }
    #model { width: 150px; max-width: 150px; padding-right: 28px; text-overflow: ellipsis; white-space: nowrap; overflow: hidden; color: var(--vscode-dropdown-foreground, var(--vscode-foreground)); }
    #permissionMode { max-width: 135px; color: var(--vscode-descriptionForeground); }
    .toolbar-spacer { flex: 1; }
    #send { width: 30px; height: 30px; padding: 6px; border-radius: 7px; background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
    #send:hover:not(:disabled) { background: var(--vscode-button-hoverBackground); }
    #send.stopping { color: var(--vscode-errorForeground); background: var(--vscode-input-background); }
    #send .stop-icon { display: none; }
    #send.stopping .send-icon { display: none; }
    #send.stopping .stop-icon { display: block; }
    #send svg { width: 18px; height: 18px; }
    #model-status { margin: 6px 3px 0; font-size: 10px; color: var(--vscode-descriptionForeground); overflow-wrap: anywhere; }
    #model-status:empty { display: none; }
    .question { display: grid; gap: 8px; border: 1px solid var(--vscode-input-border); border-radius: 8px; padding: 10px; }
    .question-title { font-weight: 600; }
    .question label { display: block; line-height: 1.6; }
    .question input[type="text"] { width: 100%; color: var(--vscode-input-foreground); background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border); border-radius: 4px; padding: 6px; }
    .question button { justify-self: start; padding: 6px 10px; border-radius: 5px; color: var(--vscode-button-foreground); background: var(--vscode-button-background); }
    .question button { justify-self: start; padding: 6px 10px; border-radius: 5px; color: var(--vscode-button-foreground); background: var(--vscode-button-background); }
    #model-onboarding { color: var(--vscode-foreground); }
    #model-onboarding [hidden] { display: none !important; }
    #model-onboarding h2 { margin: 0; font-size: 17px; font-weight: 500; }
    #model-onboarding p { margin: 5px 0 0; color: var(--vscode-descriptionForeground); font-size: 12px; line-height: 1.6; }
    #model-onboarding input, #model-onboarding select, #model-onboarding button { font: inherit; }
    #model-onboarding input, #model-onboarding select { width: 100%; min-width: 0; height: 33px; padding: 6px 9px; border: 1px solid var(--vscode-input-border, transparent); border-radius: 5px; color: var(--vscode-input-foreground); background: var(--vscode-input-background); outline: none; }
    #model-onboarding input:focus, #model-onboarding select:focus { border-color: var(--vscode-focusBorder); }
    .amo-search { margin: 16px 0; }
    .amo-provider-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 7px; margin-top: 10px; }
    .amo-provider { display: flex; flex-direction: column; align-items: flex-start; justify-content: center; gap: 8px; min-width: 0; height: 69px; padding: 10px; border: 1px solid var(--vscode-widget-border, transparent); border-radius: 7px; color: var(--vscode-foreground); background: var(--vscode-editorWidget-background, transparent); text-align: left; }
    .amo-provider:hover, .amo-provider:focus-visible { border-color: var(--vscode-focusBorder); background: var(--vscode-list-hoverBackground); outline: none; }
    .amo-provider > span:last-child { width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 11px; }
    .amo-provider-mark { display: grid; place-items: center; width: 26px; height: 26px; flex: 0 0 auto; border: 1px solid var(--vscode-widget-border, transparent); border-radius: 6px; background: var(--vscode-input-background); font-size: 12px; font-weight: 500; }
    .amo-custom-provider { display: flex; align-items: center; gap: 10px; width: 100%; min-height: 54px; margin-top: 10px; padding: 10px; border: 1px solid var(--vscode-widget-border, transparent); border-radius: 7px; color: var(--vscode-foreground); background: transparent; text-align: left; }
    .amo-custom-provider:hover { background: var(--vscode-list-hoverBackground); }
    .amo-custom-provider > span:nth-child(2) { flex: 1; min-width: 0; }
    .amo-custom-provider strong, .amo-custom-provider small { display: block; }
    .amo-custom-provider small { margin-top: 2px; color: var(--vscode-descriptionForeground); font-size: 11px; }
    .amo-footnote { display: flex; justify-content: center; gap: 6px; margin-top: 16px !important; font-size: 11px; }
    .amo-config-top { display: flex; align-items: flex-start; gap: 8px; margin-bottom: 16px; }
    .amo-selected-provider { display: flex; align-items: center; gap: 9px; padding: 10px 0 14px; border-bottom: 1px solid var(--vscode-widget-border, transparent); }
    .amo-selected-provider > span:nth-child(2) { flex: 1; }
    .amo-selected-provider small { display: block; margin-top: 2px; color: var(--vscode-descriptionForeground); font-size: 10px; }
    .amo-fields { display: flex; flex-direction: column; gap: 13px; margin-top: 14px; }
    .amo-field { display: flex; flex-direction: column; gap: 6px; min-width: 0; font-size: 12px; }
    .amo-field > span small { color: var(--vscode-descriptionForeground); font-size: 11px; }
    .amo-input-action { display: flex; align-items: center; border: 1px solid var(--vscode-input-border, transparent); border-radius: 5px; background: var(--vscode-input-background); }
    .amo-input-action input { border: 0; background: transparent; }
    .amo-input-action button { width: 32px; height: 31px; padding: 7px; color: var(--vscode-descriptionForeground); background: transparent; }
    .amo-local-key { font-size: 10px !important; }
    .amo-discovery { display: flex; align-items: center; justify-content: space-between; min-height: 38px; padding: 9px 10px; border: 1px dashed var(--vscode-input-border, var(--vscode-descriptionForeground)); border-radius: 6px; color: var(--vscode-descriptionForeground); font-size: 11px; }
    .amo-spinner { width: 13px; height: 13px; border: 2px solid var(--vscode-input-border, var(--vscode-descriptionForeground)); border-top-color: var(--vscode-progressBar-background, var(--vscode-textLink-foreground)); border-radius: 50%; animation: amo-spin .7s linear infinite; }
    @keyframes amo-spin { to { transform: rotate(360deg); } }
    .amo-model-heading { display: flex; align-items: center; justify-content: space-between; margin-bottom: 7px; font-size: 12px; }
    .amo-text-button { padding: 3px 0; color: var(--vscode-textLink-foreground); background: transparent; font-size: 11px; }
    .amo-model-list { overflow: hidden; border: 1px solid var(--vscode-input-border, var(--vscode-widget-border)); border-radius: 6px; background: var(--vscode-input-background); }
    .amo-model-option { display: flex; align-items: center; gap: 8px; width: 100%; min-height: 35px; padding: 7px 9px; border-bottom: 1px solid var(--vscode-widget-border, transparent); border-radius: 0; color: var(--vscode-foreground); background: transparent; text-align: left; font-size: 11px; }
    .amo-model-option:last-child { border-bottom: 0; }
    .amo-model-option.is-selected { background: var(--vscode-list-activeSelectionBackground); color: var(--vscode-list-activeSelectionForeground); }
    .amo-radio { width: 14px; height: 14px; flex: 0 0 auto; border: 1px solid var(--vscode-descriptionForeground); border-radius: 50%; }
    .amo-model-option.is-selected .amo-radio { border: 4px solid var(--vscode-focusBorder); }
    .amo-model-option > span:nth-child(2) { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-family: var(--vscode-editor-font-family); }
    .amo-model-option small { color: var(--vscode-descriptionForeground); white-space: nowrap; }
    #model-onboarding details { font-size: 11px; }
    #model-onboarding summary { display: flex; align-items: center; justify-content: space-between; min-height: 25px; cursor: pointer; color: var(--vscode-descriptionForeground); }
    .amo-advanced { border-top: 1px solid var(--vscode-widget-border, transparent); padding-top: 7px; }
    .amo-advanced-body { display: flex; flex-direction: column; gap: 12px; margin-top: 10px; }
    .amo-secondary, .amo-primary { display: inline-flex; align-items: center; justify-content: center; min-height: 32px; padding: 6px 11px; border-radius: 5px; font-size: 12px; }
    .amo-secondary { border: 1px solid var(--vscode-button-secondaryBorder, var(--vscode-input-border, transparent)); color: var(--vscode-button-secondaryForeground, var(--vscode-foreground)); background: var(--vscode-button-secondaryBackground, transparent); }
    .amo-primary { color: var(--vscode-button-foreground); background: var(--vscode-button-background); }
    .amo-primary:hover:not(:disabled) { background: var(--vscode-button-hoverBackground); }
    #amo-config-footer { padding: 12px 14px 10px; border-top: 1px solid var(--vscode-widget-border, transparent); background: var(--vscode-sideBar-background); }
    #amo-config-footer .amo-config-actions { display: flex; gap: 8px; }
    #amo-config-footer .amo-config-actions button { flex: 1; }
    #amo-test-result, #amo-form-error { margin-bottom: 8px; padding: 7px 9px; border: 1px solid var(--vscode-widget-border, transparent); border-radius: 5px; font-size: 11px; overflow-wrap: anywhere; }
    #amo-test-result.success { color: var(--vscode-testing-iconPassed, var(--vscode-charts-green)); }
    #amo-form-error, #amo-test-result.error { color: var(--vscode-errorForeground); }
    #amo-config-footer .amo-test-note { margin: 8px 0 0; text-align: center; font-size: 10px; color: var(--vscode-descriptionForeground); }
    .amo-model-menu-entry { display: flex; align-items: center; gap: 6px; width: 100%; padding: 7px 9px; border-radius: 4px; color: var(--vscode-foreground); background: transparent; text-align: left; }
    .amo-model-menu-entry:hover { background: var(--vscode-list-hoverBackground); }
    .amo-manage-row { display: flex; align-items: center; gap: 9px; padding: 12px 0; border-bottom: 1px solid var(--vscode-widget-border, transparent); }
    .amo-manage-row > span:nth-child(2) { flex: 1; min-width: 0; }
    .amo-manage-row strong, .amo-manage-row small { display: block; }
    .amo-manage-row small { margin-top: 3px; color: var(--vscode-descriptionForeground); }
    #ready-notice { margin-bottom: 14px; padding: 10px; border: 1px solid var(--vscode-charts-green, transparent); border-radius: 6px; color: var(--vscode-charts-green); }
    @media (max-width: 340px) { .amo-provider-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); } #conversation { padding-left: 10px; padding-right: 10px; } }
  </style>
</head>
<body>
  <div id="topbar">
    <div id="session-picker">
      <button id="session-select" aria-label="历史会话" aria-haspopup="listbox" aria-expanded="false" title="切换当前工作区的历史会话">新会话</button>
      <div id="session-menu" role="listbox" aria-label="当前工作区的历史会话" hidden></div>
    </div>
    <button id="new" class="icon-button" title="新建会话" aria-label="新建会话"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M12 5v14M5 12h14"/></svg></button>
    <button id="refresh-sessions" class="icon-button" title="刷新历史会话" aria-label="刷新历史会话"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M20 7v5h-5M4 17v-5h5"/><path d="M6.1 8a7 7 0 0 1 11.3-2L20 8M4 16l2.6 2A7 7 0 0 0 17.9 16"/></svg></button>
    <button id="diff-visible" class="icon-button" title="查看代码修改对比" aria-label="查看代码修改对比"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M8 3v18M16 3v18M3 8h18M3 16h18"/></svg></button>
    <button id="toggle-tools" class="icon-button" title="会话工具" aria-label="显示或隐藏会话工具" aria-expanded="false"><svg viewBox="0 0 24 24" fill="currentColor"><circle cx="5" cy="12" r="1.5"/><circle cx="12" cy="12" r="1.5"/><circle cx="19" cy="12" r="1.5"/></svg></button>
    <button id="style-settings" class="icon-button" title="显示设置" aria-label="显示设置" aria-expanded="false"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg></button>
    <div id="style-panel" hidden style="position:absolute;top:calc(100% + 4px);right:10px;z-index:1000;min-width:220px;padding:12px;border:1px solid var(--vscode-widget-border);border-radius:8px;background:var(--vscode-editorWidget-background);box-shadow:0 4px 12px rgba(0,0,0,0.2);">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px;">
        <span style="font-size:12px;font-weight:600;color:var(--vscode-foreground);">显示设置</span>
        <button type="button" id="style-panel-close" style="padding:2px;border:none;background:transparent;color:var(--vscode-descriptionForeground);cursor:pointer;font-size:14px;line-height:1;">×</button>
      </div>
      <div style="display:flex;flex-direction:column;gap:10px;">
        <label style="display:flex;align-items:center;justify-content:space-between;font-size:11px;color:var(--vscode-foreground);">
          <span>正文字号</span>
          <select id="style-font-size" style="width:80px;padding:3px 5px;border:1px solid var(--vscode-input-border);border-radius:4px;background:var(--vscode-input-background);color:var(--vscode-input-foreground);font-size:11px;">
            <option value="10">10px</option>
            <option value="11">11px</option>
            <option value="12">12px</option>
            <option value="13">13px</option>
            <option value="13.5" selected>13.5px</option>
            <option value="14">14px</option>
            <option value="15">15px</option>
            <option value="16">16px</option>
            <option value="17">17px</option>
            <option value="18">18px</option>
            <option value="19">19px</option>
            <option value="20">20px</option>
            <option value="22">22px</option>
            <option value="24">24px</option>
          </select>
        </label>
        <label style="display:flex;align-items:center;justify-content:space-between;font-size:11px;color:var(--vscode-foreground);">
          <span>行高</span>
          <select id="style-line-height" style="width:80px;padding:3px 5px;border:1px solid var(--vscode-input-border);border-radius:4px;background:var(--vscode-input-background);color:var(--vscode-input-foreground);font-size:11px;">
            <option value="0.8">0.8</option>
            <option value="0.9">0.9</option>
            <option value="1.0">1.0</option>
            <option value="1.1">1.1</option>
            <option value="1.2">1.2</option>
            <option value="1.3">1.3</option>
            <option value="1.4">1.4</option>
            <option value="1.5">1.5</option>
            <option value="1.6">1.6</option>
            <option value="1.7" selected>1.7</option>
            <option value="1.8">1.8</option>
            <option value="1.9">1.9</option>
            <option value="2.0">2.0</option>
            <option value="2.2">2.2</option>
            <option value="2.5">2.5</option>
          </select>
        </label>
        <label style="display:flex;align-items:center;justify-content:space-between;font-size:11px;color:var(--vscode-foreground);">
          <span>代码字号</span>
          <select id="style-code-size" style="width:80px;padding:3px 5px;border:1px solid var(--vscode-input-border);border-radius:4px;background:var(--vscode-input-background);color:var(--vscode-input-foreground);font-size:11px;">
            <option value="10">10px</option>
            <option value="11">11px</option>
            <option value="12">12px</option>
            <option value="12.5" selected>12.5px</option>
            <option value="13">13px</option>
            <option value="14">14px</option>
            <option value="15">15px</option>
            <option value="16">16px</option>
            <option value="18">18px</option>
          </select>
        </label>
        <label style="display:flex;align-items:center;justify-content:space-between;font-size:11px;color:var(--vscode-foreground);">
          <span>思考过程字号</span>
          <select id="style-reasoning-size" style="width:80px;padding:3px 5px;border:1px solid var(--vscode-input-border);border-radius:4px;background:var(--vscode-input-background);color:var(--vscode-input-foreground);font-size:11px;">
            <option value="10">10px</option>
            <option value="11">11px</option>
            <option value="12" selected>12px</option>
            <option value="13">13px</option>
            <option value="14">14px</option>
            <option value="15">15px</option>
            <option value="16">16px</option>
            <option value="18">18px</option>
          </select>
        </label>
        <div style="border-top:1px solid var(--vscode-widget-border);padding-top:8px;margin-top:2px;">
          <label style="display:flex;align-items:center;justify-content:space-between;font-size:11px;color:var(--vscode-foreground);">
            <span>字体</span>
            <input id="style-font-family" type="text" placeholder="默认" style="width:100px;padding:3px 5px;border:1px solid var(--vscode-input-border);border-radius:4px;background:var(--vscode-input-background);color:var(--vscode-input-foreground);font-size:11px;" />
          </label>
        </div>
        <div style="display:flex;gap:6px;margin-top:8px;">
          <button type="button" id="style-apply" style="flex:1;padding:5px;border:none;border-radius:4px;background:var(--vscode-button-background);color:var(--vscode-button-foreground);font-size:11px;cursor:pointer;">应用</button>
          <button type="button" id="style-reset" style="padding:5px 10px;border:1px solid var(--vscode-input-border);border-radius:4px;background:transparent;color:var(--vscode-foreground);font-size:11px;cursor:pointer;">重置</button>
        </div>
      </div>
    </div>
    <span id="session-status" role="status"></span>
  </div>
  <div id="tools">
    <button id="stop" class="icon-button" title="停止 Host" aria-label="停止 Host"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><rect x="6" y="6" width="12" height="12" rx="1"/></svg></button>
    <button id="diff" class="icon-button" title="查看 Git Diff" aria-label="查看 Git Diff"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><circle cx="6" cy="5" r="2"/><circle cx="18" cy="19" r="2"/><path d="M6 7v10a2 2 0 0 0 2 2h8M8 5h10a2 2 0 0 1 2 2v10M10 10l-3 3 3 3M15 9l3 3-3 3"/></svg></button>
    <button id="resume" class="icon-button" title="重启 Host 并恢复当前会话" aria-label="重启并恢复"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M5 4v6h6M5.6 15a7 7 0 1 0 .6-7"/></svg></button>
    <button id="details" class="icon-button" title="展开全部工具调用" aria-label="展开全部工具调用"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><path d="m8 9 4 4 4-4M8 4h8M8 19h8"/></svg></button>
    <span id="tools-note">当前会话</span>
  </div>
  <div id="conversation-shell">
    <div id="conversation">
      <div id="empty"><img src="${iconUri}" alt=""><h1>Coding Agent</h1><p>描述一个编码任务，Agent 会读取、修改并验证代码。</p></div>
      <section id="workspace-trust" hidden aria-label="工作区信任">
        <div class="workspace-trust-copy">
          <strong>信任此工作区后使用 Agent</strong>
          <p>当前处于受限模式。Agent 尚未启动，也不会读取或修改项目。仅信任你确认安全的目录。</p>
        </div>
        <button id="trust-workspace" type="button">信任此工作区</button>
      </section>
      <div id="log"></div>
      <div id="status">正在加载面板脚本…</div>
      <button id="scroll-to-bottom" title="回到底部" aria-label="回到底部" hidden>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14M5 12l7 7 7-7"/></svg>
      </button>
    </div>
    <div id="model-onboarding" hidden>
        <section id="amo-provider-view" aria-labelledby="amo-provider-heading">
          <div class="amo-config-top"><button type="button" class="icon-button" id="amo-provider-back" aria-label="返回会话" style="width:30px;height:30px;padding:6px;border-radius:7px;background:var(--vscode-button-background);color:var(--vscode-button-foreground)"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M19 12H5M12 19l-7-7 7-7"/></svg></button><div><h2 id="amo-provider-heading">连接模型，开始使用</h2><p>选择服务商，API Key 仅保存在本机。</p></div></div>
          <label class="amo-field amo-search"><input id="amo-provider-search" type="search" placeholder="搜索服务商" aria-label="搜索服务商" autocomplete="off"></label>
          <div class="amo-provider-grid" id="amo-provider-grid"></div>
          <p id="amo-provider-empty" hidden>未找到匹配的服务商，请选择“自定义 API”。</p>
          <button type="button" class="amo-custom-provider" id="amo-custom-provider"><span class="amo-provider-mark">＋</span><span><strong>自定义 API</strong><small>中转站、企业网关或其他厂商</small></span><span>›</span></button>
          <p class="amo-footnote">不写入项目文件，不影响现有会话</p>
        </section>
        <section id="amo-config-view" aria-labelledby="amo-config-heading" hidden>
          <div class="amo-config-top"><button type="button" class="icon-button" id="amo-back" aria-label="返回选择服务商" style="width:30px;height:30px;padding:6px;border-radius:7px;background:var(--vscode-button-background);color:var(--vscode-button-foreground)"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M19 12H5M12 19l-7-7 7-7"/></svg></button><div><h2 id="amo-config-heading">连接模型服务</h2><p>填入密钥，即可自动获取模型</p></div></div>
          <div class="amo-selected-provider"><span class="amo-provider-mark" id="amo-selected-mark">D</span><span><strong id="amo-selected-name">DeepSeek</strong><small id="amo-selected-kind">地址与协议已预填</small></span><button type="button" class="amo-text-button" id="amo-change-provider">更换</button></div>
          <div class="amo-fields">
            <label class="amo-field" id="amo-custom-name-field" hidden><span>服务名称 <small>可选</small></span><input id="amo-custom-name" type="text" placeholder="我的模型服务" autocomplete="off"></label>
            <label class="amo-field" id="amo-route-field" hidden><span>路由 ID</span><input id="amo-route" type="text" placeholder="my-api" autocomplete="off" spellcheck="false"><small>小写字母开头，可包含数字和连字符</small></label>
            <label class="amo-field" id="amo-url-field" hidden><span>API 地址</span><input id="amo-url" type="url" placeholder="https://gateway.example/v1" spellcheck="false" autocomplete="off"></label>
            <label class="amo-field"><span>API Key</span><span class="amo-input-action"><input id="amo-key" type="password" placeholder="粘贴服务商提供的 API Key" autocomplete="off" spellcheck="false"><button type="button" id="amo-show-key" aria-label="显示密钥">显示</button></span></label>
            <p class="amo-local-key">密钥只写保存，界面不会再次显示明文</p>
            <div class="amo-discovery" id="amo-discovery" aria-live="polite"><span>填写后将自动获取可用模型</span><button type="button" class="amo-text-button" id="amo-discover" hidden>获取模型</button></div>
            <div id="amo-model-area" hidden>
              <div class="amo-model-heading"><button type="button" class="amo-text-button" id="amo-select-all">全选</button><button type="button" class="amo-text-button" id="amo-rediscover">重新获取</button></div>
              <div class="amo-model-list" id="amo-model-list" role="group" aria-label="可用模型"></div>
              <label class="amo-field amo-alias-field"><span>显示名称 <small>可选</small></span><input id="amo-alias" type="text" autocomplete="off"><small>仅改变界面名称，请求仍使用 <code id="amo-model-id"></code></small></label>
            </div>
            <details class="amo-manual" id="amo-manual"><summary>列表没有所需模型？手动添加</summary><label class="amo-field"><span>模型 ID</span><input id="amo-manual-id" type="text" placeholder="输入 API 接受的真实模型 ID" spellcheck="false"></label><button type="button" class="amo-secondary" id="amo-add-manual">添加模型</button></details>
            <details class="amo-advanced" id="amo-advanced"><summary>高级设置</summary><div class="amo-advanced-body"><label class="amo-field" id="amo-advanced-url-field"><span>API 地址</span><input id="amo-advanced-url" type="url" spellcheck="false"></label><label class="amo-field"><span>API 协议</span><select id="amo-protocol"><option value="openai-completions">OpenAI-compatible（推荐）</option><option value="openai-responses">OpenAI Responses</option><option value="anthropic-messages">Anthropic Messages</option></select></label><p>内置厂商已自动配置，通常无需修改</p></div></details>
          </div>
        </section>
        <section id="amo-manage-view" hidden aria-labelledby="amo-manage-heading"><div class="amo-config-top"><button type="button" class="icon-button" id="amo-manage-back" aria-label="返回会话" style="width:30px;height:30px;padding:6px;border-radius:7px;background:var(--vscode-button-background);color:var(--vscode-button-foreground)"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M19 12H5M12 19l-7-7 7-7"/></svg></button><div><h2 id="amo-manage-heading">模型服务</h2><p>密钥只显示配置状态，不会显示明文</p></div></div><div id="amo-manage-list"></div><button type="button" class="amo-custom-provider" id="amo-manage-add"><span class="amo-provider-mark"> </span><span><strong>添加模型服务</strong><small>内置厂商或自定义 API</small></span><span>›</span></button></section>
        <div id="ready-notice" role="status" hidden>模型已连接，可以开始编码</div>
      </div>
    <div id="sticky-prompt" aria-label="当前问题的吸顶摘要">
      <span class="user-collapsed"></span>
      <button type="button" class="prompt-toggle" title="展开当前问题" aria-label="展开当前问题" aria-expanded="false"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><path d="m6 9 6 6 6-6"/></svg></button>
    </div>
  </div>
  <div id="amo-config-footer" hidden>
    <div id="amo-test-result" role="status" hidden></div>
    <div id="amo-form-error" role="alert" hidden></div>
    <div class="amo-config-actions"><button type="button" class="amo-secondary" id="amo-test">测试连接</button><button type="button" class="amo-primary" id="amo-save">保存并使用 →</button></div>
    <p class="amo-test-note">测试会发送最小请求，可能产生少量费用</p>
  </div>
  <div id="bottom">
    <div id="approval-memory" style="display:none;align-items:center;gap:6px;padding:4px 8px;margin-bottom:6px;border:1px solid var(--vscode-charts-green);border-radius:6px;background:var(--vscode-inputValidation-infoBackground,transparent);font-size:11px">
      <span style="color:var(--vscode-charts-green)">●</span>
      <span style="color:var(--vscode-descriptionForeground)">本会话已记忆：</span>
      <span id="approval-memory-tools" style="color:var(--vscode-foreground)"></span>
      <button id="approval-memory-clear" type="button" style="margin-left:auto;padding:2px 6px;border:none;border-radius:3px;background:transparent;color:var(--vscode-textLink-foreground);font-size:10px;cursor:pointer">清空</button>
    </div>
    <div id="queue-list" aria-label="排队中的消息"></div>
    <div id="composer">
      <div id="file-picker" role="listbox" aria-label="引用工作区文件" hidden></div>
      <div id="input-editor">
        <div id="input-highlight" aria-hidden="true"></div>
        <textarea id="input" rows="2" placeholder="描述任务；@ 引用文件，Enter 发送，Shift+Enter 换行" aria-label="给 Coding Agent 发送消息"></textarea>
      </div>
      <div id="image-chips" hidden style="display:flex;flex-wrap:wrap;gap:4px;padding:4px 12px;max-height:70px;overflow-y:auto;border-top:1px solid var(--vscode-widget-border)"></div>
      <div id="composer-toolbar">
        <div id="permission-picker" style="position:relative;display:inline-block">
          <button id="permissionMode" type="button" class="route-select" aria-label="权限模式" title="选择工作区权限" style="text-align:left;cursor:pointer;min-width:110px;max-width:160px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;padding-right:22px">工作区可写</button>
          <span style="position:absolute;right:6px;top:50%;transform:translateY(-50%);pointer-events:none;font-size:10px;opacity:0.6">▼</span>
          <div id="permission-menu" hidden style="position:absolute;bottom:calc(100% + 4px);left:0;min-width:280px;padding:5px;border:1px solid var(--vscode-widget-border);border-radius:7px;background:var(--vscode-editorWidget-background);z-index:100;box-shadow:0 -2px 8px rgba(0,0,0,0.15)">
            <button type="button" class="permission-option" data-value="read-only" style="display:flex;align-items:flex-start;gap:8px;width:100%;padding:8px;border:none;background:none;color:var(--vscode-foreground);cursor:pointer;border-radius:4px;text-align:left">
              <span style="font-size:14px;line-height:1.2">🔒</span>
              <span style="flex:1;min-width:0">
                <span style="display:block;font-size:12px;font-weight:500">只读 · 写入审批</span>
                <span style="display:block;font-size:10px;color:var(--vscode-descriptionForeground);margin-top:2px">沙箱: 只读 ｜ 审批: 写入逐次询问</span>
              </span>
              <span class="permission-check" style="visibility:hidden;color:var(--vscode-charts-green)">✓</span>
            </button>
            <button type="button" class="permission-option" data-value="workspace-write" style="display:flex;align-items:flex-start;gap:8px;width:100%;padding:8px;border:none;background:none;color:var(--vscode-foreground);cursor:pointer;border-radius:4px;text-align:left">
              <span style="font-size:14px;line-height:1.2">📝</span>
              <span style="flex:1;min-width:0">
                <span style="display:block;font-size:12px;font-weight:500">工作区可写</span>
                <span style="display:block;font-size:10px;color:var(--vscode-descriptionForeground);margin-top:2px">沙箱: 工作区内写入 ｜ 审批: 越界时询问</span>
              </span>
              <span class="permission-check" style="visibility:visible;color:var(--vscode-charts-green)">✓</span>
            </button>
            <button type="button" class="permission-option" data-value="danger-full-access" style="display:flex;align-items:flex-start;gap:8px;width:100%;padding:8px;border:none;background:none;color:var(--vscode-foreground);cursor:pointer;border-radius:4px;text-align:left">
              <span style="font-size:14px;line-height:1.2">⚠️</span>
              <span style="flex:1;min-width:0">
                <span style="display:block;font-size:12px;font-weight:500;color:var(--vscode-errorForeground)">完全访问</span>
                <span style="display:block;font-size:10px;color:var(--vscode-descriptionForeground);margin-top:2px">沙箱: 无限制 ｜ 审批: 从不询问</span>
              </span>
              <span class="permission-check" style="visibility:hidden;color:var(--vscode-charts-green)">✓</span>
            </button>
            <div style="border-top:1px solid var(--vscode-widget-border);margin-top:5px;padding:6px 8px 2px;font-size:10px;color:var(--vscode-descriptionForeground)">
              当前：工作区可写 — 可直接修改工作区文件，越界写入需逐次确认
            </div>
          </div>
        </div>
        <span class="toolbar-spacer"></span>
        <button id="attach-image" type="button" title="添加图片（或粘贴到输入框）" aria-label="添加图片" style="padding:4px;border:none;background:transparent;color:var(--vscode-foreground);cursor:pointer;border-radius:4px;display:flex;align-items:center;justify-content:center;">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" style="width:16px;height:16px;"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M17 8l-5-5-5 5M12 3v12"/></svg>
        </button>
        <button id="context-preview" type="button" hidden title="点击打开当前编辑器位置"></button>
        <div id="model-picker" style="position:relative;display:inline-block">
          <button id="model" type="button" class="route-select" aria-label="模型" title="选择 DSH 模型" style="text-align:left;cursor:pointer;min-width:120px;max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;padding-right:22px">选择模型</button>
          <span style="position:absolute;right:6px;top:50%;transform:translateY(-50%);pointer-events:none;font-size:10px;opacity:0.6">▼</span>
          <div id="model-menu" hidden style="position:absolute;bottom:calc(100% + 4px);left:0;min-width:200px;padding:5px;border:1px solid var(--vscode-widget-border);border-radius:7px;background:var(--vscode-editorWidget-background);z-index:100;box-shadow:0 -2px 8px rgba(0,0,0,0.15)">
            <div id="amo-menu-models"></div>
            <button type="button" class="amo-model-menu-entry" id="amo-menu-add">添加模型</button>
            <button type="button" class="amo-model-menu-entry" id="amo-menu-manage">管理模型</button>
          </div>
        </div>
        <button id="send" type="button" title="发送（Enter）" aria-label="发送"><svg class="send-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19V5M6 11l6-6 6 6"/></svg><svg class="stop-icon" viewBox="0 0 24 24" fill="currentColor"><rect x="7" y="7" width="10" height="10" rx="1"/></svg></button>
      </div>
    </div>
    <div id="model-status" role="status"></div>
  </div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`
}
