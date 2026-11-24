async function run() {
  const assert = require('node:assert/strict')
  const fs = require('node:fs')
  const path = require('node:path')
  const { createHarness } = await import('../out/runtime.js')
  const cwd = path.resolve(__dirname, '../../.vscode-agent-dev/approval-test-workspace')
  fs.rmSync(cwd, { recursive: true, force: true })
  fs.mkdirSync(cwd, { recursive: true })
  const target = path.join(cwd, 'approval-probe.txt')
  fs.writeFileSync(target, 'BEFORE\n')
  try {
    for (const outcome of ['rejected', 'allowed-once']) {
      const harness = createHarness({
        extensionRoot: path.resolve(__dirname, '..'), dshHome: process.env.DSH_AGENT_HOME, cwd,
        provider: 'deepseek-account', model: 'deepseek-flash', approvalRequests: true, permissionMode: 'read-only',
      })
      let approvals = 0
      try {
        harness.client.start()
        harness.client.onRequest(async (method, params) => {
          if (method !== 'approval/request') throw new Error(`Unexpected request: ${method}`)
          approvals++
          return { outcome }
        })
        await harness.start()
        const result = await harness.run(`请把 approval-probe.txt 的内容改成 ${outcome}，只修改这个文件。当前会话是 read-only；如果普通写入被沙箱拒绝，请重试该精确操作，携带 sandbox_permissions="workspace-write" 和一句 justification。不要 Bash，不要改变权限模式，不要绕过审批。最终报告结果。`)
        assert.equal(result.finishReason, 'completed')
        assert.equal(approvals, 1)
        const content = fs.readFileSync(target, 'utf8')
        if (outcome === 'rejected') assert.equal(content, 'BEFORE\n')
        else assert.ok(content.includes(outcome))
        console.log('Approval outcome verified:', outcome)
      } finally { await harness.close() }
    }
  } finally { fs.rmSync(cwd, { recursive: true, force: true }) }
  console.log('Isolated approval regression passed')
}
module.exports = { run }
