/** An in-memory read projection; DSH's durable log and projection cache remain authoritative. */
export interface SessionTitleOverrides {
  get(id: string): string | undefined
  set(id: string, title: string | undefined): Promise<void>
}

export class SessionCatalog {
  private sessions = new Map<string, { id: string, title: string, cwd: string, createdAt: number, updatedAt: number }>()
  private pending: Promise<{ sessions: Array<{ id: string, title: string, cwd: string, createdAt: number, updatedAt: number }> }> | undefined
  private excluded: (id: string) => boolean = () => false
  /** User-supplied display titles, layered above DSH's deterministic first-prompt fallback. */
  private overrides: SessionTitleOverrides | undefined

  constructor(private readonly authoritative: () => Promise<{ sessions: Array<{ id: string, title: string, cwd: string, createdAt: number, updatedAt: number }> }>) {}

  /** Filter at response commit, so a stale in-flight read cannot resurrect a deletion. */
  exclude(excluded: (id: string) => boolean): void { this.excluded = excluded }

  /** Layer rename overrides above the authoritative DSH titles; never mutates the on-disk JSONL. */
  titleOverrides(overrides: SessionTitleOverrides): void { this.overrides = overrides }

  update(history: { session: { id: string, title: string, cwd: string, createdAt: number, updatedAt: number } }): void {
    this.upsert(history.session)
  }

  /** Keep an already-loaded local row fresher than a stale Host snapshot. */
  upsert(session: { id: string, title: string, cwd: string, createdAt: number, updatedAt: number }): void {
    const current = this.sessions.get(session.id)
    if (current === undefined || session.updatedAt >= current.updatedAt)
      this.sessions.set(session.id, session)
  }

  invalidate(id?: string): void {
    if (id === undefined) this.sessions.clear()
    else this.sessions.delete(id)
    this.pending = undefined
  }

  /** Apply one rename: persist the override and refresh the local row immediately. */
  async rename(id: string, title: string): Promise<void> {
    const trimmed = title.trim()
    if (trimmed.length === 0) throw new Error('会话名称不能为空。')
    if (trimmed.length > 200) throw new Error('会话名称过长（最多 200 字符）。')
    await this.overrides?.set(id, trimmed)
    const current = this.sessions.get(id)
    if (current !== undefined) this.sessions.set(id, { ...current, title: trimmed })
    this.pending = undefined
  }

  /** Remove one rename override, restoring the DSH-derived title. */
  async clearRename(id: string): Promise<void> {
    await this.overrides?.set(id, undefined)
    this.pending = undefined
  }

  private applyOverrides(session: { id: string, title: string, cwd: string, createdAt: number, updatedAt: number }): { id: string, title: string, cwd: string, createdAt: number, updatedAt: number } {
    const override = this.overrides?.get(session.id)
    if (override === undefined || override.length === 0) return session
    return { ...session, title: override }
  }

  async list(): Promise<{ sessions: Array<{ id: string, title: string, cwd: string, createdAt: number, updatedAt: number }> }> {
    // The Host's header index and projection cache avoid replaying every JSONL log.
    this.pending ??= this.authoritative().then(result => {
      const received = new Set(result.sessions.map(session => session.id))
      for (const id of this.sessions.keys()) if (!received.has(id)) this.sessions.delete(id)
      for (const session of result.sessions) this.upsert(session)
      for (const id of this.sessions.keys()) if (this.excluded(id)) this.sessions.delete(id)
      return {
        sessions: [...this.sessions.values()]
          .map(session => this.applyOverrides(session))
          .sort((left, right) => right.updatedAt - left.updatedAt || left.id.localeCompare(right.id)),
      }
    }).catch(error => { this.pending = undefined; throw error })
    return this.pending
  }
}
