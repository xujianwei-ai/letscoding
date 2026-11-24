import { basename, isAbsolute, relative, resolve } from 'node:path'
import { testSummary } from './diagnostics.js'
import type { TestFailure, TestSummary } from './diagnostics.js'

export interface VerificationLocation { path: string, uri: string, line: number }
export interface VerificationFailure extends TestFailure {
  id: string
  location?: VerificationLocation
  resolved: boolean
}

interface TestRun { command: string, summary: TestSummary, failures: VerificationFailure[] }

/** Track one turn's evidence; do not replay it as new tool activity. */
export class VerificationTracker {
  private failures = new Map<string, VerificationFailure>()
  private runs: TestRun[] = []
  private commands: string[] = []

  begin(): void { this.failures.clear(); this.runs = []; this.commands = [] }

  record(workspace: string, command: string, output: string, error: boolean): TestSummary | undefined {
    const summary = testSummary(command, output, error)
    if (summary === undefined) return undefined
    const failures = summary.failures.map(failure => {
      const method = failure.name.match(/^\w+/)?.[0]
      const qualified = failure.name.match(/\(([^)]+)\)/)?.[1]?.split('.').slice(-2).join('.')
      const id = `${failure.path ?? ''}:${qualified ?? method ?? failure.name}`
      const previous = this.failures.get(id)
      const current = { ...failure, id, resolved: false, location: this.location(workspace, failure) }
      this.failures.set(id, current)
      return previous === undefined ? current : { ...previous, ...current }
    })
    if (summary.status === 'passed') {
      // Only clear failures covered by this exact command or its targeted rerun.
      const covered = new Set(this.runs
        .filter(run => run.command === command || run.summary.rerunCommand === command)
        .flatMap(run => run.failures.map(failure => failure.id)))
      for (const failure of this.failures.values()) if (covered.has(failure.id)) failure.resolved = true
    }
    this.commands.push(command)
    this.runs.push({ command, summary, failures })
    return summary
  }

  report(changedPaths: readonly string[]): {
    status: TestSummary['status']
    files: Array<{ path: string, uri: string }>
    failures: VerificationFailure[]
    runs: Array<{ label: string, status: TestSummary['status'], details?: string, exitCode?: number, rerunCommand?: string }>
  } {
    const workspace = this.workspace
    return {
      status: this.runs.length === 0 ? 'unknown' : [...this.failures.values()].some(failure => !failure.resolved) ? 'failed' : this.runs.at(-1)!.summary.status === 'passed' ? 'passed' : 'unknown',
      files: changedPaths
        .map(path => ({ path: relative(workspace, path), uri: `file://${path}` }))
        .filter(file => file.path !== '..' && !file.path.startsWith('../') && !isAbsolute(file.path)),
      failures: [...this.failures.values()],
      runs: this.runs.map(run => ({ label: run.summary.label, status: run.summary.status, ...(run.summary.details === undefined ? {} : { details: run.summary.details }), ...(run.summary.exitCode === undefined ? {} : { exitCode: run.summary.exitCode }), ...(run.summary.rerunCommand === undefined ? {} : { rerunCommand: run.summary.rerunCommand }) })),
    }
  }

  constructor(private workspace: string) {}
  setWorkspace(workspace: string): void { this.workspace = workspace }
  clear(): void { this.begin(); this.workspace = '' }

  rerunCommand(): string | undefined {
    const latest = this.runs.at(-1)?.summary
    if (latest?.status !== 'failed') return undefined
    return latest.rerunCommand
  }

  private location(workspace: string, failure: TestFailure): VerificationLocation | undefined {
    if (failure.path === undefined) return undefined
    const absolute = isAbsolute(failure.path) ? failure.path : resolve(workspace, failure.path)
    const path = relative(workspace, absolute)
    if (path === '..' || path.startsWith('../') || isAbsolute(path)) return undefined
    return { path, uri: `file://${absolute}`, line: failure.line ?? 1 }
  }
}

export function failureLabel(failure: VerificationFailure): string {
  return `${failure.location?.path ?? failure.path ?? basename(failure.name)}${failure.location === undefined ? '' : `:${failure.location.line}`}`
}
