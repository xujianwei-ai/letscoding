import { randomUUID } from 'node:crypto'

export interface QuestionOption { label: string; description?: string }
export interface Question {
  id: string
  question: string
  header?: string
  detail?: string
  options?: QuestionOption[]
  multiSelect?: boolean
}
export interface QuestionAnswer { id: string; selected: string[]; custom?: string }
export type QuestionResult = { answers: QuestionAnswer[] } | { cancelled: true }
type Notify = (message: Record<string, unknown>) => void
type Pending = { questions: Question[]; resolve: (answer: QuestionResult) => void }

/** Route structured DSH questions to the existing chat view, including custom text. */
export class QuestionBroker {
  private pending: { id: string; request: Pending } | undefined
  constructor(private readonly notify: Notify) {}

  ask(request: { requestId?: string; questions: Question[] }): Promise<QuestionResult> {
    if (this.pending !== undefined) return Promise.resolve({ cancelled: true })
    const id = request.requestId ?? randomUUID()
    return new Promise<QuestionResult>(resolve => {
      this.pending = { id, request: { questions: request.questions, resolve } }
      this.notify({ type: 'questions', id, questions: request.questions })
    })
  }

  answer(id: unknown, answers: unknown): boolean {
    if (typeof id !== 'string' || !Array.isArray(answers) || this.pending?.id !== id) return false
    if (!this.validate(this.pending.request.questions, answers)) return false
    this.pending.request.resolve({ answers: answers as QuestionAnswer[] })
    this.pending = undefined
    return true
  }

  cancel(id?: unknown): void {
    if (id !== undefined && this.pending?.id !== id) return
    this.pending?.request.resolve({ cancelled: true })
    this.pending = undefined
  }

  private validate(questions: Question[], answers: unknown[]): boolean {
    if (answers.length !== questions.length) return false
    return questions.every(question => answers.some(value => {
      if (value === null || typeof value !== 'object') return false
      const answer = value as Record<string, unknown>
      if (answer.id !== question.id || !Array.isArray(answer.selected)) return false
      if (!answer.selected.every(label => typeof label === 'string' && question.options?.some(option => option.label === label))) return false
      if (!question.multiSelect && answer.selected.length > 1) return false
      if (answer.selected.length === 0 && typeof answer.custom !== 'string') return false
      return answer.custom === undefined || typeof answer.custom === 'string'
    }))
  }
}
