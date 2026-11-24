import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { delimiter, resolve } from 'node:path'
import { homedir } from 'node:os'
import { load } from 'js-yaml'

/** Match DSH's shared default: ~/.dsh, unless an explicit DSH_HOME is supplied. */
export function defaultDshHome(environment: NodeJS.ProcessEnv = process.env): string {
  return resolve(environment.DSH_HOME || resolve(homedir(), '.dsh'))
}

/** DSH mounts the official adapter even without credentials; catalog reads must not inherit a removed saved route. */
export const CATALOG_BOOTSTRAP_ROUTE = { provider: 'deepseek-official', model: 'deepseek-flash' } as const

import { DeepSeekHarness, type DeepSeekHarnessOptions, type SdkUserQuestionRequest, type SdkUserQuestionResult } from '@deepseek-ai/dsh-sdk-client'

/** Reuse model declarations only; credentials remain references resolved by DSH. */
export function webProviderPatch(dshHome: string, directory: string): string | undefined {
  const path = resolve(dshHome, 'profiles/web/cordis.patch.yml')
  if (!existsSync(path)) return undefined
  try {
    const entries = load(readFileSync(path, 'utf8'), { filename: path }) as unknown
    if (!Array.isArray(entries)) return undefined
    const provider = entries.find(entry => entry !== null && typeof entry === 'object'
      && (entry as { name?: unknown }).name === '@deepseek-ai/dsh-llm-pi-ai') as { config?: unknown } | undefined
    if (provider?.config === null || typeof provider?.config !== 'object' || Array.isArray(provider.config)) return undefined
    const yaml = `- id: llm-pi-ai\n  config:\n${JSON.stringify(provider.config, null, 2).split('\n').map(line => `    ${line}`).join('\n')}\n`
    mkdirSync(directory, { recursive: true })
    const patch = resolve(directory, `web-providers-${createHash('sha256').update(yaml).digest('hex').slice(0, 16)}.yml`)
    if (!existsSync(patch)) writeFileSync(patch, yaml, { mode: 0o600, flag: 'wx' })
    if (readFileSync(patch, 'utf8') !== yaml) throw new Error(`Web 模型声明补丁内容不一致：${patch}`)
    return patch
  } catch (error) {
    throw new Error(`无法复用 DSH Web 模型配置；请检查该文件的 YAML 格式: ${path}；${error instanceof Error ? error.message : String(error)}`)
  }
}

/** Launch inputs deliberately exclude credentials: DSH owns its private credential store. */
export type AgentNetworkMode = 'direct' | 'system' | 'proxy'

export interface AgentNetworkOptions {
  networkMode?: AgentNetworkMode
  proxyUrl?: string
}

export interface AgentRuntimeOptions extends AgentNetworkOptions {
  /** Explicit external Node for source mode; no bundled-mode fallback. */
  nodePath?: string
  dshRepository?: string
  /** Production defaults to bundled; source is an explicit developer choice. */
  runtimeMode?: 'bundled' | 'source'
  extensionRoot?: string
  runtimeStorage?: string
  /** Testable process input; production callers use the Extension Host environment. */
  processEnv?: NodeJS.ProcessEnv
  dshHome: string
  cwd: string
  provider?: string
  model?: string
  approvalRequests?: boolean
  permissionMode?: 'read-only' | 'workspace-write' | 'danger-full-access'
  onUserQuestion?: (request: SdkUserQuestionRequest, context: { signal: AbortSignal }) => Promise<SdkUserQuestionResult>
  requestTimeoutMs?: number
  shutdownTimeoutMs?: number
  disposeEofGraceMs?: number
  disposeGraceMs?: number
}

const PROXY_ENV_NAMES = ['http_proxy', 'HTTP_PROXY', 'https_proxy', 'HTTPS_PROXY', 'no_proxy', 'NO_PROXY', 'all_proxy', 'ALL_PROXY'] as const

/** Keep VS Code's inherited transport separate from the ordinary Node Host. */
export function hostNetworkEnvironment(
  source: NodeJS.ProcessEnv, mode: AgentNetworkMode = 'direct', proxyUrl = '',
): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = { ...source, NODE_USE_ENV_PROXY: undefined }
  // Empty values also mask proxy entries in DSH's lower-priority .env layers.
  for (const name of PROXY_ENV_NAMES) environment[name] = ''
  if (mode === 'system') {
    for (const name of PROXY_ENV_NAMES) environment[name] = source[name]
    return environment
  }
  if (mode !== 'proxy') return environment
  let url: URL
  try { url = new URL(proxyUrl.trim()) } catch { throw new Error('模型代理地址无效，请输入 http://主机:端口 或 https://主机:端口。') }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('模型代理仅支持 HTTP 或 HTTPS 地址。')
  environment.HTTP_PROXY = url.toString()
  environment.HTTPS_PROXY = url.toString()
  environment.NO_PROXY = 'localhost,127.0.0.1,::1'
  environment.http_proxy = url.toString()
  environment.https_proxy = url.toString()
  environment.no_proxy = environment.NO_PROXY
  return environment
}

/** A cached Host must not silently retain a different network route. */
export function sameNetworkOptions(a: AgentNetworkOptions, b: AgentNetworkOptions): boolean {
  return (a.networkMode ?? 'direct') === (b.networkMode ?? 'direct')
    && (a.proxyUrl ?? '').trim() === (b.proxyUrl ?? '').trim()
}

/** Locate a supported ordinary Node, never the VS Code Electron executable. */
export function ordinaryNode(env: NodeJS.ProcessEnv = process.env, explicitPath?: string): string | undefined {
  const configuredPath = explicitPath ?? env.DSH_NODE_PATH
  const candidates = configuredPath ? [configuredPath] : ['/usr/local/bin/node', '/usr/bin/node', '/opt/node/bin/node']
  if (!configuredPath) for (const directory of (env.PATH ?? '').split(delimiter)) if (directory) candidates.push(resolve(directory, 'node'))
  for (const executable of [...new Set(candidates)]) {
    if (executable === process.execPath || !existsSync(executable)) continue
    const probe = spawnSync(executable, ['-p', 'process.versions.electron ? "" : process.version'], {
      env: { ...env, ELECTRON_RUN_AS_NODE: undefined },
      encoding: 'utf8',
      timeout: 3000,
    })
    const version = probe.stdout?.trim()
    if (probe.status !== 0 || version === undefined) continue
    const [major, minor] = version.slice(1).split('.').map(Number)
    if (major > 24 || major === 24 && minor >= 9) return executable
  }
  return undefined
}

/** Resolve exactly one deployment; a damaged bundled installation never falls back to source. */
export function harnessLaunchOptions(options: AgentRuntimeOptions): DeepSeekHarnessOptions {
  const mode = options.runtimeMode ?? 'bundled'
  const extensionRoot = resolve(options.extensionRoot ?? resolve(import.meta.dirname, '..'))
  const bundledRoot = resolve(extensionRoot, '.runtime-build')
  if (mode === 'bundled' && process.platform !== 'linux' || mode === 'bundled' && process.arch !== 'x64') {
    throw new Error('当前内置运行时仅支持 Linux x64 glibc；不能在其他平台静默使用开发环境。')
  }
  const source = options.processEnv ?? process.env
  const node = mode === 'bundled'
    ? resolve(bundledRoot, 'node/bin/node')
    : ordinaryNode(source, options.nodePath)
  if (node === undefined) {
    const guidance = source.PATH === undefined || source.PATH === '' ? 'PATH 未提供可执行文件目录。' : 'PATH 中没有可执行的普通 Node >=24.9。'
    throw new Error(`源码模式需要普通 Node >=24.9；${guidance}请安装 Node 并配置 DSH_NODE_PATH。`)
  }
  const repository = mode === 'source' ? resolve(options.dshRepository ?? '') : bundledRoot
  const dshBin = mode === 'source' ? resolve(repository, 'apps/cli/lib/bin.js') : resolve(repository, 'dsh/node_modules/@deepseek-ai/dsh/lib/bin.js')
  const required = mode === 'source'
    ? [dshBin]
    : [dshBin, resolve(repository, 'dsh/runtime-staging.json'), resolve(repository, 'node/runtime-node.json')]
  for (const file of [node, ...required]) if (!existsSync(file)) throw new Error(`${mode === 'source' ? '源码运行时' : '内置运行时'}缺少文件：${file}。${mode === 'source' ? '请检查 dshRepository。' : '请重新安装扩展；不会回退到开发环境。'}`)
  if (mode === 'bundled') {
    const manifest = JSON.parse(readFileSync(resolve(bundledRoot, 'node/runtime-node.json'), 'utf8')) as { version?: unknown }
    if (manifest.version !== '24.9.0') throw new Error('内置 Node 版本与锁定基线不一致；请重新安装扩展。')
  }
  return {
    nodePath: node,
    dshBin,
    dshHome: resolve(options.dshHome),
    cwd: resolve(options.cwd),
    processCwd: mode === 'source' ? repository : resolve(repository, 'dsh'),
    provider: options.provider ?? 'deepseek-account',
    model: options.model ?? 'deepseek-flash',
    env: { ...hostNetworkEnvironment(source, options.networkMode, options.proxyUrl), LC_ALL: 'C', NODE_DISABLE_COMPILE_CACHE: '1', NODE: undefined, ELECTRON_RUN_AS_NODE: undefined, ELECTRON_NO_ATTACH_CONSOLE: undefined,
      DSH_PERMISSION_MODE: options.permissionMode ?? 'workspace-write' },
    approvalRequests: options.approvalRequests ?? true,
    onUserQuestion: options.onUserQuestion,
    initializeTimeoutMs: 30_000,
    requestTimeoutMs: options.requestTimeoutMs,
    shutdownTimeoutMs: options.shutdownTimeoutMs,
    disposeEofGraceMs: options.disposeEofGraceMs,
    disposeGraceMs: options.disposeGraceMs,
  }
}

/** The SDK owns executable selection, stdio JSON-RPC and the complete process lifecycle. */
export function createHarness(options: AgentRuntimeOptions): DeepSeekHarness {
  const launch = harnessLaunchOptions(options)
  const runtimeStorage = options.runtimeStorage ?? resolve(options.dshHome, 'patches')
  const providerPatch = webProviderPatch(options.dshHome, runtimeStorage)
  if (providerPatch !== undefined) launch.patches = [...launch.patches ?? [], providerPatch]
  if (options.runtimeMode === 'source') {
    const sourcePatch = resolve(options.dshRepository ?? '', 'apps/cli/src/sdk-source.cordis.patch.yml')
    if (!existsSync(sourcePatch)) throw new Error(`源码运行时缺少文件：${sourcePatch}。请检查 dshRepository。`)
    launch.patches = [...launch.patches ?? [], sourcePatch]
  }
  return new DeepSeekHarness(launch)
}

/** Resolve the sibling development checkout only for this private development extension. */
export function developmentRepository(): string | undefined {
  const extensionRoot = resolve(import.meta.dirname, '..')
  const candidate = resolve(extensionRoot, '../dsh-learning/deepseek-harness')
  return existsSync(resolve(candidate, 'apps/cli/src/bin.ts')) ? candidate : undefined
}
