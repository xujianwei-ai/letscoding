import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readdir, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import * as vscode from 'vscode'

export interface Checkpoint {
  id: string
  sessionId: string
  userSeq: number
  turn?: number
  prompt: string
  files: string[]
  workspaceFiles?: string[]
  untrackedLargeFiles?: Record<string, LargeFileState>
  restoredLargeFiles?: string[]
  createdAt: number
}

interface TurnEnd { sessionId: string, userSeq: number, files: Record<string, string | undefined>, largeFiles?: Record<string, FileMetadata | undefined> }
interface State { version: 1, checkpoints: Checkpoint[], undos: Record<string, Checkpoint>, turnEnds?: TurnEnd[] }
const emptyState = (): State => ({ version: 1, checkpoints: [], undos: {} })
const snapshotName = (id: string): string => `${id}.json`

export function workspacePath(workspace: string, path: string): string {
  if ([...path].some(character => character.charCodeAt(0) === 0)) throw new Error('检查点文件路径无效。')
  const absolute = resolve(workspace, path)
  const local = relative(workspace, absolute)
  if (local === '' || local === '..' || local.startsWith(`..${sep}`) || isAbsolute(local)) throw new Error('检查点文件超出工作区。')
  if (local.split(/[\\/]/).some(part => ['.git', 'node_modules', '.dsh-dev', '.vscode-agent-dev', '.venv'].includes(part))) throw new Error('检查点不包含 Git、依赖或私有数据。')
  return local
}

function excluded(path: string): boolean {
  const name = basename(path)
  return name === '.env' || name.startsWith('.env.') || /\.(pem|key|p12)$/i.test(name)
    || path.split(/[\\/]/).some(part => ['.git', 'node_modules', '.dsh-dev', '.vscode-agent-dev', '.venv'].includes(part))
}

interface SnapshotFile { path: string, content?: string, hash?: string }
const maxFileBytes = 10 * 1024 * 1024
type FileMetadata = { size: number, mtimeMs: number }
type LargeFileState = FileMetadata & { changed?: boolean }
type FileState = { metadata?: FileMetadata, content?: Buffer, hash?: string }

async function fileState(workspace: string, path: string, readContent = true): Promise<FileState> {
  const target = resolve(workspace, workspacePath(workspace, path))
  const metadata = await stat(target).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return undefined
    throw error
  })
  if (metadata === undefined) return {}
  if (!metadata.isFile()) throw new Error(`检查点不支持非普通文件：${path}。`)
  const state: FileState = { metadata: { size: metadata.size, mtimeMs: metadata.mtimeMs } }
  if (readContent && metadata.size <= maxFileBytes) {
    state.content = await readFile(target)
    state.hash = hash(state.content)
  }
  return state
}

function metadataChanged(before: FileMetadata | undefined, after: FileMetadata | undefined): boolean {
  return before?.size !== after?.size || before?.mtimeMs !== after?.mtimeMs
}

/** Large files are never buffered. Their content is explicitly excluded from restore and undo. */
function untrackedState(before: LargeFileState | undefined, after: FileState): LargeFileState & { changed: boolean } | undefined {
  if (after.metadata === undefined || after.metadata.size <= maxFileBytes) return undefined
  return { ...after.metadata, changed: before?.changed === true || metadataChanged(before, after.metadata) || before === undefined }
}

export interface RestoreFileChange {
  path: string
  kind: 'modify' | 'create' | 'delete' | 'unchanged'
  conflict: boolean
  binary: boolean
  current: Buffer | undefined
  target: Buffer | undefined
  currentHash: string | undefined
  currentMetadata?: FileMetadata
}

export interface RestorePlan {
  sessionId: string
  userSeq: number
  changes: RestoreFileChange[]
}
const hash = (content: Buffer): string => createHash('sha256').update(content).digest('hex')

export async function workspaceFiles(workspace: string, directory = ''): Promise<string[]> {
  const files: string[] = []
  for (const entry of await readdir(resolve(workspace, directory), { withFileTypes: true })) {
    const path = directory === '' ? entry.name : `${directory}/${entry.name}`
    if (['.git', 'node_modules', '.dsh-dev', '.vscode-agent-dev', '.venv'].includes(entry.name)) continue
    if (entry.isDirectory()) files.push(...await workspaceFiles(workspace, path))
    else if (entry.isFile() && !excluded(path)) files.push(path)
  }
  return files
}

/** Each file has one immutable snapshot; adding another path never rewrites the first. */
async function saveFiles(workspace: string, paths: readonly string[], file: string): Promise<void> {
  const files: SnapshotFile[] = []
  for (const path of paths) {
    const local = workspacePath(workspace, path)
    const target = resolve(workspace, local)
    const metadata = await stat(target).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return undefined
      throw error
    })
    if (metadata?.isDirectory() === true) throw new Error(`不能把目录 ${local} 作为文件纳入检查点。`)
    if (metadata !== undefined && !metadata.isFile()) throw new Error(`检查点不支持非普通文件：${local}。`)
    if (metadata !== undefined && excluded(local)) throw new Error(`为保护敏感文件，历史恢复不跟踪 ${local}。`)
    if (metadata !== undefined && metadata.size > 10 * 1024 * 1024) {
      // P2-1: Large files are tracked by metadata only; warn user to use Git for recovery
      console.warn(`[Coding Agent] 大文件 ${local} (${Math.round(metadata.size / 1024 / 1024)}MB) 只记录元数据，恢复时内容可能不完整。建议使用 Git 跟踪此文件。`)
      // Continue with metadata-only tracking
    }
    const content = metadata === undefined ? undefined : await readFile(target)
    const contentHash = content === undefined ? undefined : hash(content)
    files.push(content === undefined ? { path: local } : { path: local, content: content.toString('base64'), hash: contentHash })
  }
  await mkdir(resolve(file, '..'), { recursive: true, mode: 0o700 })
  for (const item of files) {
    if (item.content === undefined || item.hash === undefined) continue
    const blob = resolve(file, '..', 'blobs', `${item.hash}.json`)
    try {
      await mkdir(resolve(blob, '..'), { recursive: true, mode: 0o700 })
    await writeFile(blob, JSON.stringify({ content: item.content }), { mode: 0o600, flag: 'wx' })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }
    item.content = undefined
  }
  const temporary = `${file}.${randomUUID()}.tmp`
  await writeFile(temporary, JSON.stringify(files), { mode: 0o600 })
  await rename(temporary, file)
}

async function restoreFiles(workspace: string, file: string): Promise<void> {
  await restoreContents(workspace, await snapshotContents(file))
}

async function restoreContents(workspace: string, files: readonly SnapshotFile[]): Promise<void> {
  const canonicalWorkspace = await realpath(workspace)
  for (const item of files) {
    const local = workspacePath(canonicalWorkspace, item.path)
    const directory = dirname(resolve(canonicalWorkspace, local))
    await mkdir(directory, { recursive: true })
    const canonicalParent = await realpath(directory)
    if (canonicalParent !== canonicalWorkspace && !canonicalParent.startsWith(canonicalWorkspace + sep)) throw new Error('目标目录是外部符号链接，已拒绝恢复。')
  }
  for (const item of files) {
    const local = workspacePath(canonicalWorkspace, item.path)
    const target = resolve(canonicalWorkspace, local)
    const targetStat = await stat(target).catch(() => undefined)
    if (typeof item.content === 'string') {
      if (targetStat?.isDirectory() === true) throw new Error(`不能把目录 ${local} 恢复为文件。`)
      const temporary = `${target}.${randomUUID()}.checkpoint-tmp`
      await writeFile(temporary, Buffer.from(item.content, 'base64'), { mode: 0o600 })
      await rename(temporary, target)
    } else if (targetStat !== undefined) await rm(target, { recursive: true })
  }
}

async function snapshotContents(file: string): Promise<Array<SnapshotFile & { content?: string }>> {
  const records = JSON.parse(await readFile(file, 'utf8')) as SnapshotFile[]
  if (!Array.isArray(records)) throw new Error('检查点文件内容无效。')
  return Promise.all(records.map(async item => item.hash === undefined ? item : {
    ...item, content: (JSON.parse(await readFile(resolve(file, '..', 'blobs', `${item.hash}.json`), 'utf8')) as { content: string }).content,
  }))
}

async function snapshotMap(file: string): Promise<Map<string, Buffer | undefined>> {
  return new Map((await snapshotContents(file)).map(item => [item.path, item.content === undefined ? undefined : Buffer.from(item.content, 'base64')]))
}

/** File-scoped snapshots restore only Agent work, not unrelated later user edits. */
export class CheckpointStore {
  private state: State | undefined
  private pending = new Map<string, Checkpoint>()
  private queue = Promise.resolve()
  constructor(private readonly root: string) {}

  private exclusive<T>(task: () => Promise<T>): Promise<T> {
    const next = this.queue.then(task, task)
    this.queue = next.then(() => undefined, () => undefined)
    return next
  }

  private async read(): Promise<State> {
    this.state ??= await readFile(resolve(this.root, 'index.json'), 'utf8').then(text => {
      const parsed = JSON.parse(text) as State
      if (parsed.version !== 1 || !Array.isArray(parsed.checkpoints) || typeof parsed.undos !== 'object') throw new Error('检查点索引格式无效。')
      return parsed
    }, error => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return emptyState()
      throw error
    })
    return this.state
  }

  private async write(state: State): Promise<void> {
    await mkdir(this.root, { recursive: true, mode: 0o700 })
    const temporary = resolve(this.root, `index-${randomUUID()}.tmp`)
    await writeFile(temporary, JSON.stringify(state, null, 2), { mode: 0o600 })
    await rename(temporary, resolve(this.root, 'index.json'))
  }

  async before(sessionId: string, workspace: string, userSeq: number, prompt: string): Promise<Checkpoint> {
    return this.exclusive(async () => {
      const checkpoint: Checkpoint = { id: randomUUID(), sessionId, userSeq, prompt, files: [], createdAt: Date.now() }
      const files = await workspaceFiles(workspace)
      checkpoint.untrackedLargeFiles = {}
      const previous = (await this.read()).checkpoints.findLast(item => item.sessionId === sessionId)
      const previousLarge = previous?.untrackedLargeFiles ?? {}
      const restoredLarge = new Set(previous?.restoredLargeFiles ?? [])
      const tracked: string[] = []
      for (const path of files) {
        const current = await fileState(workspace, path, false)
        if (current.metadata !== undefined && current.metadata.size > maxFileBytes) checkpoint.untrackedLargeFiles[path] = { ...current.metadata, changed: previousLarge[path]?.changed === true && !restoredLarge.has(path) }
        else tracked.push(path)
      }
      await saveFiles(workspace, tracked, resolve(this.root, snapshotName(checkpoint.id)))
      checkpoint.workspaceFiles = tracked
      checkpoint.restoredLargeFiles = [...restoredLarge]
      const state = await this.read()
      state.checkpoints.push(checkpoint)
      this.pending.set(sessionId, checkpoint)
      await this.write(state)
      return checkpoint
    })
  }

  async track(sessionId: string, workspace: string, path: string): Promise<void> {
    return this.exclusive(async () => {
      const checkpoint = this.pending.get(sessionId)
      if (checkpoint === undefined) return
      const local = workspacePath(workspace, path)
      if (excluded(local)) throw new Error(`为保护敏感文件，历史恢复不跟踪 ${local}；本轮仍会继续，但该文件需用 Git 审查。`)
      const current = await fileState(workspace, local, false)
      if (current.metadata !== undefined && current.metadata.size > maxFileBytes) throw new Error(`文件 ${local} 超过 10 MiB，未保存其内容；请用 Git 审查，Checkpoint 不会自动恢复它。`)
      if (checkpoint.files.includes(local)) return
      // Immutable per-file snapshot; a later file must never overwrite this one's baseline.
      await saveFiles(workspace, [local], resolve(this.root, `${checkpoint.id}-${Buffer.from(local).toString('base64url')}.json`))
      checkpoint.files.push(local)
      await this.write(await this.read())
    })
  }

  /** The full turn-start snapshot already contains content; record Bash changes for review. */
  async trackWorkspaceChanges(sessionId: string, workspace: string): Promise<void> {
    return this.exclusive(async () => {
      const checkpoint = this.pending.get(sessionId)
      if (checkpoint === undefined || checkpoint.workspaceFiles === undefined) return
      const largeChanges: string[] = []
      for (const [path, before] of Object.entries(checkpoint.untrackedLargeFiles ?? {})) {
        const current = await fileState(workspace, path, false)
        if (metadataChanged(before, current.metadata)) {
          largeChanges.push(path)
          checkpoint.untrackedLargeFiles![path] = current.metadata === undefined ? { ...before, changed: true } : { ...current.metadata, changed: true }
        }
      }
      const baseline = JSON.parse(await readFile(resolve(this.root, snapshotName(checkpoint.id)), 'utf8')) as SnapshotFile[]
      const hashes = new Map(baseline.map(item => [item.path, item.hash]))
      const current = await workspaceFiles(workspace)
      for (const path of current) {
        if (checkpoint.files.includes(path) || Object.hasOwn(checkpoint.untrackedLargeFiles ?? {}, path)) continue
        const state = await fileState(workspace, path)
        const untracked = untrackedState(undefined, state)
        if (untracked !== undefined) {
          checkpoint.untrackedLargeFiles![path] = untracked
          if (state.content === undefined) largeChanges.push(path)
          continue
        }
        if (state.hash !== hashes.get(path)) checkpoint.files.push(path)
      }
      if (largeChanges.length > 0) throw new Error(`以下大文件未纳入 Checkpoint，需手动审查：${largeChanges.join('、')}。其他文件的恢复仍可正常使用。`)
      for (const path of checkpoint.workspaceFiles) if (!current.includes(path) && !checkpoint.files.includes(path)) checkpoint.files.push(path)
      await this.write(await this.read())
    })
  }

  async rebind(sessionId: string, previous: number, next: number): Promise<void> {
    return this.exclusive(async () => {
      const checkpoint = this.pending.get(sessionId)
      if (checkpoint === undefined || checkpoint.userSeq !== previous) return
      checkpoint.userSeq = next
      await this.write(await this.read())
    })
  }

  after(sessionId: string, turn: number | undefined): Promise<void> {
    return this.exclusive(async () => {
      const checkpoint = this.pending.get(sessionId)
      if (checkpoint === undefined) return
      this.pending.delete(sessionId)
      checkpoint.turn = turn
      await this.write(await this.read())
    })
  }

  /** Capture the exact end-of-turn baseline used to detect later manual edits. */
  async finish(sessionId: string, workspace: string): Promise<void> {
    return this.exclusive(async () => {
      const checkpoint = this.pending.get(sessionId)
      if (checkpoint === undefined) return
      const current = await workspaceFiles(workspace)
      const files: Record<string, string | undefined> = {}
      const largeFiles: Record<string, FileMetadata | undefined> = {}
      const tracked = new Set([...current.filter(path => !Object.hasOwn(checkpoint.untrackedLargeFiles ?? {}, path)), ...checkpoint.workspaceFiles ?? [], ...checkpoint.files])
      for (const path of tracked) {
        const currentState = await fileState(workspace, path)
        const untracked = untrackedState(checkpoint.untrackedLargeFiles?.[path], currentState)
        if (untracked !== undefined) {
          checkpoint.untrackedLargeFiles![path] = untracked
          largeFiles[path] = currentState.metadata
          continue
        }
        files[path] = currentState.hash
      }
      for (const path of Object.keys(checkpoint.untrackedLargeFiles ?? {})) if (!tracked.has(path)) {
        const currentState = await fileState(workspace, path, false)
        largeFiles[path] = currentState.metadata
      }
      const state = await this.read()
      state.turnEnds = (state.turnEnds ?? []).filter(item => !(item.sessionId === sessionId && item.userSeq === checkpoint.userSeq))
      state.turnEnds.push({ sessionId, userSeq: checkpoint.userSeq, files, largeFiles })
      await this.write(state)
    })
  }

  /** Rebind inherited checkpoints to the fork without copying their immutable files. */
  async rebindSession(sourceId: string, childId: string, beforeSeq: number): Promise<void> {
    return this.exclusive(async () => {
      const state = await this.read()
      const existing = new Set(state.checkpoints.filter(item => item.sessionId === childId).map(item => item.userSeq))
      for (const checkpoint of state.checkpoints.filter(item => item.sessionId === sourceId && item.userSeq < beforeSeq)) {
        if (existing.has(checkpoint.userSeq)) continue
        state.checkpoints.push({ ...checkpoint, sessionId: childId, files: [...checkpoint.files], workspaceFiles: checkpoint.workspaceFiles === undefined ? undefined : [...checkpoint.workspaceFiles], untrackedLargeFiles: checkpoint.untrackedLargeFiles === undefined ? undefined : structuredClone(checkpoint.untrackedLargeFiles) })
      }
      await this.write(state)
    })
  }

  async baseline(sessionId: string, userSeq: number, path: string, workspace?: string): Promise<Buffer | undefined> {
    return this.exclusive(async () => {
      const checkpoint = (await this.read()).checkpoints.find(item => item.sessionId === sessionId && item.userSeq === userSeq)
      if (checkpoint === undefined) return undefined
      const local = workspacePath(workspace ?? '', path)
      if (checkpoint.workspaceFiles !== undefined) {
        const snapshot = await snapshotMap(resolve(this.root, snapshotName(checkpoint.id)))
        return snapshot.get(local)
      }
      const snapshot = await snapshotMap(resolve(this.root, `${checkpoint.id}-${Buffer.from(local).toString('base64url')}.json`))
      return snapshot.get(local)
    })
  }

  async list(sessionId: string): Promise<Checkpoint[]> {
    return this.exclusive(async () => (await this.read()).checkpoints.filter(item => item.sessionId === sessionId))
  }

  async backupForUndo(sessionId: string, workspace: string, files: readonly string[], includeInventory = true): Promise<void> {
    return this.exclusive(async () => {
      const checkpoint: Checkpoint = { id: randomUUID(), sessionId, userSeq: -1, prompt: '恢复前备份', files: [], untrackedLargeFiles: {}, createdAt: Date.now() }
      const inventory = includeInventory ? await workspaceFiles(workspace) : [...files]
      checkpoint.workspaceFiles = []
      for (const path of inventory) {
        const current = await fileState(workspace, path, false)
        if (current.metadata !== undefined && current.metadata.size > maxFileBytes) checkpoint.untrackedLargeFiles![path] = { ...current.metadata, changed: false }
        else checkpoint.workspaceFiles.push(path)
      }
      const tracked = files.filter(path => !Object.hasOwn(checkpoint.untrackedLargeFiles ?? {}, path))
      if (tracked.length > 0) await saveFiles(workspace, tracked, resolve(this.root, snapshotName(checkpoint.id)))
      checkpoint.files = [...tracked]
      const state = await this.read()
      state.undos[sessionId] = checkpoint
      await this.write(state)
    })
  }

  restore(workspace: string, checkpointId: string): Promise<void> {
    return this.exclusive(async () => {
      const checkpoint = (await this.read()).checkpoints.find(item => item.id === checkpointId)
      if (checkpoint === undefined) throw new Error('该历史消息没有代码检查点；只有新发送的消息会创建检查点。')
      await this.restoreMany(workspace, [checkpoint])
    })
  }

  /** Preview exactly what restoreFrom will write; no files are changed here. */
  async previewRestore(workspace: string, sessionId: string, userSeq: number): Promise<RestorePlan> {
    return this.exclusive(() => this.previewRestoreUnlocked(workspace, sessionId, userSeq))
  }

  private async previewRestoreUnlocked(workspace: string, sessionId: string, userSeq: number): Promise<RestorePlan> {
    {
      const checkpoints = (await this.read()).checkpoints
        .filter(item => item.sessionId === sessionId && item.userSeq >= userSeq)
        .sort((left, right) => right.userSeq - left.userSeq)
      if (checkpoints.length === 0 || checkpoints[checkpoints.length - 1].userSeq !== userSeq) {
        throw new Error('该历史消息没有代码检查点，无法恢复当时代码。')
      }
      const initial = checkpoints[checkpoints.length - 1]
      const targets = new Map<string, Buffer | undefined>()
      const baselines = new Map<string, Buffer | undefined>()
      if (initial.workspaceFiles !== undefined) {
        const initialContents = await snapshotMap(resolve(this.root, snapshotName(initial.id)))
        const largeFiles = new Set(checkpoints.flatMap(item => Object.keys(item.untrackedLargeFiles ?? {})))
        const touched = new Set(checkpoints.flatMap(item => item.files))
        for (const path of initial.workspaceFiles) if (touched.has(path)) targets.set(path, initialContents.get(path))
        for (const path of touched) if (!targets.has(path)) targets.set(path, undefined)
        for (const path of largeFiles) if (!targets.has(path)) targets.set(path, undefined)
        // The last turn's baseline distinguishes Agent edits from subsequent manual edits.
        const latest = checkpoints.find(item => item.workspaceFiles !== undefined)
        const latestContents = latest?.workspaceFiles === undefined ? new Map<string, Buffer | undefined>() : await snapshotMap(resolve(this.root, snapshotName(latest.id)))
        for (const path of targets.keys()) baselines.set(path, latestContents.get(path))
      } else {
        const restored = new Set<string>()
        for (const checkpoint of checkpoints) for (const path of checkpoint.files) {
          if (restored.has(path)) continue
          const snapshots = await snapshotMap(resolve(this.root, `${checkpoint.id}-${Buffer.from(path).toString('base64url')}.json`))
          targets.set(path, snapshots.get(path))
          baselines.set(path, targets.get(path))
          restored.add(path)
        }
      }
      const turnEnds = (await this.read()).turnEnds ?? []
      const changes: RestoreFileChange[] = []
      const protectedLarge = new Set(checkpoints.flatMap(item => Object.entries(item.untrackedLargeFiles ?? {}).filter(([, metadata]) => metadata.changed === true).map(([path]) => path)))
      for (const [path, target] of targets) {
        const state = await fileState(workspace, path)
        const current = state.content
        const binary = [current, target].some(content => content?.includes(0) === true)
        const kind = state.metadata === undefined ? 'create' : target === undefined ? 'delete'
          : current?.equals(target) === true ? 'unchanged' : 'modify'
        const baseline = baselines.get(path)
        const end = turnEnds.findLast(end => end.sessionId === sessionId && end.userSeq >= userSeq && (Object.hasOwn(end.files, path) || Object.hasOwn(end.largeFiles ?? {}, path)))
        const expected = end?.files[path]
        const large = state.metadata !== undefined && state.metadata.size > maxFileBytes
        const manuallyEdited = protectedLarge.has(path) || (end !== undefined && (large
          ? metadataChanged(end.largeFiles?.[path], state.metadata)
          : (state.hash ?? null) !== (expected ?? null)))
          || (end === undefined && kind !== 'unchanged' && (current === undefined ? baseline !== undefined || large : baseline === undefined || !current.equals(baseline)))
        changes.push({ path, kind, conflict: manuallyEdited, binary, current, target, currentHash: state.hash, currentMetadata: state.metadata })
      }
      return { sessionId, userSeq, changes: changes.sort((left, right) => left.path.localeCompare(right.path)) }
    }
  }

  async validateRestore(workspace: string, plan: RestorePlan): Promise<void> {
    return this.exclusive(async () => {
      await this.validateRestoreUnlocked(workspace, plan)
    })
  }

  private async validateRestoreUnlocked(workspace: string, plan: RestorePlan): Promise<void> {
    const unexpected: string[] = []
    for (const change of plan.changes.filter(change => change.kind === 'modify' || change.kind === 'delete')) {
      const current = await fileState(workspace, change.path)
      if (current.hash !== change.currentHash || current.content?.length !== change.current?.byteLength
        || change.currentMetadata !== undefined && metadataChanged(change.currentMetadata, current.metadata)) unexpected.push(change.path)
    }
    if (unexpected.length > 0) throw new Error(`以下文件在预览后发生变化：${unexpected.join('、')}。已取消恢复，请重新预览。`)
  }

  /** Undo every Agent turn from the selected prompt onward, in reverse order. */
  async restoreFrom(workspace: string, sessionId: string, userSeq: number, expectedHashes?: ReadonlyMap<string, string | undefined>, plan?: RestorePlan): Promise<string[]> {
    return this.exclusive(async () => {
      const checkpoints = (await this.read()).checkpoints
        .filter(item => item.sessionId === sessionId && item.userSeq >= userSeq)
        .sort((left, right) => right.userSeq - left.userSeq)
      if (checkpoints.length === 0 || checkpoints[checkpoints.length - 1].userSeq !== userSeq) {
        throw new Error('该历史消息没有代码检查点，无法恢复当时代码。')
      }
      const initial = checkpoints[checkpoints.length - 1]
      if (expectedHashes !== undefined) {
        if (plan !== undefined) await this.validateRestoreUnlocked(workspace, plan)
        else {
          const unexpected: string[] = []
          for (const [path, expected] of expectedHashes) {
            const current = await fileState(workspace, path)
            if (current.hash !== expected) unexpected.push(path)
          }
          if (unexpected.length > 0) throw new Error(`以下文件在预览后发生变化：${unexpected.join('、')}。已取消恢复，请重新预览。`)
        }
      }
      if (initial.workspaceFiles !== undefined) {
        const touched = new Set(checkpoints.flatMap(item => item.files))
        const initialFiles = await snapshotContents(resolve(this.root, snapshotName(initial.id)))
        const selected = new Map(initialFiles.filter(item => touched.has(item.path)).map(item => [item.path, item.content]))
        const restore: SnapshotFile[] = []
        const restored: string[] = []
        for (const path of touched) {
          const current = await fileState(workspace, path)
          if (current.content === undefined && current.metadata !== undefined) continue
          const original = selected.get(path)
          if (current.content?.equals(Buffer.from(original ?? '', 'base64')) || current.content === undefined && original === undefined) continue
          restore.push({ path, content: original })
        }
        // Large files have no saved content and remain untouched; small files keep atomic restore semantics.
        await restoreContents(workspace, restore)
        const state = await this.read()
        for (const checkpoint of state.checkpoints.filter(item => item.sessionId === sessionId && item.userSeq >= userSeq)) {
          for (const [path, metadata] of Object.entries(checkpoint.untrackedLargeFiles ?? {})) {
            const current = await fileState(workspace, path, false)
            if (current.metadata !== undefined) checkpoint.untrackedLargeFiles![path] = { ...current.metadata, changed: false }
            else checkpoint.untrackedLargeFiles![path] = { ...metadata, changed: false }
          }
        }
        state.turnEnds = state.turnEnds?.filter(item => !(item.sessionId === sessionId && item.userSeq >= userSeq))
        const restoredEnd = state.turnEnds?.find(item => item.sessionId === sessionId && item.userSeq < userSeq)
        for (const [path, metadata] of Object.entries(initial.untrackedLargeFiles ?? {})) {
          const current = await fileState(workspace, path, false)
          if (restoredEnd !== undefined) restoredEnd.largeFiles = { ...restoredEnd.largeFiles, [path]: current.metadata }
          if (metadata.changed === true && current.metadata !== undefined) restored.push(path)
        }
        await this.write(state)
      } else {
        // Legacy per-file checkpoints also include later turns, not just the selected one.
        await this.restoreMany(workspace, checkpoints)
      }
      return [...new Set(checkpoints.flatMap(item => item.files))]
    })
  }

  private async restoreMany(workspace: string, checkpoints: readonly Checkpoint[]): Promise<void> {
    // The oldest baseline wins when several turns changed the same file.
    const restored = new Set<string>()
    for (const checkpoint of checkpoints) {
      const remaining = checkpoint.files.filter(path => !restored.has(path))
      if (remaining.length === 0) continue
      const original = { ...checkpoint, files: remaining }
      const file = resolve(this.root, `${original.id}.json`)
      const files = remaining.map(path => `${original.id}-${Buffer.from(path).toString('base64url')}.json`)
      // Read the immutable per-file snapshots as one restore batch.
      const snapshots = await Promise.all(files.map(async path => (JSON.parse(await readFile(resolve(this.root, path), 'utf8')) as SnapshotFile[])))
      const temporary = `${file}.${randomUUID()}.tmp`
      await writeFile(temporary, JSON.stringify(snapshots.flat()), { mode: 0o600 })
      try { await restoreFiles(workspace, temporary) } finally { await rm(temporary, { force: true }) }
      remaining.forEach(path => restored.add(path))
    }
  }

  /** Remove this Session's records; snapshots still referenced by a fork or undo survive. */
  async deleteSession(sessionId: string): Promise<void> {
    return this.exclusive(async () => {
      const state = await this.read()
      const retained = state.checkpoints.filter(item => item.sessionId !== sessionId)
      const undo = state.undos[sessionId]
      const owned = [...state.checkpoints.filter(item => item.sessionId === sessionId), ...undo === undefined ? [] : [undo]]
      const sharedIds = new Set([...retained, ...Object.entries(state.undos).filter(([id]) => id !== sessionId).map(([, item]) => item)].map(item => item.id))
      const removable = owned.filter(item => !sharedIds.has(item.id))
      const blobHashes = new Set<string>()
      const collectHashes = async (file: string, hashes: Set<string>): Promise<void> => {
        const records = JSON.parse(await readFile(file, 'utf8').catch((error: NodeJS.ErrnoException) => {
          if (error.code === 'ENOENT') return '[]'
          throw error
        })) as SnapshotFile[]
        if (!Array.isArray(records)) throw new Error('检查点文件内容无效。')
        for (const item of records) if (item.hash !== undefined) hashes.add(item.hash)
      }
      const removedHashes = new Set<string>()
      for (const checkpoint of removable) {
        const snapshot = resolve(this.root, snapshotName(checkpoint.id))
        await collectHashes(snapshot, removedHashes)
        for (const path of checkpoint.files) await collectHashes(resolve(this.root, `${checkpoint.id}-${Buffer.from(path).toString('base64url')}.json`), removedHashes)
      }
      for (const checkpoint of [...retained, ...Object.entries(state.undos).filter(([id]) => id !== sessionId).map(([, item]) => item)]) {
        await collectHashes(resolve(this.root, snapshotName(checkpoint.id)), blobHashes)
        for (const path of checkpoint.files) await collectHashes(resolve(this.root, `${checkpoint.id}-${Buffer.from(path).toString('base64url')}.json`), blobHashes)
      }
      for (const checkpoint of removable) {
        await rm(resolve(this.root, snapshotName(checkpoint.id)), { force: true })
        await Promise.all(checkpoint.files.map(path => rm(resolve(this.root, `${checkpoint.id}-${Buffer.from(path).toString('base64url')}.json`), { force: true })))
      }
      await Promise.all([...removedHashes].filter(hash => !blobHashes.has(hash)).map(hash => rm(resolve(this.root, 'blobs', `${hash}.json`), { force: true })))
      state.checkpoints = retained
      state.turnEnds = state.turnEnds?.filter(item => item.sessionId !== sessionId)
      delete state.undos[sessionId]
      this.pending.delete(sessionId)
      await this.write(state)
    })
  }

  async undo(workspace: string, sessionId: string): Promise<boolean> {
    return this.exclusive(async () => {
      const state = await this.read()
      const undo = state.undos[sessionId]
      if (undo === undefined) return false
      if (undo.files.length > 0) await restoreFiles(workspace, resolve(this.root, snapshotName(undo.id)))
      if (undo.workspaceFiles !== undefined) {
        const current = await workspaceFiles(workspace)
        for (const path of current) {
          if (undo.workspaceFiles.includes(path) || Object.hasOwn(undo.untrackedLargeFiles ?? {}, path)) continue
          const state = await fileState(workspace, path, false)
          if (state.metadata !== undefined && state.metadata.size > maxFileBytes) continue
          await rm(resolve(workspace, workspacePath(workspace, path)), { force: true })
        }
      }
      delete state.undos[sessionId]
      await this.write(state)
      return true
    })
  }
}

export type RestoreDecision = 'restore' | 'keep' | 'cancel'

/** A single confirmation covers the complete code and conversation rollback. */
export async function confirmRestore(prompt: string, _context: { dirtyEditors: number }, hasCheckpoint: boolean): Promise<RestoreDecision> {
  const action = hasCheckpoint ? '恢复并重新发送' : '回滚对话并重新发送'
  const detail = hasCheckpoint
    ? [`将尝试恢复该消息发送前的代码快照，并回滚当前会话中该消息之后的对话。`,
      _context.dirtyEditors > 0 ? `将先保存 ${_context.dirtyEditors} 个包含未保存修改的编辑器。` : '',
      '正在后台分析具体文件变化；与所选轮次无关的新文件不会删除；当前代码先保存为可撤销快照。'].filter(Boolean).join('\n')
    : '这条旧消息没有代码检查点，因此当前代码保持不变；当前会话中该消息之后的对话将被移除。'
  const choice = await vscode.window.showWarningMessage(
    `从这条历史消息重新发送？\n${prompt.slice(0, 120)}`,
    { modal: true, detail }, action,
  )
  return choice === action ? hasCheckpoint ? 'restore' : 'keep' : 'cancel'
}
