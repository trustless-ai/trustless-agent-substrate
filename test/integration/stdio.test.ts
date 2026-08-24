import { createHash } from 'node:crypto'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  CLIENT_CAPABILITIES_META_KEY,
  PROTOCOL_VERSION_META_KEY,
  type McpServerFactory,
} from '@modelcontextprotocol/server'
import type { ServeStdioOptions, StdioServerHandle } from '@modelcontextprotocol/server/stdio'
import { afterEach, describe, expect, it } from 'vitest'

import { createTasApp } from '../../src/app/createTasApp.js'
import { run } from '../../src/app/main.js'
import { expectedIdentityTools, expectedMemberTools, expectedTawgTools } from '../conformance/toolInventory.expected.js'
import { createProfileRpcFixture, fixtureProfileAddress } from '../fixtures/profile/blocks.js'

const sourceEntrypoint = fileURLToPath(new URL('../../src/app/main.ts', import.meta.url))
const agentId = '340282366920938463463374607431768211457'
const expectedSkillBytes = readFileSync(new URL('../../skills/tas/SKILL.md', import.meta.url))
const expectedSkillContent = expectedSkillBytes.toString('utf8')
const expectedSkillDigest = createHash('sha256').update(expectedSkillBytes).digest('hex')

function config(mode: 'identity_setup' | 'tawg_setup' | 'member'): string {
  const phase = mode === 'identity_setup'
    ? `[identity_setup]\nchain_id = "31337"\nidentity_registry_address = "0x8004000000000000000000000000000000000001"`
    : mode === 'tawg_setup'
      ? `[tawg_setup]\nchain_id = "31337"\ntawg_address = "${fixtureProfileAddress}"`
      : `[instance]\nchain_id = "31337"\ntawg_address = "${fixtureProfileAddress}"\nagent_id = "${agentId}"`
  const member = mode === 'member' ? '\n[repository]\nclient = "github"\n\n[da]\nclient = "git"\n' : ''
  return `config_version = 1\nmode = "${mode}"\n\n${phase}\n\n[chain]\nfamily = "evm"\nrpc_url_env = "TAS_RPC_URL"\n${member}`
}

function temporaryConfig(mode: 'identity_setup' | 'tawg_setup' | 'member') {
  const root = mkdtempSync(join(tmpdir(), `tas-${mode}-`))
  const path = join(root, 'tas.toml')
  writeFileSync(path, config(mode))
  return { root, path }
}

const unavailableWorkflowCodeReader = () => ({
  readCode: async () => undefined,
}) as const

describe('TAS application composition', () => {
  it('constructs Skill and chain services for identity setup with the configured chain', async () => {
    const fixture = temporaryConfig('identity_setup')
    let clientConstructions = 0
    const clientChains: number[] = []
    let lockAcquisitions = 0
    let factory: McpServerFactory | undefined
    try {
      const app = await createTasApp(fixture.path, {
        environment: { TAS_RPC_URL: 'https://secret.invalid/rpc' },
        stateRoot: join(fixture.root, 'state'),
        createChainClient: (chainId) => {
          clientConstructions += 1
          clientChains.push(chainId)
          return createProfileRpcFixture().client
        },
        createWalletChainClient: (chainId) => {
          clientConstructions += 1
          clientChains.push(chainId)
          return { account: undefined, chain: { id: chainId } } as never
        },
        acquireLock: async () => { lockAcquisitions += 1; return async () => {} },
        serve: (selectedFactory) => {
          factory = selectedFactory
          return { close: async () => {} }
        },
      })
      expect(app.instance).toEqual({
        phase: 'identity_setup', chain_id: '31337',
        identity_registry_address: '0x8004000000000000000000000000000000000001',
      })
      expect(clientConstructions).toBe(2)
      expect(clientChains).toEqual([31337, 31337])
      expect(lockAcquisitions).toBe(0)
      expect(factory).toBeTypeOf('function')
      expect(await factory!({ era: 'legacy' })).not.toBe(await factory!({ era: 'legacy' }))
      await app.close()
    } finally { rmSync(fixture.root, { force: true, recursive: true }) }
  })

  it('constructs public Profile services without member state in TAWG setup', async () => {
    const fixture = temporaryConfig('tawg_setup')
    let clientConstructions = 0
    let lockAcquisitions = 0
    try {
      const app = await createTasApp(fixture.path, {
        environment: { TAS_RPC_URL: 'https://secret.invalid/rpc' },
        stateRoot: join(fixture.root, 'state'),
        createChainClient: () => { clientConstructions += 1; return createProfileRpcFixture().client },
        acquireLock: async () => { lockAcquisitions += 1; return async () => {} },
        serve: () => ({ close: async () => {} }),
      })
      expect(app.instance).toEqual({ phase: 'tawg_setup', chain_id: '31337', tawg_address: fixtureProfileAddress })
      expect(clientConstructions).toBe(1)
      expect(lockAcquisitions).toBe(0)
      expect(() => readFileSync(join(fixture.root, 'state'))).toThrow()
      await app.close()
    } finally { rmSync(fixture.root, { force: true, recursive: true }) }
  })

  it('fails closed before client construction when chain_id exceeds viem safe integer support', async () => {
    const fixture = temporaryConfig('identity_setup')
    writeFileSync(fixture.path, config('identity_setup').replace('chain_id = "31337"', 'chain_id = "9007199254740992"'))
    let clientConstructions = 0
    try {
      await expect(createTasApp(fixture.path, {
        environment: { TAS_RPC_URL: 'https://secret.invalid/rpc' },
        createChainClient: () => { clientConstructions += 1; return createProfileRpcFixture().client },
        createWalletChainClient: () => { clientConstructions += 1; return { account: undefined } as never },
        serve: () => ({ close: async () => {} }),
      })).rejects.toMatchObject({ code: 'CONFIG_FIELD_INVALID' })
      expect(clientConstructions).toBe(0)
    } finally { rmSync(fixture.root, { force: true, recursive: true }) }
  })

  it('locks the exact canonical member path and releases once under competing cleanup', async () => {
    const fixture = temporaryConfig('member')
    const paths: string[] = []
    let releases = 0
    let transportCloses = 0
    try {
      const app = await createTasApp(fixture.path, {
        environment: { TAS_RPC_URL: 'https://secret.invalid/rpc' },
        stateRoot: join(fixture.root, 'state'),
        createChainClient: () => createProfileRpcFixture({ member: false }).client,
        createWorkflowCodeReader: unavailableWorkflowCodeReader,
        acquireLock: async (path) => {
          paths.push(path)
          return async () => { releases += 1 }
        },
        serve: () => ({ close: async () => { transportCloses += 1 } }),
      })
      expect(paths).toEqual([join(
        fixture.root, 'state', 'instances', `eip155-31337-${fixtureProfileAddress}`, 'agents', agentId,
      )])
      await Promise.all([app.close(), app.close(), app.close()])
      expect(transportCloses).toBe(1)
      expect(releases).toBe(1)
    } finally { rmSync(fixture.root, { force: true, recursive: true }) }
  })

  it('releases a member lock when startup fails after acquisition', async () => {
    const fixture = temporaryConfig('member')
    let releases = 0
    try {
      await expect(createTasApp(fixture.path, {
        environment: { TAS_RPC_URL: 'https://secret.invalid/rpc' },
        stateRoot: join(fixture.root, 'state'),
        createChainClient: () => createProfileRpcFixture().client,
        createWorkflowCodeReader: unavailableWorkflowCodeReader,
        acquireLock: async () => async () => { releases += 1 },
        serve: () => { throw new Error('secret startup detail') },
      })).rejects.toThrow('TAS startup failed.')
      expect(releases).toBe(1)
    } finally { rmSync(fixture.root, { force: true, recursive: true }) }
  })

  it('turns repeated synchronous stdio errors into one terminal notification and one controlled close', async () => {
    const fixture = temporaryConfig('member')
    let releases = 0
    let transportCloses = 0
    try {
      const app = await createTasApp(fixture.path, {
        environment: { TAS_RPC_URL: 'https://secret.invalid/rpc' },
        stateRoot: join(fixture.root, 'state'),
        createChainClient: () => createProfileRpcFixture().client,
        createWorkflowCodeReader: unavailableWorkflowCodeReader,
        acquireLock: async () => async () => { releases += 1 },
        serve: (_factory, options) => {
          options?.onerror?.(new Error('local-path-and-rpc-secret'))
          options?.onerror?.(new Error('local-path-and-rpc-secret'))
          options?.onerror?.(new Error('local-path-and-rpc-secret'))
          return { close: async () => { transportCloses += 1 } }
        },
      })

      await expect(app.terminal).resolves.toEqual({ reason: 'stdio_error' })
      await app.close()
      expect(transportCloses).toBe(1)
      expect(releases).toBe(1)
    } finally { rmSync(fixture.root, { force: true, recursive: true }) }
  })
})

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>((complete) => { resolve = complete })
  return { promise, resolve }
}

function lifecycleEvents() {
  return {
    signals: new EventEmitter(),
    stdin: Object.assign(new EventEmitter(), { readableEnded: false, closed: false }),
  }
}

function outputBuffer() {
  let value = ''
  return { output: { write: (text: string) => { value += text } }, value: () => value }
}

const pendingTerminal = new Promise<never>(() => {})

describe('TAS CLI startup and shutdown guards', () => {
  it('completes the Manifest Registry preflight before application construction', async () => {
    const events = lifecycleEvents()
    events.stdin.readableEnded = true
    const order: string[] = []
    const status = run(['--config', 'member.toml'], outputBuffer().output, outputBuffer().output, {
      preflight: () => { order.push('registry') },
      createApp: async () => {
        order.push('application')
        return {
          instance: { phase: 'member', chain_id: '31337', tawg_address: fixtureProfileAddress, agent_id: agentId },
          terminal: pendingTerminal,
          close: async () => { order.push('close') },
        }
      },
      signals: events.signals,
      stdin: events.stdin,
    })

    await expect(status).resolves.toBe(0)
    expect(order).toEqual(['registry', 'application', 'close'])
  })

  it('latches a signal received while member startup is still completing and closes the constructed app immediately', async () => {
    const startupEntered = deferred<void>()
    const finishStartup = deferred<void>()
    const events = lifecycleEvents()
    const stdout = outputBuffer()
    const stderr = outputBuffer()
    let closes = 0
    let memberLockHeld = false
    const status = run(['--config', 'member.toml'], stdout.output, stderr.output, {
      createApp: async () => {
        memberLockHeld = true
        startupEntered.resolve()
        await finishStartup.promise
        return {
          instance: { phase: 'member', chain_id: '31337', tawg_address: fixtureProfileAddress, agent_id: agentId },
          terminal: pendingTerminal,
          close: async () => { closes += 1; memberLockHeld = false },
        }
      },
      signals: events.signals,
      stdin: events.stdin,
    })

    await startupEntered.promise
    expect(memberLockHeld).toBe(true)
    events.signals.emit('SIGTERM')
    finishStartup.resolve()

    await expect(status).resolves.toBe(0)
    expect(closes).toBe(1)
    expect(memberLockHeld).toBe(false)
    expect(stdout.value()).toBe('')
    expect(stderr.value()).toBe('')
    expect(events.signals.listenerCount('SIGTERM')).toBe(0)
  })

  it('removes all guards and returns only the fixed diagnostic when delayed startup fails', async () => {
    const startup = deferred<Awaited<ReturnType<typeof createTasApp>>>()
    const events = lifecycleEvents()
    const stdout = outputBuffer()
    const stderr = outputBuffer()
    const status = run(['--config', 'member.toml'], stdout.output, stderr.output, {
      createApp: async () => await startup.promise,
      signals: events.signals,
      stdin: events.stdin,
    })

    events.signals.emit('SIGINT')
    startup.resolve(Promise.reject(new Error('rpc-secret-marker')))

    await expect(status).resolves.toBe(1)
    expect(stdout.value()).toBe('')
    expect(stderr.value()).toBe('TAS_STARTUP_FAILED\n')
    expect(stderr.value()).not.toContain('rpc-secret-marker')
    expect(events.signals.listenerCount('SIGINT')).toBe(0)
    expect(events.signals.listenerCount('SIGTERM')).toBe(0)
    expect(events.stdin.listenerCount('end')).toBe(0)
    expect(events.stdin.listenerCount('close')).toBe(0)
  })

  it.each([
    ['repeated SIGINT', ['SIGINT', 'SIGINT']],
    ['repeated SIGTERM', ['SIGTERM', 'SIGTERM']],
    ['mixed signals', ['SIGINT', 'SIGTERM', 'SIGINT', 'SIGTERM']],
  ] as const)('keeps persistent guards through %s while one cleanup is pending', async (_label, sequence) => {
    const cleanup = deferred<void>()
    const events = lifecycleEvents()
    const stdout = outputBuffer()
    const stderr = outputBuffer()
    let closes = 0
    const status = run(['--config', 'member.toml'], stdout.output, stderr.output, {
      createApp: async () => ({
        instance: { phase: 'member', chain_id: '31337', tawg_address: fixtureProfileAddress, agent_id: agentId },
        terminal: pendingTerminal,
        close: async () => { closes += 1; await cleanup.promise },
      }),
      signals: events.signals,
      stdin: events.stdin,
    })
    await new Promise<void>((resolve) => setTimeout(resolve, 0))

    for (const signal of sequence) events.signals.emit(signal)
    expect(closes).toBe(1)
    expect(events.signals.listenerCount('SIGINT')).toBe(1)
    expect(events.signals.listenerCount('SIGTERM')).toBe(1)
    cleanup.resolve()

    await expect(status).resolves.toBe(0)
    expect(closes).toBe(1)
    expect(events.signals.listenerCount('SIGINT')).toBe(0)
    expect(events.signals.listenerCount('SIGTERM')).toBe(0)
  })

  it('coalesces mixed signal and stdin shutdown events without removing guards early', async () => {
    const cleanup = deferred<void>()
    const events = lifecycleEvents()
    const stdout = outputBuffer()
    const stderr = outputBuffer()
    let closes = 0
    const status = run(['--config', 'member.toml'], stdout.output, stderr.output, {
      createApp: async () => ({
        instance: { phase: 'member', chain_id: '31337', tawg_address: fixtureProfileAddress, agent_id: agentId },
        terminal: pendingTerminal,
        close: async () => { closes += 1; await cleanup.promise },
      }),
      signals: events.signals,
      stdin: events.stdin,
    })
    await new Promise<void>((resolve) => setTimeout(resolve, 0))

    events.stdin.emit('end')
    events.signals.emit('SIGINT')
    events.stdin.emit('close')
    events.signals.emit('SIGTERM')
    expect(closes).toBe(1)
    expect(events.signals.listenerCount('SIGINT')).toBe(1)
    expect(events.stdin.listenerCount('end')).toBe(1)
    cleanup.resolve()

    await expect(status).resolves.toBe(0)
    expect(closes).toBe(1)
    expect(events.signals.listenerCount('SIGINT')).toBe(0)
    expect(events.stdin.listenerCount('end')).toBe(0)
  })

  it('coalesces a terminal stdio error with repeated signals and stdin into one failed cleanup', async () => {
    const terminal = deferred<{ reason: 'stdio_error' }>()
    const cleanup = deferred<void>()
    const events = lifecycleEvents()
    const stdout = outputBuffer()
    const stderr = outputBuffer()
    let closes = 0
    const status = run(['--config', 'member.toml'], stdout.output, stderr.output, {
      createApp: async () => ({
        instance: { phase: 'member', chain_id: '31337', tawg_address: fixtureProfileAddress, agent_id: agentId },
        terminal: terminal.promise,
        close: async () => { closes += 1; await cleanup.promise },
      }),
      signals: events.signals,
      stdin: events.stdin,
    })
    await new Promise<void>((resolve) => setTimeout(resolve, 0))

    terminal.resolve({ reason: 'stdio_error' })
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
    events.signals.emit('SIGINT')
    events.stdin.emit('end')
    events.signals.emit('SIGTERM')
    events.stdin.emit('close')
    expect(closes).toBe(1)
    expect(events.signals.listenerCount('SIGINT')).toBe(1)
    cleanup.resolve()

    await expect(status).resolves.toBe(1)
    expect(closes).toBe(1)
    expect(stdout.value()).toBe('')
    expect(stderr.value()).toBe('TAS_STDIO_FAILED\n')
    expect(events.signals.listenerCount('SIGINT')).toBe(0)
    expect(events.stdin.listenerCount('end')).toBe(0)
  })
})

interface RunningChild {
  readonly child: ChildProcessWithoutNullStreams
  readonly request: (message: Record<string, unknown>) => Promise<Record<string, unknown>>
  readonly stdoutLines: readonly string[]
  readonly stderr: () => string
}

const children = new Set<ChildProcessWithoutNullStreams>()
afterEach(async () => {
  for (const child of children) child.kill('SIGKILL')
  children.clear()
})

function spawnTas(configPath: string, home: string, rpcUrl: string): RunningChild {
  const child = spawn(process.execPath, ['--import', 'tsx', sourceEntrypoint, '--config', configPath], {
    env: { ...process.env, HOME: home, TAS_RPC_URL: rpcUrl },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  children.add(child)
  const lines: string[] = []
  const responses = new Map<number, Record<string, unknown>>()
  const waiters = new Map<number, (value: Record<string, unknown>) => void>()
  let stdoutBuffer = ''
  let stderr = ''
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stdout.on('data', (chunk: string) => {
    stdoutBuffer += chunk
    while (stdoutBuffer.includes('\n')) {
      const index = stdoutBuffer.indexOf('\n')
      const line = stdoutBuffer.slice(0, index)
      stdoutBuffer = stdoutBuffer.slice(index + 1)
      if (line === '') continue
      lines.push(line)
      const message = JSON.parse(line) as Record<string, unknown>
      if (typeof message.id === 'number') {
        responses.set(message.id, message)
        waiters.get(message.id)?.(message)
        waiters.delete(message.id)
      }
    }
  })
  child.stderr.on('data', (chunk: string) => { stderr += chunk })

  return {
    child,
    stdoutLines: lines,
    stderr: () => stderr,
    request: async (message) => {
      const id = message.id
      if (typeof id !== 'number') throw new TypeError('request id required')
      child.stdin.write(`${JSON.stringify(message)}\n`)
      const existing = responses.get(id)
      if (existing) return existing
      return await new Promise<Record<string, unknown>>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error(`timed out waiting for ${id}; stderr=${stderr}`)), 5_000)
        waiters.set(id, (value) => { clearTimeout(timeout); resolve(value) })
      })
    },
  }
}

function modernMeta() {
  return {
    [PROTOCOL_VERSION_META_KEY]: '2026-07-28',
    [CLIENT_CAPABILITIES_META_KEY]: {},
  }
}

async function startCountingRpc() {
  let calls = 0
  const server = createServer(async (request, response) => {
    calls += 1
    for await (const _chunk of request) { /* drain */ }
    response.writeHead(500, { 'content-type': 'application/json' })
    response.end('{"error":"identity setup must not call RPC"}')
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('fixture did not bind TCP')
  return {
    calls: () => calls,
    url: `http://127.0.0.1:${address.port}/rpc?token=stdio-secret-marker`,
    close: async () => { await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())) },
  }
}

async function startProfileRpc(member: boolean) {
  const fixture = createProfileRpcFixture({ member })
  const server = createServer(async (request, response) => {
    let body = ''
    for await (const chunk of request) body += chunk.toString()
    const message = JSON.parse(body) as { id: number; jsonrpc: '2.0'; method: string; params?: readonly unknown[] }
    try {
      const result = await (fixture.client.request as (args: {
        method: string
        params?: readonly unknown[]
      }) => Promise<unknown>)({ method: message.method, ...(message.params === undefined ? {} : { params: message.params }) })
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }))
    } catch {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, error: { code: -32603, message: 'fixture failure' } }))
    }
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('fixture did not bind TCP')
  return {
    requests: fixture.requests,
    url: `http://127.0.0.1:${address.port}/rpc?token=profile-secret-marker`,
    close: async () => { await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())) },
  }
}

async function initializeLegacy(tas: RunningChild): Promise<void> {
  await tas.request({
    jsonrpc: '2.0', id: 1, method: 'initialize',
    params: { protocolVersion: '2026-07-28', capabilities: {}, clientInfo: { name: 'stdio-test', version: '1' } },
  })
  tas.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`)
}

async function waitForExit(child: ChildProcessWithoutNullStreams): Promise<number | null> {
  if (child.exitCode !== null) return child.exitCode
  return await new Promise<number | null>((resolve) => child.once('exit', resolve))
}

async function waitForPromptExit(child: ChildProcessWithoutNullStreams): Promise<number | null> {
  let timeout: NodeJS.Timeout | undefined
  try {
    return await Promise.race([
      waitForExit(child),
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error('TAS process did not exit promptly')), 5_000)
      }),
    ])
  } finally {
    if (timeout !== undefined) clearTimeout(timeout)
  }
}

describe('TAS stdio process', () => {
  it.each(['legacy', 'modern'] as const)('serves a frame-pure identity inventory over %s MCP and makes zero RPC calls', async (era) => {
    const fixture = temporaryConfig('identity_setup')
    const rpc = await startCountingRpc()
    const tas = spawnTas(fixture.path, fixture.root, rpc.url)
    try {
      if (era === 'legacy') {
        await tas.request({
          jsonrpc: '2.0', id: 1, method: 'initialize',
          params: { protocolVersion: '2026-07-28', capabilities: {}, clientInfo: { name: 'stdio-test', version: '1' } },
        })
        tas.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`)
        const listed = await tas.request({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} })
        expect((listed.result as { tools: Array<{ name: string }> }).tools.map(({ name }) => name).toSorted()).toEqual(expectedIdentityTools)
      } else {
        const listed = await tas.request({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: { _meta: modernMeta() } })
        expect((listed.result as { tools: Array<{ name: string }> }).tools.map(({ name }) => name).toSorted()).toEqual(expectedIdentityTools)
      }
      const call = await tas.request({
        jsonrpc: '2.0', id: 3, method: 'tools/call',
        params: { name: 'tas.get', arguments: {}, ...(era === 'modern' ? { _meta: modernMeta() } : {}) },
      })
      expect(call).toMatchObject({ result: { structuredContent: { data: {
        skill: { name: 'tas' },
        source: {
          kind: 'release', package: '@trustless-ai/tas', version: '0.1.0', path: 'skills/tas/SKILL.md',
          content_digest: { algorithm: 'sha256', value: expectedSkillDigest },
        },
        content: { media_type: 'text/markdown; charset=utf-8', encoding: 'utf8', value: expectedSkillContent },
      } } } })
      tas.child.stdin.end()
      const status = await new Promise<number | null>((resolve) => tas.child.once('exit', resolve))
      children.delete(tas.child)
      expect(status).toBe(0)
      expect(rpc.calls()).toBe(0)
      for (const line of tas.stdoutLines) expect(() => JSON.parse(line)).not.toThrow()
      expect(tas.stderr()).not.toContain(rpc.url)
      expect(tas.stderr()).not.toContain('stdio-secret-marker')
    } finally {
      tas.child.kill('SIGKILL')
      await rpc.close()
      rmSync(fixture.root, { force: true, recursive: true })
    }
  })

  it('serves TAWG Profile calls, owns no member directory, and releases on SIGINT', async () => {
    const fixture = temporaryConfig('tawg_setup')
    const rpc = await startProfileRpc(true)
    const tas = spawnTas(fixture.path, fixture.root, rpc.url)
    try {
      await initializeLegacy(tas)
      const listed = await tas.request({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} })
      expect((listed.result as { tools: Array<{ name: string }> }).tools.map(({ name }) => name).toSorted()).toEqual(expectedTawgTools)
      const profile = await tas.request({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'profile.get', arguments: {} } })
      expect(profile).toMatchObject({ result: { structuredContent: {
        context: { instance: { phase: 'tawg_setup', chain_id: '31337', tawg_address: fixtureProfileAddress } },
        data: { workflow: { data: { kind: 'demo' } } },
      } } })
      expect(rpc.requests.length).toBeGreaterThan(0)
      expect(existsSync(join(fixture.root, '.tas'))).toBe(false)

      tas.child.kill('SIGINT')
      expect(await waitForExit(tas.child)).toBe(0)
      children.delete(tas.child)
      for (const line of tas.stdoutLines) expect(() => JSON.parse(line)).not.toThrow()
      expect(tas.stderr()).not.toContain(rpc.url)
      expect(tas.stderr()).not.toContain('profile-secret-marker')
    } finally {
      tas.child.kill('SIGKILL')
      await rpc.close()
      rmSync(fixture.root, { force: true, recursive: true })
    }
  })

  it('excludes a second member process, returns nonmember data, and releases the lock on SIGTERM', async () => {
    const fixture = temporaryConfig('member')
    const rpc = await startProfileRpc(false)
    const first = spawnTas(fixture.path, fixture.root, rpc.url)
    let second: RunningChild | undefined
    let third: RunningChild | undefined
    try {
      const listed = await first.request({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: { _meta: modernMeta() } })
      expect((listed.result as { tools: Array<{ name: string }> }).tools.map(({ name }) => name).toSorted()).toEqual(expectedMemberTools)
      const nonmember = await first.request({
        jsonrpc: '2.0', id: 2, method: 'tools/call',
        params: {
          name: 'profile.get_agent', arguments: { agent_id: agentId }, _meta: modernMeta(),
        },
      })
      expect(nonmember).toMatchObject({ result: { structuredContent: { data: { agent_id: agentId, is_member: false } } } })
      expect((nonmember.result as { isError?: boolean }).isError).toBeUndefined()

      second = spawnTas(fixture.path, fixture.root, rpc.url)
      expect(await waitForExit(second.child)).toBe(1)
      children.delete(second.child)
      expect(second.child.stdout.readableLength).toBe(0)
      expect(second.stderr()).toContain('TAS_STARTUP_FAILED')
      expect(second.stderr()).not.toContain(rpc.url)
      expect(second.stderr()).not.toContain('profile-secret-marker')

      first.child.kill('SIGTERM')
      expect(await waitForExit(first.child)).toBe(0)
      children.delete(first.child)

      third = spawnTas(fixture.path, fixture.root, rpc.url)
      const afterRelease = await third.request({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: { _meta: modernMeta() } })
      expect(afterRelease).toHaveProperty('result')
      third.child.stdin.end()
      expect(await waitForExit(third.child)).toBe(0)
      children.delete(third.child)
    } finally {
      first.child.kill('SIGKILL')
      second?.child.kill('SIGKILL')
      third?.child.kill('SIGKILL')
      await rpc.close()
      rmSync(fixture.root, { force: true, recursive: true })
    }
  }, 15_000)

  it('fails safely on an oversized MCP frame and releases the member lock immediately', async () => {
    const fixture = temporaryConfig('member')
    const rpc = await startProfileRpc(false)
    const first = spawnTas(fixture.path, fixture.root, rpc.url)
    let next: RunningChild | undefined
    try {
      await initializeLegacy(first)
      const listed = await first.request({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} })
      expect(listed).toHaveProperty('result')

      const oversized = `${JSON.stringify({
        jsonrpc: '2.0', id: 99, method: 'tools/list', params: { padding: 'x'.repeat(10 * 1024 * 1024 + 1) },
      })}\n`
      first.child.stdin.on('error', () => {})
      first.child.stdin.end(oversized)

      expect(await waitForPromptExit(first.child)).toBe(1)
      children.delete(first.child)
      expect(first.stderr()).toBe('TAS_STDIO_FAILED\n')
      expect(first.stderr()).not.toContain(fixture.root)
      expect(first.stderr()).not.toContain(rpc.url)
      expect(first.stderr()).not.toContain('profile-secret-marker')
      for (const line of first.stdoutLines) expect(() => JSON.parse(line)).not.toThrow()

      next = spawnTas(fixture.path, fixture.root, rpc.url)
      const afterFailure = await next.request({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: { _meta: modernMeta() } })
      expect(afterFailure).toHaveProperty('result')
      next.child.stdin.end()
      expect(await waitForPromptExit(next.child)).toBe(0)
      children.delete(next.child)
    } finally {
      first.child.kill('SIGKILL')
      next?.child.kill('SIGKILL')
      await rpc.close()
      rmSync(fixture.root, { force: true, recursive: true })
    }
  }, 20_000)
})

// Keep imported stdio types checked against the release API used by the app seam.
const _stdioTypeCheck: ((factory: McpServerFactory, options?: ServeStdioOptions) => StdioServerHandle) | undefined = undefined
void _stdioTypeCheck
