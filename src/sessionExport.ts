import type { SessionHistoryResult } from '@deepseek-ai/dsh-sdk-client'

type EventLike = {
  type: string
  seq?: number
  time?: number
  data?: Record<string, unknown>
}

interface ContentBlock { type?: string, text?: string, thinking?: string }

function messageText(content: readonly ContentBlock[] | undefined): string {
  if (!Array.isArray(content)) return ''
  return content
    .filter(block => block.type === 'text' && typeof block.text === 'string')
    .map(block => block.text as string)
    .join('\n')
}

function reasoningText(content: readonly ContentBlock[] | undefined): string {
  if (!Array.isArray(content)) return ''
  return content
    .filter(block => block.type === 'reasoning' || block.type === 'thinking')
    .map(block => String(block.text ?? block.thinking ?? ''))
    .filter(text => text.length > 0)
    .join('\n\n')
}

function fmtTime(time: number | undefined): string {
  if (typeof time !== 'number') return ''
  const date = new Date(time)
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

function escapeFence(text: string): string {
  // Avoid breaking out of a code fence if the model emitted one.
  return text.replaceAll('```', '``\\`')
}

/**
 * Render one session as a Markdown transcript: user/assistant dialogue with
 * optional reasoning chains, plus a short tool-call summary inline.
 * Tool outputs are truncated for readability; the full JSONL log on disk
 * remains the source of truth for audits.
 */
export function sessionToMarkdown(history: SessionHistoryResult, overrideTitle?: string): string {
  const title = (overrideTitle && overrideTitle.trim().length > 0 ? overrideTitle : history.session.title) || '未命名会话'
  const lines: string[] = []
  lines.push(`# ${title}`)
  lines.push('')
  lines.push(`- 会话 ID：\`${history.session.id}\``)
  lines.push(`- 工作区：\`${history.session.cwd}\``)
  lines.push(`- 创建时间：${fmtTime(history.session.createdAt)}`)
  lines.push(`- 更新时间：${fmtTime(history.session.updatedAt)}`)
  lines.push('')
  lines.push('---')
  lines.push('')

  let pendingReasoning: string[] = []
  const flushReasoning = (): void => {
    if (pendingReasoning.length === 0) return
    lines.push('<details><summary>思考过程</summary>')
    lines.push('')
    lines.push('```')
    lines.push(escapeFence(pendingReasoning.join('\n\n')))
    lines.push('```')
    lines.push('')
    lines.push('</details>')
    lines.push('')
    pendingReasoning = []
  }

  for (const rawEvent of history.events as readonly EventLike[]) {
    const data = rawEvent.data
    if (rawEvent.type === 'user/message') {
      const source = data?.source as { kind?: unknown } | undefined
      if (source?.kind !== 'user') continue
      flushReasoning()
      const text = messageText(data?.content as ContentBlock[] | undefined)
      if (text.trim().length === 0) continue
      lines.push('## 👤 用户')
      lines.push('')
      lines.push(text)
      lines.push('')
      continue
    }
    if (rawEvent.type === 'assistant/attempt' || rawEvent.type === 'assistant/message') {
      const message = data?.message as { content?: ContentBlock[] } | undefined
      const reasoning = reasoningText(message?.content)
      const text = messageText(message?.content)
      // attempts may stream empty assistant messages; emit only what exists.
      if (reasoning) pendingReasoning.push(reasoning)
      if (text.trim().length > 0) {
        flushReasoning()
        lines.push('## 🤖 助手')
        lines.push('')
        lines.push(text)
        lines.push('')
      }
      continue
    }
    if (rawEvent.type === 'tool/call') {
      flushReasoning()
      const name = typeof data?.name === 'string' ? data.name : 'tool'
      const args = data?.arguments === undefined ? '' : JSON.stringify(data.arguments, null, 2)
      lines.push(`> 🔧 **${name}**`)
      if (args.length > 0) {
        lines.push('>')
        const preview = args.length > 800 ? `${args.slice(0, 800)}\n… (truncated)` : args
        for (const line of preview.split('\n')) lines.push(`> ${line}`)
      }
      lines.push('')
      continue
    }
    if (rawEvent.type === 'tool/result') {
      const text = typeof data?.result === 'string' ? data.result : typeof data?.text === 'string' ? data.text : ''
      if (text.trim().length === 0) continue
      const preview = text.length > 800 ? `${text.slice(0, 800)}\n… (truncated)` : text
      lines.push('> ↩ **结果**')
      lines.push('>')
      for (const line of preview.split('\n')) lines.push(`> ${line}`)
      lines.push('')
      continue
    }
  }
  flushReasoning()
  return lines.join('\n')
}

/** File-system safe filename stem for an exported session Markdown. */
export function sessionExportFilename(title: string, sessionId: string): string {
  const stem = title
    .replace(/[\\/:*?"<>|\r\n\t]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 60)
  const short = sessionId.replace(/[^A-Za-z0-9-]/g, '').slice(0, 12)
  const base = stem.length > 0 ? stem : 'session'
  return `${base}-${short}.md`
}
