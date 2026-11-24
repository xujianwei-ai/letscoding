/**
 * 记忆插件 - Host 端
 * 监听会话事件，提取关键信息存储为长期记忆
 */

export function apply(ctx) {
  console.log('[MemoryPlugin] 记忆插件已加载')

  // 内存中的记忆存储（生产环境应该用数据库）
  const memoryStore = new Map()

  // 监听会话事件
  ctx.on('session/event', (session, event) => {
    // 只处理用户消息
    if (event.type === 'user/message') {
      const message = event.data
      console.log('[MemoryPlugin] 收到用户消息:', message.content?.substring(0, 50))

      // 简单提取：如果消息包含"我叫"、"我喜欢"等关键词，提取为记忆
      const content = message.content || ''
      if (content.includes('我叫') || content.includes('我喜欢') || content.includes('我是')) {
        const memory = {
          id: Date.now().toString(),
          type: 'fact',
          content: content.substring(0, 100),
          timestamp: new Date().toISOString(),
          sessionId: session.id,
        }

        memoryStore.set(memory.id, memory)
        console.log('[MemoryPlugin] 提取记忆:', memory.content)
      }
    }

    // 助手回复也可以提取
    if (event.type === 'assistant/message') {
      const message = event.data
      // 可以分析助手回复，提取用户的偏好信息
      console.log('[MemoryPlugin] 助手回复长度:', message.content?.length)
    }
  })

  // 注册一个工具，让 Agent 可以查询记忆
  ctx.tools?.register?.({
    name: 'memory_recall',
    description: '查询用户的长期记忆',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '查询关键词' },
        limit: { type: 'number', description: '返回数量限制', default: 5 }
      }
    },
    output: {
      schema: { type: 'array', items: { type: 'object' } },
      render: (args, value) => [{
        type: 'text',
        text: JSON.stringify(value, null, 2)
      }]
    },
    execute: async (args, exec) => {
      const query = args.query || ''
      const limit = args.limit || 5

      // 简单搜索：匹配内容包含关键词的记忆
      const results = Array.from(memoryStore.values())
        .filter(m => m.content.includes(query))
        .slice(0, limit)

      console.log('[MemoryPlugin] 记忆召回:', query, '找到', results.length, '条')
      return results
    }
  })

  // 注册另一个工具，让 Agent 可以主动写入记忆
  ctx.tools?.register?.({
    name: 'memory_store',
    description: '主动存储一条用户记忆',
    parameters: {
      type: 'object',
      properties: {
        content: { type: 'string', description: '记忆内容' },
        type: { type: 'string', description: '记忆类型', enum: ['fact', 'preference', 'event'], default: 'fact' }
      },
      required: ['content']
    },
    output: {
      schema: { type: 'object' },
      render: (args, value) => [{
        type: 'text',
        text: `已存储记忆: ${value.content}`
      }]
    },
    execute: async (args, exec) => {
      const memory = {
        id: Date.now().toString(),
        type: args.type || 'fact',
        content: args.content,
        timestamp: new Date().toISOString(),
        source: 'agent_explicit'
      }

      memoryStore.set(memory.id, memory)
      console.log('[MemoryPlugin] Agent 主动存储记忆:', memory.content)
      return memory
    }
  })

  console.log('[MemoryPlugin] 已注册工具: memory_recall, memory_store')
}
