import * as vscode from 'vscode'

export type ApprovalOutcome = 'allowed-once' | 'rejected' | 'cancelled'

/** Session-scoped tool allowlist: memory-only, cleared when the session ends. */
export class ApprovalMemory {
  private readonly allowedTools = new Set<string>()

  /** Check if a tool was previously allowed for this session. */
  isAllowed(tool: string): boolean {
    return this.allowedTools.has(tool)
  }

  /** Mark a tool as allowed for the rest of this session. */
  allow(tool: string): void {
    this.allowedTools.add(tool)
  }

  /** Clear all remembered tools (e.g. on session reset or explicit user action). */
  clear(): void {
    this.allowedTools.clear()
  }

  /** Number of currently remembered tools. */
  get size(): number {
    return this.allowedTools.size
  }

  /** List of currently remembered tool names. */
  get tools(): string[] {
    return [...this.allowedTools]
  }
}

/** VS Code's modal is the default UI; the fixture can observe the exact wire outcome. */
export async function requestApproval(
  params: Record<string, unknown>,
  ask: (tool: string, reason?: string) => Thenable<ApprovalOutcome> = vscodeApproval,
): Promise<{ outcome: ApprovalOutcome }> {
  const tool = typeof params.toolName === 'string' ? params.toolName : '未知工具'
  const reason = typeof params.reason === 'string' ? params.reason : undefined
  return { outcome: await ask(tool, reason) }
}

async function vscodeApproval(tool: string, reason?: string): Promise<ApprovalOutcome> {
  const decision = await vscode.window.showWarningMessage(
    `Agent 请求单次执行工具：${tool}`,
    { modal: true, detail: `${reason ?? '此操作需要提升权限。'}\n\n决定只适用于本次调用。` },
    '允许一次',
    '拒绝',
    '取消',
  )
  if (decision === '允许一次') return 'allowed-once'
  if (decision === '拒绝') return 'rejected'
  return 'cancelled'
}

/** Risk confirmation for switching to full-access mode. */
export async function confirmFullAccess(): Promise<boolean> {
  const acknowledged = await vscode.window.showWarningMessage(
    '启用「完全访问」？',
    {
      modal: true,
      detail: 'Agent 将可以读写工作区外的任意文件、执行任意终端命令，且全程不再弹出审批。\n\n误操作或恶意提示词可能导致数据丢失或泄露。建议仅在可信任务中临时开启。',
    },
    { title: '我已了解风险', isCloseAffordance: false },
    { title: '取消', isCloseAffordance: true },
  )
  return acknowledged?.title === '我已了解风险'
}
