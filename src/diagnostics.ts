export type DiagnosticCategory = '模型' | 'Host' | '工具' | '工具/沙箱' | '上下文' | 'Agent'

/** SDK protocol errors may be plain JSON-RPC objects rather than Error instances. */
export function errorText(error: unknown): string {
  if (error instanceof Error) return error.stack ?? error.message
  if (typeof error === 'string') return error
  if (error === null || error === undefined) return String(error)
  if (typeof error === 'object') {
    const record = error as Record<string, unknown>
    if (record.message === undefined && record.error !== undefined) return errorText(record.error)
    const message = typeof record.message === 'string' ? record.message : typeof record.error === 'string' ? record.error : undefined
    const code = typeof record.code === 'number' || typeof record.code === 'string' ? ` [code ${record.code}]` : ''
    let data = ''
    if (record.data !== undefined) {
      try { data = `\n${JSON.stringify(record.data)}` } catch { data = '\n[错误详情无法序列化]' }
    }
    if (record.error !== undefined && typeof record.error !== 'string') {
      data = `${data}\n${errorText(record.error)}`
    }
    if (message !== undefined) return `${message}${code}${data}`
    try { return JSON.stringify(error) } catch { return Object.prototype.toString.call(error) }
  }
  return String(error)
}

export function diagnostic(category: DiagnosticCategory, message: string, hint?: string): string {
  return `[${category}] ${message}${hint === undefined ? '' : `\n处理建议：${hint}`}`
}

/** P2-2: Map common technical errors to user-friendly descriptions */
const errorCodeMap: Record<string, string> = {
  'ENOENT': '文件或目录不存在',
  'EACCES': '权限不足，无法访问',
  'EPERM': '操作不被允许',
  'ECONNREFUSED': '连接被拒绝，服务未启动或网络不通',
  'ETIMEDOUT': '连接超时，网络响应缓慢',
  'ENOTFOUND': '域名解析失败，无法找到主机',
  'ECONNRESET': '连接被重置，网络不稳定',
  'EADDRINUSE': '端口被占用',
  'EISDIR': '目标是目录而非文件',
  'ENOTDIR': '路径中包含非目录组件',
  'EEXIST': '文件已存在',
  'ENOSPC': '磁盘空间不足',
  'EROFS': '只读文件系统',
  'EMFILE': '打开文件过多',
  'ELOOP': '符号链接循环',
}

export function friendlyError(error: unknown): string {
  const text = errorText(error)
  // Check for Node.js error codes
  for (const [code, description] of Object.entries(errorCodeMap)) {
    if (text.includes(code)) {
      return `${description}（${code}）\n${text}`
    }
  }
  // Check for common patterns
  if (/Cannot find module/.test(text)) {
    return `模块缺失，请检查依赖是否完整安装\n${text}`
  }
  if (/Permission denied/.test(text)) {
    return `权限不足，请检查文件权限或运行环境\n${text}`
  }
  if (/out of memory|heap|allocation failed/i.test(text)) {
    return `内存不足，请关闭其他应用或增加内存限制\n${text}`
  }
  return text
}

export function hostError(error: unknown): string {
  const text = errorText(error)
  if (/MISSING_CREDENTIAL|unauthorized|invalid.?api.?key|401/i.test(text)) {
    return diagnostic('模型', text, '请在 DSH 的模型提供商设置中检查登录状态或 API Key；不要把密钥粘贴到聊天中。')
  }
  if (/rate.?limit|429|insufficient.?quota|quota exceeded/i.test(text)) {
    return diagnostic('模型', text, '请检查模型额度、请求频率，或切换其他已配置模型。')
  }
  if (/ECONNREFUSED|ENOTFOUND|ETIMEDOUT|fetch failed|network|socket|transport failed|\bTRANSPORT\b|\bTIMEOUT\b/i.test(text)) {
    return diagnostic('模型', text, 'DSH 已多次尝试，但模型服务传输失败。请检查网络/代理，稍后重试或切换其他已配置模型；不需要手动启动 Host。')
  }
  if (/Node|Electron|dshRepository|DSH 源码|Host|spawn|SDK|JSON-RPC/i.test(text)) {
    return diagnostic('Host', text, '请查看“Coding Agent”输出日志并重载窗口。若使用内置运行时，请重新安装扩展；源码模式仅用于显式开发。')
  }
  return diagnostic('Agent', text, '请查看“Coding Agent”输出日志；若问题持续，重载窗口后恢复会话。')
}

export function toolError(text: string): string {
  if (/sandbox|file access denied|read-only file system|权限|permission denied/i.test(text)) {
    return diagnostic('工具/沙箱', text, '普通写入未获授权。可拒绝本次操作，或按审批提示允许一次；不会自动切换为完全访问。')
  }
  return diagnostic('工具', text, '展开工具调用查看命令和输出；失败命令不会被计为验证通过。')
}

export type TestStatus = 'passed' | 'failed' | 'unknown'
export interface TestFailure { name: string, path?: string, line?: number, message?: string }
export interface TestSummary { status: TestStatus, label: string, exitCode?: number, details?: string, failures: TestFailure[], rerunCommand?: string }

/** Locate real test failures from tracebacks; never infer a failure from model prose. */
export function testFailures(command: string, output: string): TestFailure[] {
  const failures: TestFailure[] = []
  if (/python(?:3)?\s+-m\s+(?:unittest|pytest)|(?:^|\s)pytest(?:\s|$)|python(?:3)?\s+\S*test\S*\.py/.test(command)) {
    const lines = output.split(/\r?\n/).map(line => line.replace(/^\[(?:stdout|stderr)\]\s?/, ''))
    for (let index = 0; index < lines.length; index++) {
      const header = lines[index].match(/^(?:FAIL|ERROR):\s+(.+)$/)
      if (header === null || /^\(.*(?:failed|errors?|failures)=\d+.*\)$/.test(header[1])) continue
      const end = lines.slice(index + 1).findIndex(line => /^(?:FAIL|ERROR):/.test(line))
      const block = lines.slice(index + 1, end < 0 ? lines.length : index + end + 1).join('\n')
      const method = header[1].match(/^(\w+)\s+\(/)?.[1]
      const testPath = header[1].match(/\((?:.*\.)?([^.)]+)\.[^.)]+\)/)?.[1]
      const locations = [...block.matchAll(/File ["']([^"'\n]+)["'], line (\d+)(?:, in (\w+))?/g)]
      const location = locations.find(item => item[3] === method && item[1].endsWith(`${testPath}.py`)) ?? locations.at(-1)
      const message = block.split('\n').map(line => line.trim()).find(line => /^(?:AssertionError|ValueError|TypeError|RuntimeError|[\w.]+Error):/.test(line))
      failures.push({ name: header[1], ...(location === undefined ? {} : { path: location[1], line: Number(location[2]) }), ...(message === undefined ? {} : { message }) })
    }
    for (const match of output.matchAll(/^\s*FAILED\s+((?!\()[^\s:]+(?:::[^\s]+)*)\s*(?:-\s*(.*))?$/gm)) {
      failures.push({ name: match[1], path: match[1].split('::')[0], ...(match[2] === undefined ? {} : { message: match[2] }) })
    }
  } else if (/node\s+--test/.test(command)) {
    for (const match of output.matchAll(/^not ok \d+ - (.+)$/gm)) failures.push({ name: match[1] })
  } else if (/(?:jest|vitest|npm|pnpm|yarn|bun)/.test(command)) {
    for (const match of output.matchAll(/^\s*●\s+(.+)$/gm)) failures.push({ name: match[1] })
  } else if (/go\s+test/.test(command)) {
    for (const match of output.matchAll(/^--- FAIL:\s+(\S+)/gm)) failures.push({ name: match[1] })
  }
  return failures.slice(0, 50)
}

function quote(value: string): string { return `'${value.replaceAll("'", "'\\''")}'` }

/** Narrow reruns to a real failing file; use the original runner when no safe target exists. */
export function testRerunCommand(command: string, failures: readonly TestFailure[]): string | undefined {
  if (failures.length === 0) return undefined
  const paths = [...new Set(failures.map(failure => failure.path).filter((path): path is string => path !== undefined))]
  if (/(?:python3?|python)\s+-m\s+pytest|(^|\s)pytest(\s|$)/.test(command)) {
    return `python -m pytest ${failures.map(failure => quote(failure.name)).join(' ')}`
  }
  if (/python(?:3)?\s+-m\s+unittest|python(?:3)?\s+\S*test\S*\.py/.test(command)) {
    const directFile = command.match(/python(?:3)?\s+(\S*test\S*\.py)/)?.[1]
    const tests = failures.map(failure => {
      const name = failure.name.match(/^\w+\s+\(([^)]+)\)/)?.[1]
      if (name === undefined || name.startsWith('unittest.loader.')) return undefined
      if (name.startsWith('__main__.')) {
        const module = directFile?.replace(/\.py$/, '').replaceAll('/', '.')
          ?? failure.path?.replace(/\.py$/, '').split('/').at(-1)
        if (module !== undefined) return `${module}.${name.slice('__main__.'.length)}`
      }
      return name
    }).filter((name): name is string => name !== undefined)
    return tests.length === failures.length ? `python -m unittest ${tests.map(quote).join(' ')}` : command
  }
  if (/node\s+--test/.test(command) && paths.length > 0) return `node --test ${paths.map(quote).join(' ')}`
  if (/(?:^|\s)(?:npx\s+)?jest(?:\s|$)/.test(command) && paths.length > 0) return `npx jest ${paths.map(quote).join(' ')} --runInBand`
  if (/(?:^|\s)(?:npx\s+)?vitest(?:\s|$)/.test(command) && paths.length > 0) return `npx vitest run ${paths.map(quote).join(' ')}`
  if (/(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?test/.test(command)) return command
  if (/go\s+test/.test(command)) return command
  return command
}

/** Only actual Bash invocations with test-like commands produce a test summary. */
export function testSummary(command: string, output: string, toolError = false): TestSummary | undefined {
  const isTest = /(^|[\s;&|])(npm|pnpm|yarn|bun)\s+(run\s+)?test([\s;&|]|$)/.test(command)
    || /(^|[\s;&|])(node\s+--test|pytest|vitest|jest|go\s+test|cargo\s+test|python(?:3)?\s+-m\s+(?:unittest|pytest))([\s;&|]|$)/.test(command)
    || /(^|[\s;&|])python(?:3)?\s+\S*test\S*\.py([\s;&|]|$)/.test(command)
  if (!isTest) return undefined
  const exitText = output.match(/(?:\[exit code: |\[Command finished with exit code |^EXIT_CODE=)(\d+)\]?$/m)?.[1]
  const exitCode = exitText === undefined ? undefined : Number(exitText)
  const node = output.match(/^(?:# |ℹ )?(pass|fail|tests) (\d+)$/gm)
  const counts = { pass: 0, fail: 0, tests: 0 }
  for (const line of node ?? []) {
    const match = line.match(/^(?:# |ℹ )?(pass|fail|tests) (\d+)$/)
    if (match) counts[match[1] as keyof typeof counts] = Number(match[2])
  }
  const pytest = output.match(/=+ (?:(\d+) failed[^\n=]*?)?(?:, )?(\d+) passed[^\n=]*=+/i)
  const jest = output.match(/Tests:\s*(?:(\d+) failed,\s*)?(?:(\d+) passed,\s*)?(\d+) total/i)
  const go = output.match(/^(ok|FAIL)\s+\S+/m)
  const failed = counts.fail > 0 || Number(pytest?.[1] ?? 0) > 0 || Number(jest?.[1] ?? 0) > 0
    || go?.[1] === 'FAIL' || exitCode !== undefined && exitCode !== 0 || toolError || /(^|\n)(?:\[stderr\]\s*)?(?:not ok|FAILED|ERRORS?)(?:\s|:)|^(?:\[stderr\]\s*)?(?:FAIL|ERROR):\s+\w+\s+\(/m.test(output)
  const unittest = output.match(/(?:^|\n)(?:\[stderr\]\s*)?Ran (\d+) tests?/)
  const passed = counts.pass > 0 || Number(pytest?.[2] ?? 0) > 0 || Number(jest?.[2] ?? 0) > 0 || go?.[1] === 'ok' || unittest !== null && /(?:^|\n)(?:\[stderr\]\s*)?OK\s*(?:\n|$)/.test(output)
  const status: TestStatus = failed || toolError ? 'failed' : passed && (exitCode === 0 || exitCode === undefined && !toolError) ? 'passed' : 'unknown'
  const summary = unittest !== null ? `Python unittest ${unittest[1]} 项${status === 'passed' ? '，全部通过' : ''}` : counts.tests > 0 ? `Node ${counts.pass} 通过，${counts.fail} 失败，共 ${counts.tests} 项`
    : jest ? `Jest/Vitest ${jest[2] ?? 0} 通过，${jest[1] ?? 0} 失败，共 ${jest[3]} 项`
      : pytest ? `pytest ${pytest[2]} 通过，${pytest[1] ?? 0} 失败`
        : go ? `Go ${go[1]}` : undefined
  const failures = failed ? testFailures(command, output) : []
  const rerunCommand = testRerunCommand(command, failures)
  return {
    status, failures,
    label: `${status === 'passed' ? '测试通过' : status === 'failed' ? '测试失败' : '测试已结束，需检查日志'}${summary === undefined ? '' : ` · ${summary}`}`,
    exitCode,
    details: exitCode === undefined ? '退出码：本次工具结果未提供' : `退出码：${exitCode}`,
    ...(rerunCommand === undefined ? {} : { rerunCommand }),
  }
}
