window.__ModuleLoader__.load({
  id: '@local/my-memory-plugin',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    function MemoryPanel() {
      return h('div', {
        style: {
          padding: '12px',
          background: '#1a1a2e',
          borderRadius: '8px',
          color: '#eee',
          fontSize: '14px',
          maxWidth: '300px'
        }
      }, [
        h('div', { key: 'title', style: { fontWeight: 'bold', marginBottom: '8px' } }, '🧠 记忆面板'),
        h('div', { key: 'content', style: { fontSize: '12px', opacity: 0.8 } }, '记忆插件已加载，监听会话事件...')
      ]);
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register({
          name: 'conversation.composer.dock', id: 'my-memory-plugin', order: 10,
        }, MemoryPanel));
      },
    };
  },
});
