/** Durable provider configuration and private credential ownership at the SDK boundary. */
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { LocalCredentialProvider } from '@deepseek-ai/dsh-credentials-local'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import * as LlmPiAi from '@deepseek-ai/dsh-llm-pi-ai'
import { configurationFixture } from '../../../settings/settings/tests/configuration-fixture.ts'
import { HarnessSdkJsonRpcServer } from '../src/index.ts'
import type { JsonRpcTransportPeer } from '@deepseek-ai/dsh-sdk-protocol'

const transport: JsonRpcTransportPeer = {
  request: () => Promise.reject(new Error('unexpected client request')),
  notify: () => {},
}

/** Mount real settings and file credentials, replacing only the form schema. */
async function fixture(): Promise<{ server: HarnessSdkJsonRpcServer; ctx: Context; patchPath: string; directory: string }> {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-sdk-provider-'))
  const profile = await configurationFixture()
  await profile.ctx.plugin(LocalCredentialProvider, { path: join(directory, '.credentials.yaml'), watch: false })
  const server = new HarnessSdkJsonRpcServer(profile.ctx, transport)
  return { server, ctx: profile.ctx, patchPath: profile.profile.patchPath, directory }
}

it('saves private keys separately, preserves draft fields, and reads no secret back', async () => {
  const { server, ctx, patchPath, directory } = await fixture()
  try {
    await ctx.settings.mutate('llm-pi-ai', [{ op: 'set', path: ['providers', 'acme'], value: {
      displayName: 'Acme', apiKeyEnv: 'LEGACY_KEY', api: 'openai-completions',
      baseURL: 'https://acme.example/v1', headers: { 'x-deployment': 'one' },
      retryPolicy: { mode: 'normal' }, models: [],
    } }])
    await ctx.credentials.set(credentialRef('LEGACY_KEY'), 'first-secret')
    const request = {
      settingsNs: 'llm-pi-ai' as const, provider: 'acme', displayName: 'My Gateway',
      baseURL: 'https://acme.example/v2', api: 'openai-completions' as const,
      models: [{ id: 'model-a', name: 'Friendly A', input: ['text', 'image'] as Array<'text' | 'image'> }],
    }
    await expect(server.handleRequest('models/saveProvider', request)).resolves.toEqual({ provider: 'acme' })
    expect((await ctx.credentials.resolve(credentialRef('LEGACY_KEY')))?.value).toBe('first-secret')
    const editing = await server.handleRequest('models/providerConfig', { provider: 'acme' }) as Record<string, unknown>
    expect(editing).toMatchObject({ displayName: 'My Gateway', baseURL: 'https://acme.example/v2', hasCredential: true })
    expect(JSON.stringify(editing)).not.toContain('first-secret')
    expect(JSON.stringify(editing)).not.toContain('apiKeyEnv')
    expect(await readFile(patchPath, 'utf8')).toContain('x-deployment: one')
    expect(await readFile(patchPath, 'utf8')).toContain('mode: normal')
    await server.handleRequest('models/saveProvider', { ...request, apiKey: 'replacement-secret', displayName: 'Renamed Gateway' })
    expect((await ctx.credentials.resolve(credentialRef('ACME_API_KEY')))?.value).toBe('replacement-secret')
    const stored = await readFile(join(directory, '.credentials.yaml'), 'utf8')
    expect(stored).toContain('ACME_API_KEY')
    expect(stored).toContain('replacement-secret')
    await server.handleRequest('models/deleteProvider', { provider: 'acme' })
    await expect(server.handleRequest('models/providerConfig', { provider: 'acme' })).rejects.toThrow('not configured')
    expect(await ctx.credentials.resolve(credentialRef('ACME_API_KEY'))).toBeUndefined()
  } finally {
    await server.shutdown()
    await ctx.fiber.dispose()
    await rm(directory, { recursive: true, force: true })
  }
})

it('probes a saved route with its private key and never persists a draft key', async () => {
  const { server, ctx, directory } = await fixture()
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(LlmPiAi, {})
  const http = createServer((request, response) => {
    let body = ''
    request.on('data', (chunk) => { body += chunk })
    request.on('end', () => {
      const reply = request.url === '/v1/models'
        ? JSON.stringify({ data: [{ id: 'local-model' }] })
        : 'data: {"id":"probe","object":"chat.completion.chunk","created":1,"model":"local-model","choices":[{"index":0,"delta":{"role":"assistant","content":"OK"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n'
      response.setHeader('authorization-seen', request.headers.authorization ?? 'none')
      response.writeHead(200, { 'content-type': request.url === '/v1/models' ? 'application/json' : 'text/event-stream' })
      response.end(reply)
      if (request.url !== '/v1/models') {
        const parsed = JSON.parse(body)
        expect(parsed.max_tokens ?? parsed.max_completion_tokens).toBe(16)
      }
    })
  })
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve))
  try {
    const address = http.address()
    if (address === null || typeof address === 'string') throw new Error('no test server port')
    const baseURL = `http://127.0.0.1:${address.port}/v1`
    const draft = { settingsNs: 'llm-pi-ai' as const, provider: 'local-gateway', baseURL, api: 'openai-completions' as const }
    await server.handleRequest('models/saveProvider', { ...draft, apiKey: 'private-saved-key', models: [{ id: 'local-model' }] })
    const config = await server.handleRequest('models/providerConfig', { provider: 'local-gateway' })
    expect(JSON.stringify(config)).not.toContain('private-saved-key')
    const discovered = await server.handleRequest('models/discover', draft)
    expect(discovered).toEqual([{ id: 'local-model', name: 'local-model' }])
    await expect(server.handleRequest('models/test', { ...draft, model: 'local-model', apiKey: 'private-saved-key' })).resolves.toMatchObject({ provider: 'local-gateway', model: 'local-model' })
    await expect(server.handleRequest('models/test', { ...draft, model: 'local-model', apiKey: 'draft-only-key' })).resolves.toMatchObject({ model: 'local-model' })
    const credentials = await readFile(join(directory, '.credentials.yaml'), 'utf8')
    expect(credentials).toContain('private-saved-key')
    expect(credentials).not.toContain('draft-only-key')
    await expect(server.handleRequest('models/test', { ...draft, model: 'local-model', apiKey: 'key with spaces' })).rejects.toThrow(/raw key/)
  } finally {
    await new Promise<void>(resolve => http.close(() => resolve()))
    await server.shutdown()
    await ctx.fiber.dispose()
    await rm(directory, { recursive: true, force: true })
  }
})

it('serializes independent writes and refuses to delete built-in account routes', async () => {
  const { server, ctx, directory } = await fixture()
  try {
    const request = (provider: string) => ({ settingsNs: 'llm-pi-ai' as const, provider, apiKey: `${provider}-secret`, models: [{ id: 'model' }] })
    await Promise.all([
      server.handleRequest('models/saveProvider', request('acme')),
      server.handleRequest('models/saveProvider', request('other')),
    ])
    expect((await ctx.credentials.resolve(credentialRef('ACME_API_KEY')))?.value).toBe('acme-secret')
    expect((await ctx.credentials.resolve(credentialRef('OTHER_API_KEY')))?.value).toBe('other-secret')
    await expect(server.handleRequest('models/deleteProvider', { provider: 'deepseek-account' })).rejects.toThrow('cannot be deleted')
  } finally {
    await server.shutdown()
    await ctx.fiber.dispose()
    await rm(directory, { recursive: true, force: true })
  }
})
