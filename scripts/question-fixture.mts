import { resolve } from 'node:path'
import { createHarness } from '../src/runtime.js'

const harness = createHarness({
  dshHome: resolve(import.meta.dirname, '../../.dsh-dev'),
  cwd: resolve(import.meta.dirname, '../../stage0-fixture'),
  provider: 'deepseek-account', model: 'deepseek-flash',
  onUserQuestion: async (request, { signal }) => {
    console.log('Question received:', JSON.stringify(request))
    signal.addEventListener('abort', () => console.log('Question cancellation received'))
    return { answers: request.questions.map(question => ({
      id: question.id,
      selected: [question.options?.find(option => option.label.includes('暂不修改'))?.label ?? question.options?.[0]?.label ?? ''],
      custom: '这是集成测试的明确回答，不修改任何文件。',
    })) }
  },
})
try {
  harness.client.start()
  await harness.start()
  const result = await harness.run('如果 multiply 不存在，请使用 ask_user_question 询问我是否暂不修改。必须提问一次，然后按我的选择继续；不要修改文件。')
  console.log('Question flow response:', result.finalResponse, result.finishReason)
  if (result.finishReason !== 'completed') throw new Error('Question flow failed')
  console.log('SDK structured question flow passed')
} finally { await harness.close() }
