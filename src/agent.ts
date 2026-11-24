import { existsSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join, relative, resolve } from 'node:path'
import * as vscode from 'vscode'
import { createHarness, defaultDshHome, developmentRepository, sameNetworkOptions } from './runtime.js'
import type { AgentNetworkOptions } from './runtime.js'
import { ApprovalMemory } from './approval.js'
import type { ApprovalOutcome } from './approval.js'
import { changedPath, openChangedDiff } from './diff.js'
import { InlineDiffRenderer } from './inlineDiff.js'
import { QuestionBroker } from './questions.js'
import { contextLabel } from './context.js'
import type { EditorContext } from './context.js'
import { diagnostic, errorText, hostError, toolError } from './diagnostics.js'
import { VerificationTracker } from './verification.js'
import { EditConflictMonitor } from './conflicts.js'
import { CheckpointStore, workspaceFiles, workspacePath } from './checkpoints.js'
import type { RestorePlan } from './checkpoints.js'
import type { DeepSeekHarness, HarnessNotification, SdkModelCatalog, SdkPromptContentBlock, SdkUserQuestionRequest, SessionHistoryResult, SessionListResult } from '@deepseek-ai/dsh-sdk-client'

/** Match dsh-session-persistence-jsonl's escaped project and Session path segments. */
function sessionPathCharacter(character: string): string {
  return character !== '~' && /^[A-Za-z0-9._-]$/.test(character)
    ? character : `~${character.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0')}`
}

export function sessionPathSegment(value: string): string {
  if (value.length === 0 || value === '.' || value === '..') throw new Error('会话标识无效。')
  return [...value].map(sessionPathCharacter).join('')
}

export function sessionProjectKey(cwd: string): string {
  let readable = ''
  let separator = false
  for (const character of cwd) {
    if (character === '/' || character === '\\' || character === ':') {
      if (!separator) readable += '-'
      separator = true
    } else {
      readable += sessionPathCharacter(character)
      separator = false
    }
  }
  return `--${readable.replace(/^-+/, '').slice(0, 251) || 'root'}--`
}

type AgentEvent = Record<string, unknown> & { type: string }
type Notify = (message: Record<string, unknown>) => void
const errorMessage = errorText

/** One Host owns one session. Session selection and read-only queries are owned by AgentController. */
export class SessionRuntime implements vscode.Disposable {
  private harness: DeepSeekHarness | undefined
  private hostNetwork: AgentNetworkOptions | undefined
  private sessionId: string | undefined
  busy = false
  hasStarted = false
  private hasStreamedText = false
  private replaying = false
  private stopped = false
  needsResume = false
  private changedPaths = new Map<string, number>()
  private changedSessions = new Map<string, string>()
  private inlineDiffVersion = 0
  private inlineDiffTimer: ReturnType<typeof setTimeout> | undefined
  private inlineDiffWarning = ''
  private readonly inlineDiff = new InlineDiffRenderer()
  private pendingModel: { provider: string, model: string } | undefined
  private pendingTools = new Map<string, { name: string, arguments: unknown, checkpointSeq?: number }>()
  private workspace = ''
  private operation = Promise.resolve()
  private readonly questions: QuestionBroker
  private readonly conflicts = new EditConflictMonitor()
  readonly checkpoints: CheckpointStore
  private checkpoint: { id: string, userSeq: number, sessionId: string } | undefined
  private checkpointRebinding: Promise<void> | undefined
  private checkpointTracking = Promise.resolve()
  private checkpointGeneration = 0
  private readonly deletedSessions = new Set<string>()
  private readonly approvalMemory = new ApprovalMemory()

  private notify: Notify
  private turnStartedAt = 0
  private firstTokenAt: number | undefined
  private streamedAttemptId: string | undefined

  /** Runtime identity is mutable until the first Host turn; expose the adopted ID, not the constructor argument. */
  get id(): string | undefined { return this.sessionId }

  constructor(context: vscode.ExtensionContext, private readonly forward: Notify, id?: string) {
    if (id !== undefined) this.needsResume = true
    this.sessionId = id
    this.notify = message => forward({ ...message, ...this.sessionId === undefined ? {} : { sessionId: this.sessionId } })
    this.questions = new QuestionBroker(this.notify)
    this.extensionUri = context.extensionUri
    this.globalStorageUri = context.globalStorageUri
    this.sessionState = context.workspaceState
    this.editorDisposables = [this.inlineDiff,
      vscode.window.onDidChangeVisibleTextEditors(() => this.scheduleInlineDiff()),
      vscode.workspace.onDidOpenTextDocument(document => this.scheduleInlineDiff(document.uri)),
      vscode.workspace.onDidSaveTextDocument(document => this.scheduleInlineDiff(document.uri)),
      vscode.workspace.onDidChangeTextDocument(event => {
        if (this.changedPaths.has(event.document.uri.fsPath)) this.scheduleInlineDiff(event.document.uri)
      }),
    ]
    // Each runtime releases its editor listeners when the Session is deleted or the extension stops.
    const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? 'no-workspace'
    this.checkpoints = new CheckpointStore(resolve(context.globalStorageUri.fsPath, 'checkpoints', encodeURIComponent(cwd)))
    this.scheduleInlineDiff()
  }

  private readonly extensionUri: vscode.Uri
  private readonly globalStorageUri: vscode.Uri
  private readonly verification = new VerificationTracker(this.workspace)
  private readonly sessionState: vscode.Memento
  private readonly editorDisposables: vscode.Disposable[]

  /** Serialize host and selection changes; view focus must not dispose a running Host. */
  private exclusive<T>(task: () => Promise<T>): Promise<T> {
    const next = this.operation.then(task, task)
    this.operation = next.then(() => undefined, () => undefined)
    return next
  }

  /** Legacy single-runtime probes; the multi-session manager owns normal selection persistence. */
  private workspaceKey(): string {
    const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath
    if (cwd === undefined) throw new Error('请先打开一个单项目工作区。')
    return `currentSession:${cwd}`
  }

  adopt(id: string): void {
    if (this.sessionId !== undefined || this.busy) throw new Error('只有尚未启动的新会话可以分配会话标识。')
    this.sessionId = id
  }

  /** The manager preallocated an ID, but the Host rejected it before starting a turn. */
  releaseAdoptedId(): void {
    if (!this.busy) this.sessionId = undefined
  }

  private options() {
    const config = vscode.workspace.getConfiguration('privateCodingAgent')
    const runtimeMode = config.get<'bundled' | 'source'>('runtimeMode') ?? 'bundled'
    const developmentHome = resolve(this.extensionUri.fsPath, '../.dsh-dev')
    // Permission mode is runtime-only state, never persisted to workspace settings
    // where the model could read it as text and self-censor before DSH's sandbox
    // or approval seam can intercept the tool call.
    const permissionMode = this.sessionState.get<'read-only' | 'workspace-write' | 'danger-full-access'>('permissionMode') ?? 'workspace-write'
    return {
      dshRepository: config.get<string>('dshRepository') || (runtimeMode === 'source' ? developmentRepository() : undefined),
      runtimeMode,
      extensionRoot: this.extensionUri.fsPath,
      runtimeStorage: resolve(this.globalStorageUri.fsPath, 'runtime-patches'),
      dshHome: process.env.DSH_AGENT_HOME || config.get<string>('dshHome') || (runtimeMode === 'source' && existsSync(developmentHome) ? developmentHome : defaultDshHome()),
      cwd: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath,
      provider: this.pendingModel?.provider ?? config.get<string>('provider') ?? 'deepseek-account',
      model: this.pendingModel?.model ?? config.get<string>('model') ?? 'deepseek-flash',
      approvalRequests: true,
      permissionMode,
      networkMode: config.get<'direct' | 'system' | 'proxy'>('networkMode') ?? 'direct',
      proxyUrl: config.get<string>('proxyUrl') ?? '',
      onUserQuestion: async (request: SdkUserQuestionRequest) => this.questions.ask(request),
    }
  }

  /** Monotonic turn identity; stop() clears busy without letting a late start() finally clobber a newer turn. */
  private turnSerial = 0

  /** 检测指定 provider 是否已配置凭据（使用临时 read-host，不干扰写 Host） */
  private async hasProviderCredentials(provider: string): Promise<boolean> {
    try {
      return await this.readOnly(async harness => {
        const config = await harness.client.providerConfig({ provider })
        return config.hasCredential === true
      })
    } catch {
      return false
    }
  }

  async start(): Promise<void> {
    if (this.busy) return
    // Capture the exact route selected at this run boundary; Host creation and
    // session/query must not observe different configuration snapshots.
    this.busy = true
    const turn = ++this.turnSerial
    this.turnStartedAt = performance.now()
    this.firstTokenAt = undefined
    this.hasStreamedText = false
    this.streamedAttemptId = undefined
    this.notify({ type: 'status', status: 'running', text: this.harness === undefined ? '正在启动 DSH Host…' : '正在当前会话中发送消息…' })
    try {
      const options = this.options()
      if (options.cwd === undefined) throw new Error('请先打开一个单项目工作区，再发送编码任务。')
      // 阻止使用未配置凭据的占位符模型
      if (options.provider === 'deepseek-official' && options.model === 'deepseek-flash') {
        const hasCredentials = await this.hasProviderCredentials('deepseek-official')
        if (!hasCredentials) {
          throw new Error('当前选择为占位符模型，请先在"添加模型服务"中配置 API Key，或选择其他已配置模型')
        }
      }
      if (this.harness !== undefined && !sameNetworkOptions(this.hostNetwork ?? {}, options)) {
        this.notify({ type: 'status', status: 'running', text: '正在应用新的模型网络设置并恢复当前会话…' })
        await this.closeHost()
      }
      const harness = this.harness ?? createHarness({ ...options, cwd: options.cwd })
      this.harness = harness
      this.hostNetwork = { networkMode: options.networkMode, proxyUrl: options.proxyUrl }
      this.workspace = options.cwd
      this.verification.setWorkspace(options.cwd)
      this.verification.begin()
      this.conflicts.snapshot(options.cwd)
      this.checkpointTracking = Promise.resolve()
      this.checkpointGeneration++
      const sessionId = this.sessionId ?? `session-${randomUUID().replaceAll('-', '')}`
      if (this.forkSource?.sessionId === sessionId && this.harness !== undefined) {
        // Read the real synthetic fork closers before creating a checkpoint.
        // Rebinding an inherited checkpoint would change the old turn instead.
        const history = await harness.sessionHistory(sessionId)
        this.nextUserSeq = (history.events.at(-1)?.seq ?? this.forkSource.seq) + 1
        this.forkSource = undefined
      }
      // Fork history may replace the projection before its synthetic new turn begins.
      // Show the user-visible text (pendingDisplayPrompt), never the wire prompt
      // (pendingPrompt) which carries the injected editor-context trailer; leaking it
      // into the history edit box would append another context layer on every resend.
      // Preserve any image blocks while swapping the text block for the display text.
      const displayPrompt: string | SdkPromptContentBlock[] = Array.isArray(this.pendingPrompt)
        ? [
            ...(this.pendingDisplayPrompt.trim() ? [{ type: 'text', text: this.pendingDisplayPrompt } as SdkPromptContentBlock] : []),
            ...this.pendingPrompt.filter(block => block.type === 'image'),
          ]
        : this.pendingDisplayPrompt
      // Skip the duplicate user bubble when this turn is a history resend:
      // the controller already replaced the target message in place via
      // resendStart, and start() would otherwise append a second copy.
      // Reset the flag immediately so subsequent normal prompts show again.
      if (this.skipUserBubble) {
        this.skipUserBubble = false
      } else {
        this.showUserPrompt(displayPrompt, this.editorContext)
      }
      const checkpoint = await this.checkpoints.before(sessionId, options.cwd, -1, this.pendingDisplayPrompt)
      this.sessionId = sessionId
      this.checkpoint = { id: checkpoint.id, userSeq: -1, sessionId }
      await harness.client.start()
      harness.client.onRequest(async (method, params) => {
        if (method !== 'approval/request') throw new Error(`Unsupported runtime request: ${method}`)
        const tool = typeof params.toolName === 'string' ? params.toolName : '未知工具'
        const reason = typeof params.reason === 'string' ? params.reason : undefined
        // Session-scoped memory: skip the prompt entirely for previously allowed tools.
        if (this.approvalMemory.isAllowed(tool)) {
          this.notify({ type: 'status', status: 'running', text: `已自动允许（会话记忆）：${tool}` })
          return { outcome: 'allowed-once' }
        }
        // Ask the Webview to show an embedded approval card.
        const outcome = await this.askApproval(tool, reason)
        const statusText = outcome === 'rejected' ? '已拒绝本次工具调用'
          : outcome === 'cancelled' ? '已取消本次工具调用'
          : '已允许单次工具调用'
        this.notify({ type: 'status', status: 'running', text: statusText })
        return { outcome }
      })
      await harness.start()
      console.log(`[Coding Agent] Host ready: ${Math.round(performance.now() - this.turnStartedAt)}ms (${sessionId})`)
      this.notify({ type: 'status', status: 'running', text: `${options.provider}/${options.model}` })
      this.notify({ type: 'config', permissionMode: options.permissionMode })
      const resumed = this.sessionId !== undefined && this.needsResume
      if (resumed) await this.resumeSessionIdempotent(sessionId)
      const session = harness.session(sessionId)
      this.needsResume = false
      if (resumed) {
        // A resumed session restores its persisted permission preset, ignoring the
        // Host's env. Align it with the current workspace mode through the native
        // /permission command before any model-visible turn begins.
        try {
          await this.applyPermissionToSession(sessionId, options.permissionMode)
        } catch (error) {
          console.warn(`[Coding Agent] Permission alignment on resume failed: ${errorMessage(error)}`)
        }
      }
      this.hasStarted = true
      const result = await session.run(this.pendingPrompt, {
        route: { provider: options.provider, model: options.model },
        onNotification: event => this.onNotification(event),
      })
      // SessionRegistry owns this session's identity from allocation onward.
      await this.checkpointTracking
      this.sessionId = result.sessionId
      // AgentController owns selection; a background turn must not overwrite it.
      await this.checkpoints.finish(result.sessionId, options.cwd)
      await this.checkpoints.after(result.sessionId, this.currentTurn)
      this.checkpoint = undefined
      this.scheduleInlineDiff()
      if (this.stopped) return
      if (!this.hasStreamedText && result.finalResponse) this.notify({ type: 'assistant', text: result.finalResponse })
      const terminal = result.events.findLast(event => event.type === 'turn/end')
      const reason = terminal?.data.reason as { kind?: string, error?: { message?: string } } | undefined
      if (result.finishReason === 'aborted') {
        // A user cancel settles the turn as aborted with the streamed prefix
        // preserved; the Host stays warm, so report and keep it.
        this.notify({ type: 'status', status: 'idle', text: '已停止当前任务；已保留中断前的输出' })
        return
      }
      if (result.finishReason === 'error') {
        this.notify({ type: 'error', text: hostError(reason?.error ?? '本轮失败，未收到成功结果。') })
      }
      this.notify({ type: 'status', status: result.finishReason === 'completed' ? 'idle' : 'error', text: result.finishReason ?? '本轮已结束' })
    } catch (error) {
      // A stale start() must not touch state owned by a newer turn: stop() may
      // have already released busy and a successor turn may own a fresh Host.
      if (turn !== this.turnSerial) {
        console.error(`[Coding Agent] Stale turn failed (superseded): ${errorText(error)}`)
        return
      }
      if (this.stopped) return
      console.error(`[Coding Agent] Turn failed: ${errorText(error)}`)
      this.notify({ type: 'error', text: hostError(error) })
      this.notify({ type: 'status', status: 'error', text: '启动或执行失败；可修改配置后重试' })
      // A turn that failed before any model work cannot leave the Host wedged;
      // close it so the next send starts clean. A turn that already produced
      // output stays warm so the user can continue the conversation.
      if (!this.hasStreamedText) await this.closeHost()
    } finally {
      // A stop() already released this runtime; a late start() finally must not
      // clobber a newer turn's busy flag.
      if (turn === this.turnSerial) {
        this.busy = false
        this.stopped = false
        this.pendingModel = undefined
        this.hasStarted = this.hasStarted || !this.needsResume && this.sessionId !== undefined
        this.notify({ type: 'busy', busy: false })
        this.notify({ type: 'runtimeFinished', sessionId: this.sessionId })
      }
    }
  }

  private pendingPrompt: string | SdkPromptContentBlock[] = ''
  private pendingDisplayPrompt = ''
  private nextUserSeq = 0
  private forkSource: { sessionId: string, seq: number } | undefined
  private currentTurn: number | undefined

  /** Supplied by the extension at send time, after the user's final edits and selection. */
  editorContext: EditorContext | undefined

  /** One canonical user event for both live prompts and persisted history. */
  private showUserPrompt(prompt: string | SdkPromptContentBlock[], context: EditorContext | undefined, seq?: number, checkpointId?: string): void {
    const text = typeof prompt === 'string' ? prompt : prompt.filter(b => b.type === 'text').map(b => b.text).join(' ')
    const images = typeof prompt === 'string' ? undefined : prompt.filter(b => b.type === 'image').map(b => ({ data: (b as any).data, mimeType: (b as any).mimeType, name: (b as any).name }))
    this.notify({
      type: 'user', text, ...(images === undefined || images.length === 0 ? {} : { images }), ...(seq === undefined ? {} : { seq }), ...(checkpointId === undefined ? {} : { checkpointId }),
      ...(context === undefined ? {} : { context: { ...context, label: contextLabel(context), line: context.selection?.startLine ?? context.cursorLine } }),
    })
  }

  /** Permission changes apply to the live session through DSH's native /permission command. */
  async setPermissionMode(mode: 'read-only' | 'workspace-write' | 'danger-full-access'): Promise<boolean> {
    const previous = this.options().permissionMode
    if (this.busy) {
      this.notify({ type: 'config', permissionMode: previous })
      this.notify({ type: 'error', text: diagnostic('Agent', '任务运行中不能修改权限；请先停止或等待本轮结束。') })
      return false
    }
    // Full-access mode requires an explicit risk confirmation before persisting.
    if (mode === 'danger-full-access') {
      const { confirmFullAccess } = await import('./approval.js')
      const confirmed = await confirmFullAccess()
      if (!confirmed) {
        this.notify({ type: 'config', permissionMode: previous })
        this.notify({ type: 'status', status: 'idle', text: '已取消切换到完全访问模式。' })
        return false
      }
    }
    await this.sessionState.update('permissionMode', mode)
    this.notify({ type: 'config', permissionMode: mode })
    // DSH persists the permission preset in the session log and restores it on
    // resume, so a stale Host env alone cannot change a live session. The native
    // `/permission <preset>` command is the same write path DSH's own Web client
    // uses: it appends a new permission/preset event and updates the sandbox and
    // approval knobs in place. Apply it to the current session immediately so the
    // next turn (including history rewinds) honors the new mode without a new
    // session or an escalation card. Sessions selected later pick the new mode up
    // at resume time via applyPermissionToSession in run/ensureRewindReady.
    if (this.sessionId !== undefined) {
      try {
        await this.applyPermissionToSession(this.sessionId, mode)
        this.notify({ type: 'status', status: 'idle', text: `权限模式已切换为${permissionModeLabel(mode)}，当前会话立即生效。` })
      } catch (error) {
        // The command path requires the permission-presets plugin in the active
        // profile. If it is unavailable, degrade gracefully: the next resume-time
        // alignment in start/ensureRewindReady retries the same command, and a
        // profile without the plugin keeps its original escalation behavior.
        console.warn(`[Coding Agent] In-place permission switch failed: ${errorMessage(error)}`)
        this.notify({ type: 'status', status: 'idle', text: '权限命令未生效；将在下一条消息恢复会话时重试。' })
      }
    }
    return true
  }

  /**
   * Apply a permission preset to a live session through DSH's native `/permission`
   * command. The Host must own the session (resume it if needed) before the
   * command can route to it. No model call is made: command inputs short-circuit
   * at the query router. Failures propagate so callers can fall back to a Host
   * restart on profiles without the permission-presets plugin.
   */
  private async applyPermissionToSession(sessionId: string, mode: 'read-only' | 'workspace-write' | 'danger-full-access'): Promise<void> {
    if (this.harness === undefined) {
      const options = this.options()
      if (options.cwd === undefined) return
      this.workspace = options.cwd
      const harness = createHarness({ ...options, cwd: options.cwd })
      this.harness = harness
      await harness.client.start()
      harness.client.onRequest(async (method, params) => {
        if (method !== 'approval/request') throw new Error(`Unsupported runtime request: ${method}`)
        const tool = typeof params.toolName === 'string' ? params.toolName : '未知工具'
        const reason = typeof params.reason === 'string' ? params.reason : undefined
        if (this.approvalMemory.isAllowed(tool)) return { outcome: 'allowed-once' }
        const outcome = await this.askApproval(tool, reason)
        return { outcome }
      })
      this.needsResume = true
    }
    if (this.needsResume) {
      await this.harness.resumeSession(sessionId)
      this.needsResume = false
    }
    const result = await this.harness.client.request('session/query', {
      sessionId,
      contentBlocks: [{ type: 'text', text: `/permission ${mode}` }],
    }) as { kind?: string, execution?: { result?: { kind?: string, text?: string } } } | undefined
    if (result?.kind !== 'command' || result.execution?.result?.kind !== 'success') {
      throw new Error(`权限命令未生效：${JSON.stringify(result)}`)
    }
  }

  async run(prompt: string | SdkPromptContentBlock[], displayPrompt = typeof prompt === 'string' ? prompt : prompt.filter(b => b.type === 'text').map(b => b.text).join(' '), route?: { provider: string, model: string }): Promise<void> {
    if (this.busy) return
    this.pendingModel = route
    this.pendingPrompt = prompt
    this.pendingDisplayPrompt = displayPrompt
    this.stopped = false
    // Don't reset skipUserBubble here: the controller sets it before calling
    // run() for history resends, and resetting would re-enable the duplicate
    // user bubble that resendStart already replaced.
    await this.start()
  }

  /** Set by the controller when this run is a history resend; start() skips
   * the duplicate user bubble because resendStart already replaced it. */
  skipUserBubble = false

  /** Test and future resume integration can observe the persisted id without exposing the Host. */
  get persistedSessionId(): string | undefined { return this.sessionId }
  /** Reload the persisted current-session selection when the Webview is recreated. */
  async restoreSelection(): Promise<void> {
    if (this.sessionId !== undefined || this.busy) return
    const selected = this.sessionState.get<string>(this.workspaceKey())
    if (selected === undefined || this.deletedSessions.has(selected)) return
    const history = await this.sessionHistory(selected)
    this.sessionId = selected
    this.needsResume = true
    this.stopped = false
    this.replayHistory(history)
    this.notify({ type: 'sessionSelected', session: history.session })
  }

  /** Compatibility query for direct single-runtime probes. Multi-session reads use AgentController. */
  async listSessions(): Promise<SessionListResult> {
    const result = await this.readOnlyUnlocked(harness => harness.listSessions())
    return { ...result, sessions: result.sessions.filter(session => !this.deletedSessions.has(session.id)) }
  }

  async sessionHistory(sessionId: string): Promise<SessionHistoryResult> {
    return this.readOnly(harness => harness.sessionHistory(sessionId))
  }

  /** No preliminary DSH Host: detach the active Session now, clean physical artifacts off the selection queue. */
  async deleteSession(sessionId: string): Promise<void> {
    if (this.deletedSessions.has(sessionId)) return
    const options = this.options()
    if (options.cwd === undefined) throw new Error('请先打开一个单项目工作区。')
    if (this.busy && this.sessionId === sessionId) throw new Error('当前会话正在运行，请先停止本轮任务再删除；其他历史会话可直接删除。')
    this.deletedSessions.add(sessionId)
    if (this.sessionId === sessionId || this.forkSource?.sessionId === sessionId) {
        const harness = this.harness
        this.harness = undefined
        // Clear selection synchronously, before the first asynchronous I/O.
        this.sessionId = undefined
        this.needsResume = false
        this.nextUserSeq = 0
        this.forkSource = undefined
        this.stopped = false
        this.notify({ type: 'sessionSelected' })
        this.notify({ type: 'cleared' })
        void this.resetSessionState()
          .catch(error => this.notify({ type: 'error', text: `会话状态清理失败：${errorMessage(error)}` }))
        void harness?.close().catch(error => this.notify({ type: 'error', text: `旧会话 Host 关闭失败：${errorMessage(error)}` }))
          .then(async () => {
            // Never erase the selection of a newer Session chosen during background cleanup.
            if (this.sessionId === undefined) await this.sessionState.update(this.workspaceKey(), undefined)
          })
    }
    try {
      if (!isAbsolute(options.cwd)) throw new Error('会话工作区路径无效。')
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
      // Partial deletion must not resurrect a ghost Session after its JSONL was removed.
      if (!existsSync(resolve(options.dshHome, 'sessions', sessionProjectKey(options.cwd), sessionPathSegment(sessionId)))) {
        this.deletedSessions.delete(sessionId)
      }
      throw error
    }
  }

  private async readOnly<T>(read: (harness: DeepSeekHarness) => Promise<T>): Promise<T> {
    return this.exclusive(() => this.readOnlyUnlocked(read))
  }

  /** The caller owns the operation queue; nested queries must not enqueue another lock. */
  private readHost: DeepSeekHarness | undefined

  private async readOnlyUnlocked<T>(read: (harness: DeepSeekHarness) => Promise<T>): Promise<T> {
    const options = this.options()
    if (options.cwd === undefined) throw new Error('请先打开一个单项目工作区。')
    const harness = this.readHost ?? createHarness({
      ...options, cwd: options.cwd, approvalRequests: false,
      requestTimeoutMs: 20_000, shutdownTimeoutMs: 1_000,
      disposeEofGraceMs: 2_000, disposeGraceMs: 1_000,
    })
    this.readHost = harness
    try {
      await harness.start()
      return await read(harness)
    } catch (error) {
      // A broken transport is never reused; a successful query stays warm.
      if (this.readHost === harness) this.readHost = undefined
      await harness.close().catch(() => undefined)
      throw error
    }
  }

  /** Close the active Host and restore the selected log; the next prompt resumes its Session. */
  selectSession(sessionId: string): Promise<void> {
    return this.exclusive(async () => {
      console.log(`[Coding Agent] Selecting session ${sessionId}`)
      if (sessionId === this.sessionId) return
      const history = await this.readOnlyUnlocked(harness => harness.sessionHistory(sessionId))
      console.log(`[Coding Agent] History loaded for ${sessionId}`)
      await this.closeHost()
      console.log(`[Coding Agent] Previous Host closed for ${sessionId}`)
      this.sessionId = sessionId
      this.stopped = false
      this.clearInlineDiff()
      await this.sessionState.update(this.workspaceKey(), sessionId)
      this.replayHistory(history)
      this.notify({ type: 'sessionSelected', session: history.session })
      this.notify({ type: 'status', status: 'idle', text: '已恢复历史会话；发送消息将继续原会话' })
    })
  }

  /** Replay persisted events without exposing transient replay state to the selected view. */
  replayHistory(history: SessionHistoryResult): void {
    if (this.busy) throw new Error('运行中的会话不重复加载历史快照。')
    this.clearInlineDiff()
    this.pendingTools.clear()
    this.hasStreamedText = false
    this.replaying = true
    this.nextUserSeq = (history.events.at(-1)?.seq ?? 0) + 1

    // Split events into "recent" (last N user turns) and "older" for progressive
    // restore. The user sees the latest conversation immediately; older turns
    // are prepended in the background.
    const RECENT_TURNS = 3
    const userEvents = history.events.filter(e => e.type === 'user/message' && (e.data as unknown as Record<string, unknown>)?.source && ((e.data as unknown as Record<string, unknown>).source as Record<string, unknown>).kind === 'user')
    const recentBoundarySeq = userEvents.length > RECENT_TURNS
      ? userEvents[userEvents.length - RECENT_TURNS].seq
      : 0

    // Phase 1: replay only recent turns for immediate display
    const recentEvents = recentBoundarySeq > 0
      ? history.events.filter(e => (e.seq ?? 0) >= recentBoundarySeq)
      : history.events
    const recentMessages = this.collectReplayMessages(history.session.id, history.session.cwd, recentEvents)
    this.forward({ type: 'historyReplay', sessionId: history.session.id, messages: recentEvents === history.events ? recentMessages : recentMessages, partial: recentBoundarySeq > 0 })

    // Phase 2: replay older turns in the background and prepend them
    if (recentBoundarySeq > 0) {
      const olderEvents = history.events.filter(e => (e.seq ?? 0) < recentBoundarySeq)
      // Use setTimeout to let the webview render the recent messages first
      setTimeout(() => {
        const olderMessages = this.collectReplayMessages(history.session.id, history.session.cwd, olderEvents)
        this.forward({ type: 'historyReplayOlder', sessionId: history.session.id, messages: olderMessages })
        this.replaying = false
      }, 0)
    } else {
      this.replaying = false
    }
  }

  /** Collect replay messages from a subset of events without side effects. */
  private collectReplayMessages(sessionId: string, cwd: string, events: SessionHistoryResult['events']): Record<string, unknown>[] {
    const messages: Record<string, unknown>[] = []
    const previousNotify = this.notify
    this.notify = message => messages.push(message)
    this.pendingTools.clear()
    this.hasStreamedText = false
    this.notify({ type: 'cleared' })
    void this.checkpoints.list(sessionId).then(checkpoints => {
      for (const checkpoint of checkpoints) this.notify({ type: 'messageCheckpoint', seq: checkpoint.userSeq, checkpointId: checkpoint.id, files: checkpoint.files })
    }).catch(error => this.notify({ type: 'error', text: `检查点读取失败：${errorMessage(error)}` }))
    for (const event of events) {
      if (event.type === 'user/message') {
        if (event.data.source.kind !== 'user') continue
        const content = event.data.content as unknown as Array<Record<string, unknown>>
        const text = messageText(content)
        const images = content.filter(b => b.type === 'image').map(b => ({ data: b.data, mimeType: b.mimeType, name: b.name }))
        if (text || images.length > 0) {
          const displayText = displayPromptText(text)
          const stripped = displayText.length !== text.length
          const blocks: Array<Record<string, unknown>> = []
          if (displayText.trim()) blocks.push({ type: 'text', text: displayText })
          for (const img of images) blocks.push({ type: 'image', data: img.data, mimeType: img.mimeType, name: img.name })
          this.showUserPrompt(blocks.length === 1 && blocks[0].type === 'text' ? displayText : blocks as unknown as SdkPromptContentBlock[], stripped ? historyContext(cwd, text.slice(displayText.length)) : undefined, event.seq)
        }
        this.hasStreamedText = false
        continue
      }
      this.onNotification({ method: 'session.event', params: { sessionId, event } })
    }
    this.pendingTools.clear()
    this.notify = previousNotify
    return messages
  }

  /** Load actual provider catalogs on demand, without replacing or resuming the chat Host. */
  async modelCatalog(): Promise<SdkModelCatalog> {
    return this.readOnly(harness => harness.listModels())
  }

  private onNotification(notification: HarnessNotification): void {
    if (notification.method === 'session.assistant.delta' && !this.replaying) {
      const attemptId = notification.params.attemptId
      const text = notification.params.text
      const reasoning = notification.params.reasoning as string | undefined
      if (typeof attemptId !== 'string' || typeof text !== 'string') return
      if (this.streamedAttemptId !== attemptId) {
        this.streamedAttemptId = attemptId
        this.hasStreamedText = false
        this.notify({ type: 'assistantBoundary' })
        this.notify({ type: 'assistant', text: '' })
      }
      if (this.firstTokenAt === undefined && (text || reasoning)) {
        this.firstTokenAt = performance.now()
        console.log(`[Coding Agent] First assistant text: ${Math.round(this.firstTokenAt - this.turnStartedAt)}ms (${this.sessionId ?? 'draft'})`)
      }
      if (text) {
        this.hasStreamedText = true
        this.notify({ type: 'assistantDelta', text })
      }
      if (reasoning) {
        this.notify({ type: 'assistantReasoning', text: reasoning })
      }
      return
    }
    if (notification.method !== 'session.event') return
    const event = notification.params.event as AgentEvent | undefined
    if (event === undefined) return
    const data = event.data as Record<string, unknown> | undefined
    const source = data?.source as { kind?: unknown } | undefined
    if (!this.replaying && event.type === 'user/message' && this.checkpoint !== undefined
      && source?.kind === 'user' && Array.isArray(data?.content)
      && displayPromptText(messageText(data.content as Array<Record<string, unknown>>)) === this.pendingDisplayPrompt
      && typeof event.seq === 'number' && Number.isSafeInteger(event.seq) && event.seq >= 0 && this.checkpoint.userSeq !== event.seq) {
      const sessionId = this.checkpoint.sessionId
      this.checkpointRebinding = this.checkpoints.rebind(sessionId, this.checkpoint.userSeq, event.seq)
        .catch(error => this.notify({ type: 'error', text: `检查点序号保存失败：${errorMessage(error)}` }))
      this.notify({ type: 'messageSeq', from: this.checkpoint.userSeq, seq: event.seq })
      this.checkpoint.userSeq = event.seq
    }
    if (event.type === 'request/header') {
      const header = data?.header as { config?: { provider?: unknown, model?: unknown } } | undefined
      if (typeof header?.config?.provider === 'string' && typeof header.config.model === 'string') {
        this.notify({ type: 'modelRoute', provider: header.config.provider, model: header.config.model })
      }
    }
    if (event.type === 'llm/retry-started' && !this.replaying) {
      const retry = data?.retry
      const suffix = typeof retry === 'number' && Number.isSafeInteger(retry) && retry > 0 ? `（第 ${retry} 次重试）` : ''
      this.notify({ type: 'status', status: 'running', text: `模型传输失败，正在重新连接${suffix}…` })
    }
    if (event.type === 'turn/start') {
      this.currentTurn = data?.turn as number | undefined
      this.hasStreamedText = false
      this.notify({ type: 'assistantBoundary' })
    }
    if (event.type === 'assistant/attempt' || event.type === 'assistant/message') this.onAssistantEvent(event.type, data)
    if (event.type === 'tool/call') {
      this.pendingTools.set(String(data?.callId ?? ''), { name: String(data?.name ?? ''), arguments: data?.arguments, checkpointSeq: this.checkpoint?.userSeq })
      if (!this.replaying) {
        const name = String(data?.name ?? '')
        const path = changedPath(name, data?.arguments, this.workspace)
        if (path !== undefined && this.sessionId !== undefined) {
          console.log('[Coding Agent] Checkpoint path:', JSON.stringify({ workspace: this.workspace, path, sessionId: this.sessionId }))
        const sessionId = this.sessionId
        const generation = this.checkpointGeneration
        this.checkpointTracking = this.checkpointTracking
            .then(async () => {
              await this.checkpointRebinding
              if (generation !== this.checkpointGeneration) return
              await this.checkpoints.track(sessionId, this.workspace, path)
            })
            .catch(error => this.notify({ type: 'error', text: diagnostic('Agent', `代码检查点记录失败：${errorMessage(error)}`, '该文件不会被静默纳入历史恢复；请用 Git 审查本轮修改。') }))
        }
        void this.conflicts.watch(this.workspace, name, data?.arguments)
          .catch(error => this.notify({ type: 'error', text: diagnostic('工具', `无法完成修改冲突检查：${errorMessage(error)}`, '请在 Git Diff 中审查本次文件修改。') }))
      }
      this.notify({ type: 'tool', callId: data?.callId, tool: data?.name, arguments: data?.arguments })
    }
    if (event.type === 'tool/result') {
      const text = toolText(data)
      const callId = toolResultCallId(data)
      const tool = this.pendingTools.get(callId)
      if (tool !== undefined) {
        const path = toolResultError(data) ? undefined : changedPath(tool.name, tool.arguments, this.workspace)
        if (path !== undefined) {
          this.changedPaths.set(path, tool.checkpointSeq ?? 0)
          if (this.sessionId !== undefined) this.changedSessions.set(path, this.sessionId)
        }
        this.pendingTools.delete(callId)
      }
      if (!this.replaying && !toolResultError(data) && tool?.name === 'bash' && this.sessionId !== undefined) {
        const sessionId = this.sessionId
        this.checkpointTracking = this.checkpointTracking
          .then(() => this.checkpoints.trackWorkspaceChanges(sessionId, this.workspace))
          .catch(error => this.notify({ type: 'error', text: `Bash 代码检查点记录失败：${errorMessage(error)}` }))
      }
      const error = toolResultError(data)
      const rawText = toolText(data)
      this.notify({ type: 'toolResult', callId, text: error ? toolError(rawText) : rawText, error, tool: tool?.name, arguments: tool?.arguments, checkpointSeq: tool?.checkpointSeq })
      // Replaying a prior successful edit also refreshes its decorations without starting a turn.
      if (!error && tool !== undefined && changedPath(tool.name, tool.arguments, this.workspace) !== undefined) this.scheduleInlineDiff()
      if (tool?.name === 'bash' && typeof tool.arguments === 'string') {
        try {
          const command = (JSON.parse(tool.arguments) as { command?: unknown }).command
          if (typeof command === 'string') {
            const summary = this.verification.record(this.workspace, command, rawText, error)
            if (summary !== undefined) {
              this.notify({ type: 'testResult', callId, ...summary })
              this.publishVerification()
            }
          }
        } catch { /* invalid tool arguments are shown in the existing error card */ }
      }
    }
  }

  publishVerification(): void {
    this.notify({ type: 'verificationReport', report: { ...this.verification.report([...this.changedPaths.keys()]), rerunCommand: this.verification.rerunCommand() } })
  }

  async rerunVerification(command: string): Promise<void> {
    if (this.busy) throw new Error('Agent 正在运行，请等待本轮结束后重跑测试。')
    if (command !== this.verification.rerunCommand()) throw new Error('重跑命令已过期，请使用最新验证报告中的按钮。')
    if (this.replayVerification !== undefined) throw new Error('已有一组测试在重跑，请等待它结束。')
    const directory = await mkdtemp(join(tmpdir(), 'coding-agent-test-'))
    const output = join(directory, 'output.log')
    const script = join(directory, 'run.sh')
    const escapedOutput = `'${output.replaceAll("'", "'\\''")}'`
    await writeFile(script, `#!/bin/sh\n${command} >${escapedOutput} 2>&1\nstatus=$?\ncat ${escapedOutput}\nprintf '\\n[exit code: %s]\\n' "$status"\nexit "$status"\n`, { mode: 0o700 })
    const terminal = vscode.window.createTerminal({ name: 'Coding Agent 测试重跑', cwd: this.workspace, isTransient: true })
    this.replayVerification = { terminal, command, directory }
    terminal.show(true)
    terminal.sendText(`/bin/sh '${script.replaceAll("'", "'\\''")}'`, true)
  }

  async finishRerun(terminal: vscode.Terminal, exitCode: number | undefined): Promise<void> {
    const current = this.replayVerification
    if (current === undefined || current.terminal !== terminal || current.finished === true) return
    current.finished = true
    this.replayVerification = undefined
    let output = ''
    try { output = await readFile(join(current.directory, 'output.log'), 'utf8') } catch { /* missing output is an unknown test result */ }
    await rm(current.directory, { recursive: true, force: true })
    if (exitCode === undefined) output += '\n[测试终端未提供退出码，无法确认测试通过]'
    else output += `\n[exit code: ${exitCode}]`
    this.verification.record(this.workspace, current.command, output, exitCode !== 0)
    this.publishVerification()
  }

  private replayVerification: { terminal: vscode.Terminal, command: string, directory: string, started?: boolean, finished?: boolean } | undefined

  async finishRerunExecution(terminal: vscode.Terminal, commandLine: string, exitCode: number | undefined, started: boolean): Promise<void> {
    const current = this.replayVerification
    if (current === undefined || current.terminal !== terminal) return
    const expected = `/bin/sh '${join(current.directory, 'run.sh').replaceAll("'", "'\\''")}'`
    if (commandLine !== expected) return
    if (started) current.started = true
    else if (current.started === true) await this.finishRerun(terminal, exitCode)
  }

  private onAssistantEvent(type: string, data: Record<string, unknown> | undefined): void {
    const message = data?.message as { content?: Array<Record<string, unknown>> } | undefined
    // Persisted attempts and messages both carry the same text: render one, never both.
    if (type === 'assistant/attempt' && this.hasStreamedText) return
    if (!this.hasStreamedText && Array.isArray(message?.content)) {
      // Only mark hasStreamedText for messages that do NOT contain tool-call blocks.
      // During replay, an assistant/message may carry both text and tool-call blocks
      // (an intermediate step). Marking hasStreamedText here would suppress the final
      // text-only assistant/message that arrives after all tools complete.
      const hasToolCall = message.content.some(block => block.type === 'tool-call')
      if (!hasToolCall) {
        const text = messageText(message.content)
        if (text) {
          this.firstTokenAt ??= performance.now()
          console.log(`[Coding Agent] First assistant text: ${Math.round(this.firstTokenAt - this.turnStartedAt)}ms (${this.sessionId ?? 'draft'})`)
          this.hasStreamedText = true
          this.notify({ type: 'assistant', text })
        }
      }
    }
    // --- Reasoning/thinking chain display ---
    // DSH may include reasoning content blocks in assistant/attempt and
    // assistant/message events; replayed history carries them on the settled
    // assistant/message, so extract from both event types.
    if ((type === 'assistant/attempt' || type === 'assistant/message') && Array.isArray(message?.content)) {
      const reasoning = message.content
        .filter((block: Record<string, unknown>) => block.type === 'reasoning' || block.type === 'thinking')
        .map((block: Record<string, unknown>) => String(block.text ?? block.thinking ?? ''))
        .filter((text: string) => text.length > 0)
      if (reasoning.length > 0) {
        this.notify({ type: 'assistantReasoning', text: reasoning.join('\n\n') })
      }
    }
  }

  /** Release a persisted Host write lock before showing a reloaded historical snapshot. */
  async prepareRestore(): Promise<void> {
    if (this.needsResume && !this.busy && this.harness !== undefined) await this.closeHost()
  }

  /**
   * Resolve the rewind boundary from the persisted event log instead of trusting
   * the UI-bound seq blindly. The in-memory Agent projection inside the Host may
   * number events differently from the persisted log after restarts, forks, or
   * synthetic closers, so DSH's `rewind(beforeSeq)` can hit a `step/end` rather
   * than the intended `user/message`. Search the durable log for the exact user
   * message event: prefer the event at `seq` itself, otherwise walk backwards to
   * the nearest user message, and finally match by prompt text as a fallback.
   */
  private async resolveRewindBoundary(sessionId: string, seq: number, prompt?: string): Promise<number> {
    try {
      // Caller (resendFromHistory) already holds the exclusive lock; re-acquiring
      // it via readOnly() would self-deadlock. Use the unlocked variant here.
      const history = await this.readOnlyUnlocked(harness => harness.sessionHistory(sessionId))
      const isUserMessage = (event: AgentEvent | undefined): event is AgentEvent =>
        event !== undefined && event.type === 'user/message'
        && (event.data as { source?: { kind?: unknown } } | undefined)?.source?.kind === 'user'
      const candidates = history.events.filter(event => isUserMessage(event as AgentEvent))
      // Fast path: the exact seq still exists in the current log.
      const at = candidates.find(event => event.seq === seq)
      if (at !== undefined) return seq
      // The requested seq may have been truncated by a prior rewind. Match by
      // prompt text so the user can re-edit the same message again.
      if (prompt !== undefined) {
        const match = candidates.findLast(event => Array.isArray((event.data as { content?: unknown })?.content)
          && messageText((event.data as { content: Array<Record<string, unknown>> }).content) === prompt)
        if (match !== undefined) return match.seq as number
      }
      // If no prompt match, fall back to the most recent user message (the one
      // the user most likely intends to re-send). This avoids a raw rewind with
      // a stale seq that DSH would reject as out of range.
      if (candidates.length > 0) {
        const latest = candidates.at(-1)!.seq as number
        console.log(`[Coding Agent] Rewind boundary fallback: using latest user/message seq ${latest} (requested ${seq})`)
        return latest
      }
      // No user messages at all: nothing to rewind to. This should not happen
      // in normal use; treat it as a no-op rewind to seq 0 (retains header only).
      console.warn(`[Coding Agent] No user/message boundary found in session ${sessionId}; rewinding to start`)
      return 0
    } catch (error) {
      console.warn(`[Coding Agent] Rewind boundary resolution failed: ${errorMessage(error)}; falling back to raw rewind`)
      this.notify({ type: 'status', status: 'running', text: '回滚边界解析失败，使用原始位置' })
      return seq
    }
  }

  private rewindReadyPromise: Promise<void> | undefined

  /** Keep a warm Host; only a genuinely cold Session needs a one-time resume. */
  private ensureRewindReady(sessionId: string): Promise<void> {
    // Concurrent callers (rewind warmup vs. the resend itself) share one
    // in-flight preparation so a cold Host is created/resumed exactly once.
    this.rewindReadyPromise ??= this.prepareRewind(sessionId)
      .finally(() => { this.rewindReadyPromise = undefined })
    return this.rewindReadyPromise
  }

  /**
   * Resume through the SDK, treating "already open or opening" as success: the
   * warmup path and the rewind path can race their resume calls, and both want
   * the same end state (the session open once), so a concurrent open satisfies us.
   */
  private async resumeSessionIdempotent(sessionId: string): Promise<void> {
    if (this.harness === undefined) throw new Error('当前会话的 Host 尚未恢复，请稍后重试。')
    try {
      await this.harness.resumeSession(sessionId)
    } catch (error) {
      if (!errorMessage(error).includes('already open or opening')) throw error
    }
  }

  private async prepareRewind(sessionId: string): Promise<void> {
    if (this.harness !== undefined) {
      if (this.needsResume) {
        await this.resumeSessionIdempotent(sessionId)
        this.needsResume = false
        // The resumed session restores its persisted preset; align it with the
        // current workspace mode before the rewind boundary is evaluated.
        const mode = this.options().permissionMode
        try {
          await this.applyPermissionToSession(sessionId, mode)
        } catch (error) {
          console.warn(`[Coding Agent] Permission alignment before rewind failed: ${errorMessage(error)}`)
        }
      }
      return
    }
    const options = this.options()
    if (options.cwd === undefined) throw new Error('请先打开一个单项目工作区。')
    this.workspace = options.cwd
    const harness = createHarness({ ...options, cwd: options.cwd })
    this.harness = harness
    await harness.client.start()
    harness.client.onRequest(async (method, params) => {
      if (method !== 'approval/request') throw new Error(`Unsupported runtime request: ${method}`)
      const tool = typeof params.toolName === 'string' ? params.toolName : '未知工具'
      const reason = typeof params.reason === 'string' ? params.reason : undefined
      if (this.approvalMemory.isAllowed(tool)) {
        this.notify({ type: 'status', status: 'running', text: `已自动允许（会话记忆）：${tool}` })
        return { outcome: 'allowed-once' }
      }
      const outcome = await this.askApproval(tool, reason)
      const statusText = outcome === 'rejected' ? '已拒绝本次工具调用'
        : outcome === 'cancelled' ? '已取消本次工具调用'
        : '已允许单次工具调用'
      this.notify({ type: 'status', status: 'running', text: statusText })
      return { outcome }
    })
    await this.resumeSessionIdempotent(sessionId)
    // The resumed session restores its persisted preset; align it with the current
    // workspace mode before the rewind boundary is evaluated.
    try {
      await this.applyPermissionToSession(sessionId, options.permissionMode)
    } catch (error) {
      console.warn(`[Coding Agent] Permission alignment before rewind failed: ${errorMessage(error)}`)
    }
  }

  /** Clear selection and volatile replay state, even if deleting its storage partially failed. */
  private async resetSessionState(): Promise<void> {
    this.sessionId = undefined
    this.needsResume = false
    this.nextUserSeq = 0
    this.forkSource = undefined
    this.stopped = false
    this.verification.begin()
    this.conflicts.clear()
    if (this.replayVerification !== undefined) {
      this.replayVerification.terminal.dispose()
      await rm(this.replayVerification.directory, { recursive: true, force: true })
    }
    this.replayVerification = undefined
    this.clearInlineDiff()
    await this.sessionState.update(this.workspaceKey(), undefined)
    this.notify({ type: 'sessionSelected' })
    this.notify({ type: 'cleared' })
  }

  newSession(): Promise<void> {
    return this.exclusive(async () => {
      if (this.busy) throw new Error('任务运行中不能新建会话，请先停止或等待本轮结束。')
      this.stopped = false
      await this.closeHost()
      await this.resetSessionState()
      this.notify({ type: 'status', status: 'idle', text: '已新建会话；发送消息时启动 Host' })
    })
  }

  async restart(): Promise<void> {
    if (this.busy) return
    this.stopped = false
    await this.closeHost()
    this.notify({ type: 'status', status: 'idle', text: '模型配置将在下一条消息生效；已有会话将恢复' })
  }

  async resume(): Promise<void> {
    if (this.busy) return
    if (this.sessionId === undefined) {
      this.notify({ type: 'error', text: '当前没有可恢复的会话，请先发送一条消息。' })
      return
    }
    this.stopped = false
    await this.closeHost()
    this.notify({ type: 'status', status: 'idle', text: 'Host 已重启；下一条消息将恢复当前会话' })
  }

  async previewRestore(seq: number): Promise<RestorePlan | undefined> {
    return this.exclusive(async () => {
      if (this.busy) throw new Error('任务运行中不能预览历史恢复，请先停止或等待本轮结束。')
      if (!Number.isSafeInteger(seq) || seq < 0 || this.sessionId === undefined) throw new Error('当前没有可恢复的历史会话。')
      const workspace = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath
      if (workspace === undefined) throw new Error('请先打开一个单项目工作区。')
      const checkpoint = (await this.checkpoints.list(this.sessionId)).find(item => item.userSeq === seq)
      return checkpoint === undefined ? undefined : this.checkpoints.previewRestore(workspace, this.sessionId, seq)
    })
  }

  /**
   * Cheap checkpoint existence probe (index-only, no snapshot I/O). Used to pick
   * the confirmation dialog wording without paying for a full preview up front.
   */
  async hasCheckpointFor(seq: number): Promise<boolean> {
    if (this.sessionId === undefined || !Number.isSafeInteger(seq) || seq < 0) return false
    return (await this.checkpoints.list(this.sessionId)).some(item => item.userSeq === seq)
  }

  /**
   * Warm the Host (and resume the session when cold) while the user is still
   * reading the confirmation dialog, so the rewind itself starts from a ready
   * state instead of paying the resume cost after the click. Runs outside the
   * exclusive queue so it overlaps with previewRestore; ensureRewindReady
   * deduplicates concurrent preparation.
   */
  warmupRewind(): void {
    const sourceId = this.sessionId
    if (sourceId === undefined || this.busy) return
    void this.ensureRewindReady(sourceId)
      .catch(error => console.warn(`[Coding Agent] Rewind warmup failed: ${errorMessage(error)}`))
  }

  async resendFromHistory(seq: number, prompt: string | SdkPromptContentBlock[], displayPrompt = typeof prompt === 'string' ? prompt : prompt.filter(b => b.type === 'text').map(b => b.text).join(' '), route?: { provider: string, model: string }, plan?: RestorePlan, restoreCode = true): Promise<number> {
    return this.exclusive(async () => {
      if (this.busy) throw new Error('任务运行中不能恢复历史，请先停止或等待本轮结束。')
      if (restoreCode && this.sessionId !== undefined) {
        const workspace = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath
        if (workspace === undefined) throw new Error('请先打开一个单项目工作区。')
      }
      if (!Number.isSafeInteger(seq) || seq < 0) throw new Error('历史消息位置无效。')
      const sourceId = this.sessionId
      if (sourceId === undefined) throw new Error('当前没有可恢复的历史会话。')
      const options = this.options()
      if (options.cwd === undefined) throw new Error('请先打开一个单项目工作区。')
      const workspace = this.workspace || options.cwd
      // The UI-bound seq may not resolve to a user/message inside the Host's in-memory
      // projection after restarts or synthetic events; resolve the real boundary from the
      // durable log before invoking DSH rewind, and key all checkpoint lookups off it.
      // Run the boundary resolution and the checkpoint index read concurrently:
      // they hit independent stores (durable event log vs. checkpoint index).
      const [boundarySeq, checkpoints] = await Promise.all([
        this.resolveRewindBoundary(sourceId, seq, typeof prompt === 'string' ? prompt : undefined),
        this.checkpoints.list(sourceId),
      ])
      if (boundarySeq !== seq) {
        console.log(`[Coding Agent] Rewind boundary adjusted: UI seq ${seq} -> user/message seq ${boundarySeq} (${sourceId})`)
      }
      const checkpoint = checkpoints.find(item => item.userSeq === boundarySeq)
        ?? checkpoints.find(item => item.userSeq === seq)
      this.clearInlineDiff()
      this.notify({ type: 'status', status: 'running', text: '正在回滚当前会话…' })
      const started = performance.now()
      // A warmup triggered while the confirmation dialog was open may still be
      // resuming the Host; ensureRewindReady joins that in-flight preparation
      // instead of starting a second resume.
      await this.ensureRewindReady(sourceId)
      if (this.harness === undefined) throw new Error('当前会话的 Host 尚未恢复，请稍后重试。')
      console.log(`[Coding Agent] Rewind Host ready: ${Math.round(performance.now() - started)}ms (${sourceId})`)
      await this.harness.session(sourceId).rewind(boundarySeq)
      console.log(`[Coding Agent] Conversation rewind: ${Math.round(performance.now() - started)}ms (${sourceId})`)
      // Rewind truncates the log at the boundary, discarding any permission/preset
      // event appended after it. Re-apply the current workspace mode so the
      // truncated session does not silently revert to its original preset.
      try {
        await this.applyPermissionToSession(sourceId, options.permissionMode)
      } catch (error) {
        console.warn(`[Coding Agent] Permission re-application after rewind failed: ${errorMessage(error)}`)
      }
      this.needsResume = false
      this.nextUserSeq = boundarySeq
      this.checkpoint = undefined
      this.forkSource = undefined
      if (checkpoint !== undefined && restoreCode) {
        // Backup only files that can be written by this restore, not every workspace file.
        const undoFiles = plan === undefined
          ? [...new Set([...checkpoint.files, ...checkpoint.workspaceFiles ?? [], ...await workspaceFiles(workspace)])]
          : plan.changes.filter(change => change.kind !== 'unchanged').map(change => change.path)
        await this.checkpoints.backupForUndo(sourceId, workspace, undoFiles, plan === undefined)
        // Files may have drifted between the confirmation dialog and this execution
        // (e.g. an approved tool write in the current turn). Rebuild the plan from live
        // disk state so restore proceeds against the targets the user already confirmed,
        // instead of aborting the whole rewind on a stale preview hash.
        let activePlan = plan
        if (activePlan !== undefined) {
          try {
            await this.checkpoints.validateRestore(workspace, activePlan)
          } catch {
            console.log(`[Coding Agent] Restore plan drifted since preview; rebuilding from live state (${sourceId})`)
            activePlan = await this.checkpoints.previewRestore(workspace, sourceId, boundarySeq)
          }
        }
        const restored = await this.checkpoints.restoreFrom(workspace, sourceId, boundarySeq,
          activePlan === undefined ? undefined : new Map(activePlan.changes.map(change => [change.path, change.currentHash])),
          activePlan)
        for (const document of vscode.workspace.textDocuments.filter(document => restored.includes(vscode.workspace.asRelativePath(document.uri, false)))) {
          if (!document.isDirty) await vscode.commands.executeCommand('workbench.action.files.revert', document.uri)
        }
        console.log(`[Coding Agent] Code restore: ${Math.round(performance.now() - started)}ms (${sourceId})`)
      }
      return boundarySeq
    })
  }

  async undoRestore(): Promise<void> {
    if (this.sessionId === undefined) return
    if (this.busy) {
      this.notify({ type: 'error', text: diagnostic('Agent', '请先停止本轮任务，再撤销代码恢复。') })
      return
    }
    if (await this.checkpoints.undo(this.workspace, this.sessionId)) {
      this.notify({ type: 'status', status: 'idle', text: '已撤销代码恢复，回到恢复前的文件状态。' })
    }
  }

  /** Testing hook: feed the same notification shape received from DSH without a model call. */
  inspectNotification(notification: HarnessNotification): void { this.onNotification(notification) }

  /** Ask the user via Webview approval card. Resolves when the user clicks an action. */
  private askApproval(tool: string, reason?: string): Promise<ApprovalOutcome> {
    return new Promise(resolve => {
      const requestId = randomUUID()
      const handler = (message: Record<string, unknown>) => {
        if (message.type !== 'approvalResponse' || message.requestId !== requestId) return
        this.removeApprovalHandler(handler)
        resolve(message.outcome as ApprovalOutcome)
      }
      this.approvalHandlers.set(requestId, handler)
      this.notify({
        type: 'approvalRequest',
        requestId,
        tool,
        reason: reason ?? '此操作需要提升权限。',
      })
    })
  }

  private readonly approvalHandlers = new Map<string, (message: Record<string, unknown>) => void>()

  private removeApprovalHandler(handler: (message: Record<string, unknown>) => void): void {
    for (const [id, h] of this.approvalHandlers) {
      if (h === handler) { this.approvalHandlers.delete(id); break }
    }
  }

  /** Route an approval response from the Webview back to the pending request. */
  handleApprovalResponse(requestId: string, outcome: ApprovalOutcome): void {
    const handler = this.approvalHandlers.get(requestId)
    if (handler === undefined) return
    this.approvalHandlers.delete(requestId)
    handler({ type: 'approvalResponse', requestId, outcome })
  }

  answerQuestions(id: unknown, answers: unknown): void {
    if (!this.questions.answer(id, answers)) this.notify({ type: 'error', text: '该问题已失效或回答格式不完整，请重试。' })
  }

  /** Remember a tool for the rest of this session. */
  allowToolForSession(tool: string): void {
    this.approvalMemory.allow(tool)
    this.notify({ type: 'approvalMemory', tools: this.approvalMemory.tools })
    this.notify({ type: 'status', status: 'idle', text: `已记住：本会话不再询问 ${tool}` })
  }

  /** Clear all remembered tools. */
  clearApprovalMemory(): void {
    this.approvalMemory.clear()
    this.notify({ type: 'approvalMemory', tools: [] })
    this.notify({ type: 'status', status: 'idle', text: '已清空本会话的工具记忆' })
  }

  /** Current remembered tool list for UI sync. */
  get approvalMemoryTools(): string[] {
    return this.approvalMemory.tools
  }

  private clearInlineDiff(): void {
    this.changedPaths.clear()
    this.changedSessions.clear()
    this.inlineDiffVersion++
    if (this.inlineDiffTimer !== undefined) clearTimeout(this.inlineDiffTimer)
    this.inlineDiffTimer = undefined
    this.inlineDiffWarning = ''
    for (const editor of vscode.window.visibleTextEditors) this.inlineDiff.clear(editor)
  }

  /** Decoration failures are local to the editor; they must never fail an Agent turn. */
  private scheduleInlineDiff(uri?: vscode.Uri): void {
    if (this.inlineDiffTimer !== undefined) clearTimeout(this.inlineDiffTimer)
    this.inlineDiffTimer = setTimeout(() => {
      this.inlineDiffTimer = undefined
      void this.refreshInlineDiff(uri).catch(error => {
        const message = errorMessage(error)
        console.log(`[Coding Agent] Inline diff failed: ${message}`)
        if (message === this.inlineDiffWarning) return
        this.inlineDiffWarning = message
        this.notify({ type: 'status', status: 'idle', text: '代码对比暂不可用；代码修改与测试结果不受影响，详情见 Coding Agent 输出日志。' })
      })
    }, 50)
  }

  /** Keep decorations attached to normal editors, not a separate Diff editor. */
  async refreshInlineDiff(uri?: vscode.Uri): Promise<void> {
    const version = ++this.inlineDiffVersion
    const entries = vscode.window.visibleTextEditors
      .filter(editor => uri === undefined || editor.document.uri.toString() === uri.toString())
      .map(editor => ({
        editor,
        userSeq: this.changedPaths.get(editor.document.uri.fsPath),
        sessionId: this.changedSessions.get(editor.document.uri.fsPath),
        version: editor.document.version,
      }))
    await Promise.all(entries.map(async ({ editor, userSeq, sessionId, version: documentVersion }) => {
      this.inlineDiff.clear(editor)
      if (userSeq === undefined || sessionId === undefined) return
      const path = editor.document.uri.fsPath
      const baseline = await this.checkpoints.baseline(sessionId, userSeq, path, this.workspace)
      if (version !== this.inlineDiffVersion || documentVersion !== editor.document.version) return
      if (baseline === undefined || baseline.includes(0)) return
      this.inlineDiff.apply(editor, baseline.toString('utf8'), [path, userSeq, sessionId])
    }))
  }

  /** Read-only historical snapshots are scoped to the current workspace, not the live session. */
  async checkpointBaseline(sessionId: string, userSeq: number, path: string, workspace: string): Promise<Buffer> {
    const current = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath
    if (current === undefined || workspace !== current) throw new Error('代码对比不属于当前工作区。')
    const baseline = await this.checkpoints.baseline(sessionId, userSeq, path, workspace)
    if (baseline === undefined) throw new Error('该文件没有本轮修改前的代码快照。')
    return baseline
  }

  async openDiff(path?: string, userSeq?: number, sessionId?: string): Promise<void> {
    const owner = sessionId ?? (path === undefined ? undefined : this.changedSessions.get(path)) ?? this.sessionId
    const workspace = this.workspace || vscode.workspace.workspaceFolders?.[0]?.uri.fsPath
    if (path !== undefined && typeof userSeq === 'number' && owner !== undefined && workspace !== undefined) {
      const baseline = await this.checkpoints.baseline(owner, userSeq, path, workspace)
      if (baseline === undefined) {
        await openChangedDiff(this.workspace, [resolve(this.workspace, path)])
        return
      }
      const local = workspacePath(workspace, path)
      const before = vscode.Uri.from({
        scheme: 'coding-agent-checkpoint',
        path: `/${local}`,
        query: new URLSearchParams({ sessionId: owner, userSeq: String(userSeq), workspace, path: local }).toString(),
      })
      await vscode.commands.executeCommand('vscode.diff', before, vscode.Uri.file(resolve(workspace, local)), `${local}（本轮修改前 ↔ 当前）`)
      await vscode.commands.executeCommand('diffEditor.setViewMode.inline')
      return
    }
    await openChangedDiff(this.workspace, [...this.changedPaths.keys()])
  }

  async stop(): Promise<void> {
    if (!this.busy || this.stopped) return
    this.stopped = true
    this.checkpointGeneration++
    const sessionId = this.sessionId
    const harness = this.harness
    let cancelled = false
    if (sessionId !== undefined && harness !== undefined) {
      try {
        // Graceful cancel: the Host aborts the active turn, settles any
        // streamed prefix as an interrupted assistant/message, and stays warm.
        await harness.client.cancelSession(sessionId)
        cancelled = true
      } catch (error) {
        console.warn(`[Coding Agent] Graceful cancel failed; falling back to Host teardown: ${errorMessage(error)}`)
      }
    }
    if (cancelled) {
      // The turn/end notification releases busy through the normal finally path.
      this.notify({ type: 'status', status: 'idle', text: '已停止当前任务；可随时继续发送' })
      return
    }
    // No warm Host (cold start race) or the runtime predates session/cancel:
    // tear the Host down. The user turn stays durable; the Webview's
    // submission echo state machine restores an unacknowledged prompt.
    await this.closeHost()
    ++this.turnSerial
    this.busy = false
    this.stopped = false
    this.notify({ type: 'busy', busy: false })
    this.notify({ type: 'status', status: 'idle', text: '已停止 DSH Host；未完成任务已中断；历史会话仍可恢复' })
  }

  /** Queue: run a follow-up prompt immediately after the current turn settles.
   * The runtime stays alive; no Host teardown happens between turns. */
  queueNext(prompt: string | SdkPromptContentBlock[], displayPrompt = typeof prompt === 'string' ? prompt : prompt.filter(b => b.type === 'text').map(b => b.text).join(' '), route?: { provider: string, model: string }): void {
    const start = async () => {
      this.pendingModel = route
      this.pendingPrompt = prompt
      this.pendingDisplayPrompt = displayPrompt
      this.stopped = false
      try { await this.start() }
      catch (error) {
        // start() normally reports its own failures and never rethrows; if a
        // synchronous throw ever escapes here the queue must not leave busy stuck.
        this.busy = false
        this.notify({ type: 'busy', busy: false })
        this.notify({ type: 'error', text: `排队消息执行失败：${errorMessage(error)}` })
      }
    }
    if (!this.busy) { void start(); return }
    this.operation = this.operation.then(start, start)
  }

  private async closeHost(): Promise<void> {
    this.questions.cancel()
    const harness = this.harness
    this.harness = undefined
    this.needsResume = this.sessionId !== undefined
    try {
      await harness?.close()
    } catch (error) {
      this.notify({ type: 'error', text: diagnostic('Host', `关闭失败：${errorMessage(error)}`, '可以重载窗口；已有会话记录仍保留在 DSH 中。') })
      // Attempt force-kill on close failure to prevent zombie processes
      try {
        const client = (harness as unknown as { client?: { kill?: () => void } })?.client
        client?.kill?.()
      } catch { /* ignore force-kill errors */ }
    }
  }

  async dispose(): Promise<void> {
    if (this.inlineDiffTimer !== undefined) clearTimeout(this.inlineDiffTimer)
    for (const disposable of this.editorDisposables) disposable.dispose()
    this.replayVerification?.terminal.dispose()
    if (this.replayVerification !== undefined) await rm(this.replayVerification.directory, { recursive: true, force: true })
    this.replayVerification = undefined
    await this.closeHost()
    await this.readHost?.close()
    this.readHost = undefined
  }
}

/** Strip editor-context and @-reference trailers that the extension appends to
 * the wire prompt but never shows as part of the user's typed text. Mirrors the
 * boundary logic in replayHistory. */
function displayPromptText(text: string): string {
  const editorSeparator = text.indexOf('\n\n<editor-context>')
  const referenceSeparator = text.indexOf('\n\n以下是用户通过 @ 明确引用的文件：')
  const boundaries = [editorSeparator, referenceSeparator].filter(index => index >= 0)
  const separator = boundaries.length === 0 ? -1 : Math.min(...boundaries)
  return separator < 0 ? text : text.slice(0, separator)
}

function historyContext(workspace: string, block: string): EditorContext | undefined {
  const path = block.match(/^当前文件：(.+)$/m)?.[1]
  const line = Number(block.match(/^光标位置：第 (\d+) 行/m)?.[1])
  if (path === undefined || !Number.isSafeInteger(line) || line < 1) return undefined
  const startLine = Number(block.match(/^用户选中了第 (\d+)–/m)?.[1] ?? line)
  const endLine = Number(block.match(/^用户选中了第 \d+–(\d+) 行/m)?.[1] ?? startLine)
  return {
    path, uri: vscode.Uri.file(resolve(workspace, path)).toString(), language: '',
    cursorLine: line, cursorColumn: 1,
    selection: { startLine, endLine, text: '', truncated: false },
  }
}

function permissionModeLabel(mode: 'read-only' | 'workspace-write' | 'danger-full-access'): string {
  return mode === 'read-only' ? '只读' : mode === 'workspace-write' ? '工作区可写' : '完全访问'
}

function messageText(content: readonly Record<string, unknown>[]): string {
  return content.flatMap(block => {
    if (block.type === 'text') return [String(block.text ?? '')]
    if (block.type === 'tool-result' && !Array.isArray(block.content)) return []
    if (block.type !== 'tool-result' && block.type !== 'text') return []
    return (block.content as Array<Record<string, unknown>>)
      .filter(part => part.type === 'text').map(part => String(part.text ?? ''))
  }).join('\n')
}

function toolResultCallId(data: Record<string, unknown> | undefined): string {
  const message = data?.message as { source?: { callId?: unknown }, content?: Array<Record<string, unknown>> } | undefined
  if (typeof message?.source?.callId === 'string') return message.source.callId
  const result = message?.content?.find(block => block.type === 'tool-result')
  return typeof result?.toolCallId === 'string' ? result.toolCallId : ''
}

function toolResultError(data: Record<string, unknown> | undefined): boolean {
  const message = data?.message as { isError?: unknown, content?: Array<Record<string, unknown>> } | undefined
  return data?.error !== undefined || message?.isError === true
    || message?.content?.some(block => block.isError === true) === true
}

function toolText(data: Record<string, unknown> | undefined): string {
  const message = data?.message as { content?: Array<Record<string, unknown>> } | undefined
  if (!Array.isArray(message?.content)) return '工具调用已结束'
  return messageText(message.content).slice(0, 4000)
}
