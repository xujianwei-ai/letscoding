import { randomUUID } from 'node:crypto'
import { mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, isAbsolute, relative, resolve } from 'node:path'
import * as vscode from 'vscode'
import { SessionRuntime, sessionPathSegment, sessionProjectKey } from './agent.js'
import { CheckpointStore, workspacePath } from './checkpoints.js'
import { SessionCatalog } from './sessionCatalog.js'
import { errorText } from './diagnostics.js'
import type { RestorePlan } from './checkpoints.js'
import type { DeepSeekHarness, SdkPromptContentBlock, SessionHistoryResult, SessionListResult } from '@deepseek-ai/dsh-sdk-client'
import { createHarness, CATALOG_BOOTSTRAP_ROUTE, defaultDshHome, developmentRepository, sameNetworkOptions } from './runtime.js'
import type { EditorContext } from './context.js'

type Message = Record<string, unknown>
type Notify = (message: Message) => void
const errorMessage = errorText

/** The view is a projection of independent runtimes, never the owner of a Host. */
export class AgentController implements vscode.Disposable {
  private readonly context: vscode.ExtensionContext
  private readonly output: Notify
  private readonly emitDirect: Notify
  private readonly runtimes = new Map<string, SessionRuntime>()
  private readonly liveViews = new Map<string, Message[]>()
  private readonly historyGenerations = new Map<string, number>()
  private readonly histories = new Map<string, Promise<SessionHistoryResult>>()
  private readonly pendingHistories = new Set<string>()
  private readonly historyCapacity = 8
  private readonly deletedSessions = new Set<string>()
  private readonly sessionState: vscode.Memento
  private readonly extensionUri: vscode.Uri
  private readonly globalStorageUri: vscode.Uri
  private selected: SessionRuntime | undefined
  private restoringId: string | undefined
  /** FIFO queue per session. Each turn finish dequeues the oldest entry. */
  private readonly queuedMessages = new Map<string, Array<{ prompt: string | SdkPromptContentBlock[], displayPrompt: string, route?: { provider: string, model: string } }>>()
  private get selectedId(): string | undefined { return this.selected?.id ?? this.restoringId }
  private draft: SessionRuntime | undefined
  private readonly drafts = new Set<SessionRuntime>()
  private viewGeneration = 0
  private readHost: DeepSeekHarness | undefined
  private readNetwork: { networkMode?: 'direct' | 'system' | 'proxy', proxyUrl?: string } | undefined
  private readTail = Promise.resolve()
  private readonly disposables: vscode.Disposable[] = []
  private draftEditorContext: EditorContext | undefined
  private readonly checkpoints: CheckpointStore
  private readonly catalog: SessionCatalog
  private disposed = false
  private runGeneration = 0

  constructor(context: vscode.ExtensionContext, notify: Notify) {
    this.context = context
    this.emitDirect = notify
    this.extensionUri = context.extensionUri
    this.globalStorageUri = context.globalStorageUri
    this.sessionState = context.workspaceState
    const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? 'no-workspace'
    this.checkpoints = new CheckpointStore(resolve(context.globalStorageUri.fsPath, 'checkpoints', encodeURIComponent(cwd)))
    this.catalog = new SessionCatalog(async () => {
      const result = await this.readOnly(harness => harness.listSessions())
      // A deletion may complete while this cold disk read is still in flight.
      return { ...result, sessions: result.sessions.filter(session => !this.deletedSessions.has(session.id)) }
    })
    this.catalog.exclude(id => this.deletedSessions.has(id))
    // User-defined session titles, persisted in workspace state. DSH derives
    // its title from the first user prompt; the extension overlays user edits.
    this.catalog.titleOverrides({
      get: id => this.sessionState.get<string>(`sessionTitle:${id}`),
      set: async (id, title) => { await this.sessionState.update(`sessionTitle:${id}`, title) },
    })
    this.output = (message) => {
      const sessionId = message.sessionId as string | undefined
      if (sessionId === undefined) {
        this.emitDirect(message)
        return
      }
      if (message.type === 'historyReplay' && Array.isArray(message.messages)) {
        this.liveViews.set(sessionId, message.messages as Message[])
        void this.writeSnapshot(sessionId)
        if (this.selectedId === sessionId) {
          this.emitDirect({ type: 'cleared', sessionId })
          // Send messages in batches to avoid blocking the webview's main thread
          // on very long histories. Each batch yields via setTimeout so the UI
          // stays responsive.
          const BATCH_SIZE = 20
          const entries = message.messages as Message[]
          let index = 0
          const total = entries.length
          const sendBatch = (): void => {
            const batch = entries.slice(index, index + BATCH_SIZE)
            for (const entry of batch) this.emitDirect(entry)
            index += batch.length
            if (index < entries.length) {
              setTimeout(sendBatch, 0)
            } else {
              // After all replayed messages are appended, force-scroll to the very bottom
              // so the latest turn is fully visible. Individual appends may scroll early
              // while images or markdown are still expanding the DOM.
              this.emitDirect({ type: 'scrollToBottom', sessionId, total })
            }
          }
          sendBatch()
        }
        return
      }
      if (message.type === 'historyReplayOlder' && Array.isArray(message.messages)) {
        // Prepend older messages before the existing ones in the live view.
        const existing = this.liveViews.get(sessionId) ?? []
        // Skip the 'cleared' message from the older batch; we don't want to wipe the view.
        const older = (message.messages as Message[]).filter(m => m.type !== 'cleared')
        this.liveViews.set(sessionId, [...older, ...existing])
        void this.writeSnapshot(sessionId)
        if (this.selectedId === sessionId) {
          this.emitDirect({ type: 'historyPrependOlder', messages: older, sessionId })
        }
        return
      }
      if (message.type === 'runtimeFinished') {
        this.histories.delete(sessionId)
        this.catalog.invalidate()
        void this.writeSnapshot(sessionId)
        void this.listSessions().then(result => this.emitDirect({ type: 'sessionList', sessions: result.sessions, activeSessionId: this.selectedId }),
          error => console.log(`[Coding Agent] Session list refresh failed: ${errorMessage(error)}`))
        // Dispatch the oldest queued follow-up after the current turn settles.
        // New sessions may finish before their ID was known at queue time;
        // fall back to the '' bucket used when no sessionId was available.
        const queueKey = this.queuedMessages.has(sessionId) ? sessionId : ''
        const queue = this.queuedMessages.get(queueKey)
        const queued = queue?.shift()
        if (queued !== undefined) {
          if (queue !== undefined && queue.length === 0) this.queuedMessages.delete(queueKey)
          const runtime = this.runtimes.get(sessionId) ?? this.selected
          if (runtime !== undefined) {
            // Busy the Webview immediately so the send button stays red while
            // the queued turn starts.
            this.emitDirect({ type: 'busy', busy: true, sessionId })
            runtime.queueNext(queued.prompt, queued.displayPrompt, queued.route)
            this.emitDirect({ type: 'queueFinished', sessionId })
          }
        }
        return
      }
      this.record(sessionId, message)
      if (this.selectedId !== sessionId) return
      this.emitDirect(message)
    }
    // SessionRuntime owns editor events; the manager only owns runtime and read-Host lifetimes.
  }

  private emit(message: Message): void {
    this.output({ ...message, ...this.selectedId === undefined ? {} : { sessionId: this.selectedId } })
  }

  private create(id?: string): SessionRuntime {
    const runtime = new SessionRuntime(this.context, this.output, id)
    runtime.editorContext = this.draftEditorContext
    return runtime
  }

  private active(): SessionRuntime {
    this.selected ??= this.create()
    this.drafts.add(this.selected)
    // Selection follows the runtime identity; there is no separate selectedId to update.
    return this.selected
  }

  private runtime(sessionId: string | undefined): SessionRuntime | undefined {
    if (sessionId === undefined) return this.active()
    return this.runtimes.get(sessionId)
  }

  private publish(message: Message, sessionId = this.selected?.id): void {
    this.output({ ...message, ...(sessionId === undefined ? {} : { sessionId }) })
  }

  /** Preserve delta boundaries: UI messages are not identical to settled response text. */
  private record(sessionId: string, message: Message): void {
    const messages = this.liveViews.get(sessionId) ?? []
    if (message.type === 'cleared') messages.length = 0
    messages.push(message)
    this.liveViews.set(sessionId, messages)
  }

  private selectRuntime(runtime: SessionRuntime | undefined, restoringId?: string): void {
    this.selected = runtime
    this.restoringId = restoringId
  }

  get persistedSessionId(): string | undefined { return this.selectedId }
  get busy(): boolean { return this.selected?.busy ?? false }

  set editorContext(value: EditorContext | undefined) {
    this.draftEditorContext = value
    if (this.selected !== undefined) this.selected.editorContext = value
  }

  /** The composer always follows the latest selection, never a pre-new-session ID. */
  prepareRun(): string | undefined {
    // A failed cold selection may leave a restoring placeholder. Sending or
    // explicitly creating a draft is a newer user intent, not a stale restore.
    ++this.viewGeneration
    if (this.selectedId !== undefined && this.runtimes.has(this.selectedId)) return this.selectedId
    this.active()
    return undefined
  }

  private options() {
    const config = vscode.workspace.getConfiguration('privateCodingAgent')
    const runtimeMode = config.get<'bundled' | 'source'>('runtimeMode') ?? 'bundled'
    const developmentHome = resolve(this.extensionUri.fsPath, '../.dsh-dev')
    return {
      dshRepository: config.get<string>('dshRepository') || (runtimeMode === 'source' ? developmentRepository() : undefined),
      runtimeMode,
      extensionRoot: this.extensionUri.fsPath,
      runtimeStorage: resolve(this.globalStorageUri.fsPath, 'runtime-patches'),
      dshHome: process.env.DSH_AGENT_HOME || config.get<string>('dshHome') || (runtimeMode === 'source' && existsSync(developmentHome) ? developmentHome : defaultDshHome()),
      cwd: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath,
      provider: config.get<string>('provider') ?? 'deepseek-account',
      model: config.get<string>('model') ?? 'deepseek-flash',
      permissionMode: this.sessionState.get<'read-only' | 'workspace-write' | 'danger-full-access'>('permissionMode') ?? 'workspace-write',
      networkMode: config.get<'direct' | 'system' | 'proxy'>('networkMode') ?? 'direct',
      proxyUrl: config.get<string>('proxyUrl') ?? '',
    }
  }

  private workspaceKey(): string {
    const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath
    if (cwd === undefined) throw new Error('请先打开一个单项目工作区。')
    return `currentSession:${cwd}`
  }

  private requireTrust(): void {
    if (!vscode.workspace.isTrusted) throw new Error('请先信任当前工作区，再使用 Agent 读取、修改项目或启动 DSH。可通过“工作区: 管理工作区信任”进行设置。')
  }

  private async readOnly<T>(read: (harness: DeepSeekHarness) => Promise<T>): Promise<T> {
    this.requireTrust()
    const operation = this.readTail.then(async () => {
      const options = this.options()
      if (options.cwd === undefined) throw new Error('请先打开一个单项目工作区。')
      const started = performance.now()
      if (this.readHost !== undefined && !sameNetworkOptions(this.readNetwork ?? {}, options)) {
        await this.readHost.close().catch(() => undefined)
        this.readHost = undefined
      }
      const harness = this.readHost ?? createHarness({
        ...options, ...CATALOG_BOOTSTRAP_ROUTE, cwd: options.cwd, approvalRequests: false,
        requestTimeoutMs: 20_000, shutdownTimeoutMs: 1_000,
        disposeEofGraceMs: 2_000, disposeGraceMs: 1_000,
      })
      this.readHost = harness
      this.readNetwork = { networkMode: options.networkMode, proxyUrl: options.proxyUrl }
      try {
        await harness.start()
        const result = await read(harness)
        console.log(`[Coding Agent] Read-only query completed in ${Math.round(performance.now() - started)}ms`)
        return result
      } catch (error) {
        if (this.readHost === harness) this.readHost = undefined
        await harness.close().catch(() => undefined)
        throw error
      }
    })
    this.readTail = operation.then(() => undefined, () => undefined)
    return operation
  }

  async listSessions(): Promise<SessionListResult> { return vscode.workspace.isTrusted ? this.catalog.list() : { sessions: [] } }

  async sessionHistory(sessionId: string): Promise<SessionHistoryResult> {
    return this.readOnly(harness => harness.sessionHistory(sessionId))
  }

  /** Layer one user-provided title above the DSH-derived fallback title; persists across restarts. */
  async renameSession(sessionId: string, title: string): Promise<void> {
    await this.catalog.rename(sessionId, title)
    // The in-memory row already reflects the override. A broadcast lets any
    // open Webview refresh its session menu without waiting for the next turn.
    const result = await this.catalog.list()
    this.emitDirect({ type: 'sessionList', sessions: result.sessions, activeSessionId: this.selectedId })
  }

  /** Restore the DSH-derived fallback title for one session. */
  async clearSessionRename(sessionId: string): Promise<void> {
    await this.catalog.clearRename(sessionId)
    this.catalog.invalidate(sessionId)
    const result = await this.catalog.list()
    this.emitDirect({ type: 'sessionList', sessions: result.sessions, activeSessionId: this.selectedId })
  }

  private history(sessionId: string): Promise<SessionHistoryResult> {
    let pending = this.histories.get(sessionId)
    if (pending === undefined) {
      this.pendingHistories.add(sessionId)
      const generation = this.historyGenerations.get(sessionId) ?? 0
      pending = this.readOnly(harness => harness.sessionHistory(sessionId)).then(async history => {
        if (generation !== (this.historyGenerations.get(sessionId) ?? 0)) {
          this.histories.delete(sessionId)
          return this.history(sessionId)
        }
        if (this.runtimes.get(sessionId)?.busy) this.histories.delete(sessionId)
        return history
      }).catch(error => {
        this.histories.delete(sessionId)
        throw error
      }).finally(() => {
        this.pendingHistories.delete(sessionId)
        while (this.histories.size > this.historyCapacity) {
          const oldest = [...this.histories.keys()].find(id => id !== this.selectedId && !this.runtimes.get(id)?.busy && !this.pendingHistories.has(id))
          if (oldest === undefined) break
          this.histories.delete(oldest)
        }
      })
      this.histories.set(sessionId, pending)
    }
    return pending
  }

  async selectSession(sessionId: string, options?: { skipClear?: boolean }): Promise<void> {
    const generation = ++this.viewGeneration
    if (this.deletedSessions.has(sessionId)) throw new Error('会话已删除，请刷新列表。')
    if (sessionId === this.selected?.id) return
    // Selection is not serialized behind a running turn. The old Host stays alive.
    const runtime = this.runtime(sessionId)
    this.selectRuntime(runtime, runtime?.id === sessionId ? undefined : sessionId)
    if (!options?.skipClear) this.emitDirect({ type: 'cleared', sessionId })
    this.emitDirect({ type: 'busy', busy: runtime?.busy ?? false, sessionId })
    this.emitDirect({ type: 'sessionSelected', session: { id: sessionId }, sessionId })
    if (runtime?.id !== undefined && !this.deletedSessions.has(sessionId)) {
      // An idle hidden runtime can still own the old write lock after a persisted reload.
      if (!runtime.busy && runtime.needsResume) await runtime.prepareRestore()
      if (generation !== this.viewGeneration) return
      if (runtime.busy) this.emitDirect({ type: 'busy', busy: true, sessionId })
      for (const message of this.liveViews.get(sessionId) ?? []) this.emitDirect(message)
      await this.sessionState.update(this.workspaceKey(), runtime.id)
      this.publish({ type: 'status', status: 'idle', text: runtime.busy ? '该会话正在后台运行' : '已恢复历史会话；发送消息将继续原会话' })
      this.emitDirect({ type: 'scrollToBottom', sessionId })
      return
    }
    // Always project the newly selected target before any asynchronous read.
    try {
      const history = await this.history(sessionId)
      if (this.deletedSessions.has(sessionId)) return
      this.catalog.update(history)
      const runtime = this.runtimes.get(sessionId) ?? this.create(sessionId)
      this.runtimes.set(sessionId, runtime)
      if (generation !== this.viewGeneration || this.selectedId !== sessionId) return
      this.selectRuntime(runtime)
      runtime.replayHistory(history)
      await this.sessionState.update(this.workspaceKey(), sessionId)
      this.publish({ type: 'sessionSelected', session: history.session }, sessionId)
      this.publish({ type: 'status', status: 'idle', text: '已恢复历史会话；发送消息将继续原会话' })
    } catch (error) {
      // A failed read must not blank the newest selection or unlock a busy draft.
      if (generation === this.viewGeneration) this.emitDirect({ type: 'error', text: `会话切换失败：${errorMessage(error)}`, sessionId })
      throw error
    }
  }

  /** Pre-warm the read-only Host so the first session restore avoids the startup cost. */
  async warmupReadHost(): Promise<void> {
    await this.readOnly(async () => undefined)
  }

  async restoreSelection(): Promise<void> {
    if (!vscode.workspace.isTrusted) {
      this.emitDirect({ type: 'busy', busy: false })
      this.emitDirect({ type: 'status', status: 'idle', text: '当前工作区未受信任。信任工作区后才能启动 DSH 或修改项目。' })
      return
    }
    if (this.selectedId !== undefined) {
      const id = this.selectedId
      this.emitDirect({ type: 'cleared', sessionId: id })
      this.emitDirect({ type: 'busy', busy: this.selected?.busy ?? false, sessionId: id })
      for (const message of this.liveViews.get(id) ?? []) this.emitDirect(message)
      this.emit({ type: 'sessionSelected', session: { id } })
      return
    }
    const selected = this.sessionState.get<string>(this.workspaceKey())
    if (selected !== undefined && !this.deletedSessions.has(selected)) {
      // Fast path: show the cached snapshot immediately while the full history
      // loads in the background. Cursor/Codex use the same pattern — the user
      // sees the conversation instantly, then the view refreshes with the
      // authoritative data.
      const snapshotPromise = this.readSnapshot(selected)
      const selectPromise = this.selectSession(selected, { skipClear: true })
      const snapshot = await snapshotPromise
      if (snapshot !== undefined && snapshot.length > 0) {
        this.emitDirect({ type: 'cleared', sessionId: selected })
        this.emitDirect({ type: 'busy', busy: false, sessionId: selected })
        for (const message of snapshot) this.emitDirect(message)
        this.emit({ type: 'sessionSelected', session: { id: selected } })
        this.emitDirect({ type: 'status', status: 'idle', text: '已恢复历史会话；发送消息将继续原会话' })
        this.emitDirect({ type: 'scrollToBottom', sessionId: selected })
      }
      // Do not await the full history load here; the snapshot already gives the
      // user a responsive view. selectSession continues in the background and
      // updates the view when ready.
      void selectPromise.catch(error => {
        console.warn(`[Coding Agent] Background session restore failed for ${selected}: ${error}`)
      })
    }
    else this.emitDirect({ type: 'busy', busy: false })
  }

  /** Read a cached snapshot of the session's webview messages from disk. */
  private async readSnapshot(sessionId: string): Promise<Message[] | undefined> {
    try {
      const path = this.snapshotPath(sessionId)
      const raw = await readFile(path, 'utf8')
      const parsed = JSON.parse(raw) as Message[]
      return Array.isArray(parsed) ? parsed : undefined
    } catch {
      return undefined
    }
  }

  /** Persist the session's webview messages to disk for instant restore on next boot. */
  private async writeSnapshot(sessionId: string): Promise<void> {
    try {
      const messages = this.liveViews.get(sessionId)
      if (messages === undefined || messages.length === 0) return
      const path = this.snapshotPath(sessionId)
      await mkdir(dirname(path), { recursive: true })
      await writeFile(path, JSON.stringify(messages), 'utf8')
    } catch {
      // Snapshot write is best-effort; a failure must not break the session.
    }
  }

  private snapshotPath(sessionId: string): string {
    const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? 'no-workspace'
    const key = encodeURIComponent(cwd)
    return resolve(this.globalStorageUri.fsPath, 'session-snapshots', key, `${sessionId}.json`)
  }

  newSession(): void {
    ++this.viewGeneration
    this.draft = undefined
    this.selectRuntime(undefined)
    void this.sessionState.update(this.workspaceKey(), undefined)
    this.emit({ type: 'sessionSelected' })
    this.emit({ type: 'cleared' })
    this.emit({ type: 'busy', busy: false })
    this.emit({ type: 'status', status: 'idle', text: '已新建会话；发送消息时启动 Host' })
  }

  async run(prompt: string | SdkPromptContentBlock[], displayPrompt = typeof prompt === 'string' ? prompt : prompt.filter(b => b.type === 'text').map(b => b.text).join(' '), requestedId?: string, route?: { provider: string, model: string }): Promise<void> {
    this.requireTrust()
    const targetId = typeof requestedId === 'string' ? requestedId : this.selectedId
    let runtime = targetId !== undefined ? this.runtimes.get(targetId) : this.active()
    if (runtime === undefined) {
      if (requestedId === undefined && this.restoringId !== undefined) {
        ++this.viewGeneration
        this.selectRuntime(undefined)
        runtime = this.active()
      } else {
        // A cold history read is shared by the selection promise; no second writer.
        this.publish({ type: 'error', text: '历史会话仍在恢复，请稍候发送。' })
        return
      }
    }
    if (runtime.busy) return
    if (this.disposed || this.deletedSessions.has(runtime.id ?? '')) return
    const id = runtime.id ?? `session-${randomUUID().replaceAll('-', '')}`
    if (runtime.id === undefined) {
      const generation = ++this.runGeneration
      // The draft has no Host or turn; adopt its identity without allocating a second runtime.
      runtime.adopt(id)
      this.drafts.delete(runtime)
      this.restoringId = undefined
      if (this.draft === runtime) this.draft = undefined
      this.runtimes.set(id, runtime)
      this.liveViews.set(id, [])
      this.publish({ type: 'sessionSelected', session: { id } }, id)
      void this.sessionState.update(this.workspaceKey(), id)
      try { await runtime.run(prompt, displayPrompt, route) }
      finally {
        this.histories.delete(id)
        if (!runtime.busy && !runtime.hasStarted && this.runtimes.get(id) === runtime && generation === this.runGeneration) {
          this.runtimes.delete(id)
          this.liveViews.delete(id)
          runtime.releaseAdoptedId()
          if (this.selected === runtime) {
            // Selection follows the runtime identity; there is no separate selectedId to update.
            void this.sessionState.update(this.workspaceKey(), undefined)
            this.publish({ type: 'sessionSelected' })
          }
        }
      }
      return
    }
    try { await runtime.run(prompt, displayPrompt, route) }
    finally { this.histories.delete(runtime.id ?? '') }
  }

  /** A missing explicitly addressed Session is never silently replaced by the current draft. */
  private target(sessionId?: string): SessionRuntime | undefined {
    if (sessionId !== undefined) return this.runtimes.get(sessionId)
    return this.selected ?? (this.selectedId === undefined ? this.active() : undefined)
  }

  private requireTarget(sessionId?: string): SessionRuntime {
    this.requireTrust()
    const runtime = this.target(sessionId)
    if (runtime === undefined) throw new Error('会话尚未恢复，请稍候重试。')
    return runtime
  }

  answerQuestions(id: unknown, answers: unknown, sessionId?: string): void { this.requireTarget(sessionId).answerQuestions(id, answers) }
  handleApprovalResponse(requestId: string, outcome: 'allowed-once' | 'rejected' | 'cancelled', sessionId?: string): void {
    this.requireTarget(sessionId).handleApprovalResponse(requestId, outcome)
  }
  allowToolForSession(tool: string, sessionId?: string): void { this.requireTarget(sessionId).allowToolForSession(tool) }
  clearApprovalMemory(sessionId?: string): void { this.requireTarget(sessionId).clearApprovalMemory() }
  approvalMemoryTools(sessionId?: string): string[] { return this.requireTarget(sessionId).approvalMemoryTools }
  async stop(sessionId?: string): Promise<void> {
    const targetId = sessionId ?? this.selectedId
    if (targetId !== undefined) this.queuedMessages.delete(targetId)
    await this.target(sessionId)?.stop()
  }

  /** Queue: append the follow-up for dispatch when the running turn settles.
   * Returns the session key the message was queued for, or undefined when the
   * target runtime is not currently running (caller should send normally). */
  queueMessage(prompt: string | SdkPromptContentBlock[], displayPrompt = typeof prompt === 'string' ? prompt : prompt.filter(b => b.type === 'text').map(b => b.text).join(' '), route?: { provider: string, model: string }, sessionId?: string): string | undefined {
    const runtime = this.target(sessionId)
    if (runtime === undefined || !runtime.busy) return undefined
    const key = runtime.id ?? sessionId ?? ''
    const queue = this.queuedMessages.get(key) ?? []
    queue.push({ prompt, displayPrompt, route })
    this.queuedMessages.set(key, queue)
    return key
  }

  /** Steer: stop the current turn and immediately run the oldest queued prompt. */
  async steerQueued(sessionId?: string): Promise<void> {
    const runtime = this.target(sessionId)
    if (runtime === undefined) return
    const key = runtime.id ?? sessionId ?? ''
    const queue = this.queuedMessages.get(key) ?? this.queuedMessages.get('')
    const queued = queue?.shift()
    if (queued === undefined) { await runtime.stop(); return }
    if (queue !== undefined && queue.length === 0) this.queuedMessages.delete(key)
    this.queuedMessages.delete('')
    await runtime.stop()
    runtime.queueNext(queued.prompt, queued.displayPrompt, queued.route)
    this.emitDirect({ type: 'queueFinished', sessionId: key || sessionId })
  }

  /** Cancel the oldest queued message; the running turn continues untouched. */
  cancelQueued(sessionId?: string): void {
    const runtime = this.target(sessionId)
    const key = runtime?.id ?? sessionId ?? ''
    const queue = this.queuedMessages.get(key)
    if (queue !== undefined) {
      queue.shift()
      if (queue.length === 0) this.queuedMessages.delete(key)
    }
  }
  async restart(): Promise<void> {
    // Running/background Hosts keep their route; a selected idle Session uses it next turn.
    if (this.selectedId !== undefined) await this.requireTarget().restart()
  }
  async resume(sessionId?: string): Promise<void> { await this.requireTarget(sessionId).resume() }
  async setPermissionMode(mode: 'read-only' | 'workspace-write' | 'danger-full-access', sessionId?: string): Promise<boolean> {
    // Permission mode is global workspace state. Update the shared store first,
    // then apply DSH's native /permission command to the affected live session(s)
    // so the new mode takes effect in place, without dropping the session's Host
    // or interrupting its history. Background runtimes align on their next resume.
    await this.sessionState.update('permissionMode', mode)
    const target = sessionId === undefined ? this.selected : this.runtimes.get(sessionId) ?? this.selected
    if (target !== undefined) await target.setPermissionMode(mode)
    this.emitDirect({ type: 'config', permissionMode: mode })
    return true
  }
  modelCatalog() { return this.readOnly(harness => harness.listModels()) }
  discoverModels(params: import('@deepseek-ai/dsh-sdk-client').ModelsDiscoverParams) {
    return this.readOnly(harness => harness.discoverModels(params))
  }
  testModel(params: import('@deepseek-ai/dsh-sdk-client').ModelsTestParams) {
    return this.readOnly(harness => harness.testModel(params))
  }
  saveProvider(params: import('@deepseek-ai/dsh-sdk-client').ModelsSaveProviderParams) {
    return this.readOnly(harness => harness.saveProvider(params))
  }
  deleteProvider(params: import('@deepseek-ai/dsh-sdk-client').ModelsDeleteProviderParams) {
    return this.readOnly(harness => harness.deleteProvider(params))
  }
  providerConfig(params: import('@deepseek-ai/dsh-sdk-client').ModelsProviderConfigParams) {
    return this.readOnly(harness => harness.providerConfig(params))
  }
  async rerunVerification(command: string): Promise<void> { await this.requireTarget().rerunVerification(command) }
  async finishRerun(terminal: vscode.Terminal, exitCode: number | undefined): Promise<void> {
    for (const runtime of new Set([...this.runtimes.values(), ...this.drafts])) await runtime.finishRerun(terminal, exitCode)
  }
  async finishRerunExecution(terminal: vscode.Terminal, commandLine: string, exitCode: number | undefined, started: boolean): Promise<void> {
    for (const runtime of new Set([...this.runtimes.values(), ...this.drafts])) await runtime.finishRerunExecution(terminal, commandLine, exitCode, started)
  }
  async openDiff(path?: string, seq?: number, sessionId?: string): Promise<void> {
    await this.requireTarget(sessionId).openDiff(path, seq, sessionId)
  }
  checkpointBaseline(sessionId: string, userSeq: number, path: string, workspace: string): Promise<Buffer> {
    return this.requireTarget(sessionId).checkpointBaseline(sessionId, userSeq, path, workspace)
  }
  async previewRestore(seq: number, sessionId?: string): Promise<RestorePlan | undefined> {
    return this.requireTarget(sessionId).previewRestore(seq)
  }
  async hasCheckpointFor(seq: number, sessionId?: string): Promise<boolean> {
    return this.requireTarget(sessionId).hasCheckpointFor(seq)
  }
  warmupRewind(sessionId?: string): void {
    try {
      this.requireTarget(sessionId).warmupRewind()
    } catch {
      // Warmup is best-effort; a missing runtime is created on the actual resend.
    }
  }
  async undoRestore(): Promise<void> { await this.requireTarget().undoRestore() }

  async resendFromHistory(seq: number, prompt: string | SdkPromptContentBlock[], displayPrompt = typeof prompt === 'string' ? prompt : prompt.filter(b => b.type === 'text').map(b => b.text).join(' '), route?: { provider: string, model: string }, plan?: RestorePlan, restoreCode = true, parentId?: string): Promise<void> {
    console.log(`[Coding Agent] resendFromHistory called: seq=${seq}, parentId=${parentId}, selectedId=${this.selectedId}, runtimes.has(parentId)=${parentId !== undefined ? this.runtimes.has(parentId) : 'N/A'}`)
    // If the runtime hasn't been created yet (race with restoreSelection), create it on demand.
    let source = parentId === undefined ? this.active() : this.runtimes.get(parentId)
    if (source === undefined && parentId !== undefined) {
      console.log(`[Coding Agent] resendFromHistory: runtime not found for ${parentId}, creating on demand`)
      source = this.create(parentId)
      this.runtimes.set(parentId, source)
    }
    if (source === undefined) throw new Error('源会话尚未恢复，请稍候重试。')
    const sourceId = source.id
    console.log(`[Coding Agent] resendFromHistory source: id=${sourceId}, needsResume=${source.needsResume}, hasStarted=${source.hasStarted}`)
    if (sourceId === undefined) throw new Error('当前没有可恢复的历史会话。')
    // Cursor-style resend: replace the target message and its following
    // content in place. Prior history stays untouched; no full clear/replay.
    if (this.selectedId === sourceId) {
      this.emitDirect({ type: 'busy', busy: true, sessionId: sourceId })
      this.emitDirect({ type: 'resendStart', sessionId: sourceId, seq, text: displayPrompt })
    }
    source.skipUserBubble = true
    const boundarySeq = await source.resendFromHistory(seq, prompt, displayPrompt, route, plan, restoreCode)
    this.historyGenerations.set(sourceId, (this.historyGenerations.get(sourceId) ?? 0) + 1)
    this.histories.delete(sourceId)
    this.catalog.invalidate(sourceId)
    // Notify the webview of the actual rewind boundary so it can update the
    // resent message's data-user-seq for subsequent edits (second resend).
    if (this.selectedId === sourceId && boundarySeq !== undefined) {
      this.emitDirect({ type: 'resendBoundary', sessionId: sourceId, from: seq, seq: boundarySeq })
    }
    this.publish({ type: 'sessionSelected', session: (await this.history(sourceId)).session }, sourceId)
    this.publish({ type: 'checkpointRestored', canUndo: plan !== undefined && restoreCode,
      text: plan === undefined || !restoreCode ? '当前会话已回到该消息之前，后续消息已移除；代码未改变。'
        : '当前会话的代码与对话均已回到该消息之前；后续轮次已移除，可撤销代码恢复。' }, sourceId)
    void source.run(prompt, displayPrompt, route)
  }

  async deleteSession(sessionId: string): Promise<void> {
    this.requireTrust()
    if (this.deletedSessions.has(sessionId)) return
    const runtime = this.runtimes.get(sessionId)
    if (runtime?.busy) throw new Error('当前会话正在运行，请先停止本轮任务再删除；其他历史会话可直接删除。')
    ++this.runGeneration
    this.deletedSessions.add(sessionId)
    this.histories.delete(sessionId)
    this.pendingHistories.delete(sessionId)
    this.runtimes.delete(sessionId)
    this.catalog.invalidate(sessionId)
    this.liveViews.delete(sessionId)
    await runtime?.dispose()
    if (this.selectedId === sessionId) this.newSession()
    this.emit({ type: 'sessionDeleted', sessionId, activeSessionId: this.selectedId })
    const options = this.options()
    try {
      if (options.cwd === undefined || !isAbsolute(options.cwd)) throw new Error('会话工作区路径无效。')
      const workspace = await realpath(options.cwd)
      const root = resolve(options.dshHome, 'sessions')
      const project = resolve(root, sessionProjectKey(workspace))
      const directory = resolve(project, sessionPathSegment(sessionId))
      if (directory === root || relative(project, directory) !== sessionPathSegment(sessionId)) throw new Error('会话路径无效。')
      if (await realpath(directory) !== directory) throw new Error('会话目录是符号链接，已拒绝删除。')
      await rm(directory, { recursive: true, force: true })
      await rm(resolve(options.dshHome, 'storages/session_projcache/sessions', `${sessionPathSegment(sessionId)}.json`), { force: true })
      await this.checkpoints.deleteSession(sessionId)
    } catch (error) {
      if (!existsSync(resolve(options.dshHome, 'sessions', sessionProjectKey(options.cwd ?? ''), sessionPathSegment(sessionId)))) this.deletedSessions.delete(sessionId)
      throw error
    }
  }

  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    ++this.runGeneration
    for (const disposable of this.disposables) disposable.dispose()
    await Promise.all([...new Set([...this.runtimes.values(), ...this.drafts])].map(runtime => runtime.dispose()))
    const readHost = this.readHost
    this.readHost = undefined
    await readHost?.close()
    await this.readTail
  }
}
