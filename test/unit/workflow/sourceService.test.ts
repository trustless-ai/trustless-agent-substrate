import { describe, expect, it, vi } from 'vitest'

import { TasError } from '../../../src/core/errors.js'
import type { ChainSelector } from '../../../src/core/profile/types.js'
import type { RepositoryCredential, RepositorySource } from '../../../src/core/repository/types.js'
import {
  createWorkflowSourceRuntime,
  type WorkflowSourceRuntimeResolver,
} from '../../../src/core/workflow/sourceService.js'
import type {
  ResolvedWorkflowSource,
  WorkflowSourceDescriptor,
} from '../../../src/core/workflow/sourceResolver.js'
import type {
  WorkflowSourceVerifier,
  WorkflowVerificationIdentity,
  WorkflowVerificationResult,
} from '../../../src/core/workflow/sourceVerifier.js'
import type { VerifiedWorkflowContext } from '../../../src/core/workflow/types.js'

const rpcUrl = 'http://127.0.0.1:8545'
const workflowAddress = '0x1000000000000000000000000000000000000001' as const
const alternateAddress = '0x2000000000000000000000000000000000000002' as const

function hex32(character: string): `0x${string}` {
  return `0x${character.repeat(64)}`
}

function sha256(character: string): `sha256:${string}` {
  return `sha256:${character.repeat(64)}`
}

function repository(locator = 'https://github.com/trustless-ai/workflow' as const): RepositorySource {
  const [, owner = 'trustless-ai', name = 'workflow'] = /github\.com\/([^/]+)\/([^/]+)$/.exec(locator) ?? []
  return {
    provider: 'github',
    locator,
    owner,
    repository: name,
    profile: { blockNumber: '10', blockHash: hex32('a'), version: 'profile-1' },
    charter: { commit: '1'.repeat(40), path: 'charter/' },
  }
}

function descriptor(overrides: Partial<WorkflowSourceDescriptor> = {}): WorkflowSourceDescriptor {
  return {
    chainId: '31337',
    blockSelector: { kind: 'block_hash', blockHash: hex32('a') },
    profile: { blockNumber: '10', blockHash: hex32('a'), version: 'profile-1' },
    workflowAddress,
    repository: repository(),
    commit: '2'.repeat(40),
    sourcePath: 'src/Workflow.sol',
    metadataPath: 'artifacts/Workflow.metadata.json',
    ...overrides,
  }
}

function resolved(
  selected = descriptor(),
  sourceContent = '// verified Workflow source',
): ResolvedWorkflowSource {
  const bytes = new TextEncoder().encode(sourceContent)
  const sourceUnit = {
    path: selected.sourcePath,
    bytes,
    text: sourceContent,
    keccak256: hex32('3'),
    expectedKeccak256: hex32('3'),
  }
  return {
    ...selected,
    contractName: 'Workflow',
    compiler: { version: '0.8.30+commit.73712a01' },
    metadata: {
      compiler: { version: '0.8.30+commit.73712a01' },
      language: 'Solidity',
      settings: {},
      sources: {},
      version: 1,
    },
    settings: {},
    metadataFile: {
      bytes: new Uint8Array([123, 125]),
      text: '{}',
      sha256: sha256('4'),
    },
    source: sourceUnit,
    sourceUnits: { [selected.sourcePath]: sourceUnit },
  }
}

function verification(
  selected = descriptor(),
  overrides: Partial<WorkflowVerificationResult> = {},
): WorkflowVerificationResult {
  return {
    valid: true,
    reason: 'verified',
    fingerprint: sha256('5'),
    compiler: { version: '0.8.30+commit.73712a01', settingsHash: sha256('6') },
    source: {
      keccak256: hex32('3'),
      closureHash: sha256('7'),
      metadataSha256: sha256('4'),
    },
    deployedCodeHash: hex32('8'),
    context: {
      chainId: selected.chainId,
      blockNumber: selected.profile.blockNumber,
      blockHash: selected.blockSelector.blockHash,
      profileVersion: selected.profile.version,
      workflowAddress: selected.workflowAddress,
      repository: selected.repository.locator,
      commit: selected.commit,
      sourcePath: selected.sourcePath,
      metadataPath: selected.metadataPath,
    },
    ...overrides,
  } as WorkflowVerificationResult
}

function context(result = verification()): VerifiedWorkflowContext {
  return {
    chainId: result.context.chainId,
    rpcUrl,
    workflowAddress: result.context.workflowAddress,
    blockSelector: { kind: 'block_hash', blockHash: result.context.blockHash },
    fingerprint: result.fingerprint,
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

function abortError(): Error {
  const error = new Error('aborted')
  error.name = 'AbortError'
  return error
}

function expectCode(code: string) {
  return (error: unknown): boolean => error instanceof TasError && error.code === code
}

interface Harness {
  selected: WorkflowSourceDescriptor
  source: ResolvedWorkflowSource
  result: WorkflowVerificationResult
  resolver: WorkflowSourceRuntimeResolver
  verifier: WorkflowSourceVerifier
  discover: ReturnType<typeof vi.fn>
  materialize: ReturnType<typeof vi.fn>
  resolve: ReturnType<typeof vi.fn>
  identify: ReturnType<typeof vi.fn>
  identifyDeployment: ReturnType<typeof vi.fn>
  verify: ReturnType<typeof vi.fn>
}

function harness(): Harness {
  const selected = descriptor()
  const source = resolved(selected)
  const result = verification(selected)
  const discover = vi.fn(async (_selector: ChainSelector) => selected)
  const materialize = vi.fn(async () => source)
  const resolve = vi.fn(async () => source)
  const identify = vi.fn(async () => result as WorkflowVerificationIdentity)
  const identifyDeployment = vi.fn(async () => ({ deployedCodeHash: result.deployedCodeHash }))
  const verify = vi.fn(async () => result)
  return {
    selected,
    source,
    result,
    discover,
    materialize,
    resolve,
    identify,
    identifyDeployment,
    verify,
    resolver: { discover, materialize, resolve },
    verifier: { identify, identifyDeployment, verify },
  }
}

describe('Workflow source runtime', () => {
  it('shares one materialize and verify pipeline for two exact descriptor and credential identities', async () => {
    const fake = harness()
    const pending = deferred<ResolvedWorkflowSource>()
    fake.materialize.mockImplementation(async () => await pending.promise)
    const runtime = createWorkflowSourceRuntime({ resolver: fake.resolver, verifier: fake.verifier, rpcUrl })
    const credential: RepositoryCredential = { type: 'inline', secret: 'same-private-token' }

    const first = runtime.service.verify({ credential })
    const second = runtime.service.verify({ credential: { ...credential } })
    await vi.waitFor(() => expect(fake.materialize).toHaveBeenCalledTimes(1))

    pending.resolve(fake.source)
    await expect(Promise.all([first, second])).resolves.toEqual([fake.result, fake.result])
    expect(fake.verify).toHaveBeenCalledTimes(1)
    expect(fake.materialize).toHaveBeenCalledWith(fake.selected, credential, { signal: expect.any(AbortSignal) })
  })

  it('fails fast when another descriptor or credential arrives during a verification', async () => {
    const fake = harness()
    const pending = deferred<ResolvedWorkflowSource>()
    const other = descriptor({ sourcePath: 'src/OtherWorkflow.sol' })
    fake.discover.mockImplementation(async (selector: ChainSelector) => (
      selector.kind === 'safe' ? other : fake.selected
    ))
    fake.materialize.mockImplementation(async () => await pending.promise)
    const runtime = createWorkflowSourceRuntime({ resolver: fake.resolver, verifier: fake.verifier, rpcUrl })

    const active = runtime.service.verify({ credential: { type: 'inline', secret: 'first' } })
    await vi.waitFor(() => expect(fake.materialize).toHaveBeenCalledTimes(1))

    await expect(runtime.service.verify({
      selector: { kind: 'safe' },
      credential: { type: 'inline', secret: 'first' },
    })).rejects.toSatisfy(expectCode('WORKFLOW_COMPILER_BUSY'))
    await expect(runtime.service.verify({ credential: { type: 'inline', secret: 'other' } }))
      .rejects.toSatisfy(expectCode('WORKFLOW_COMPILER_BUSY'))

    pending.resolve(fake.source)
    await active
  })

  it('bounds a shared verification to two subscribers', async () => {
    const fake = harness()
    const pending = deferred<ResolvedWorkflowSource>()
    fake.materialize.mockImplementation(async () => await pending.promise)
    const runtime = createWorkflowSourceRuntime({ resolver: fake.resolver, verifier: fake.verifier, rpcUrl })

    const first = runtime.service.verify()
    const second = runtime.service.verify()
    await vi.waitFor(() => expect(fake.materialize).toHaveBeenCalledTimes(1))
    await expect(runtime.service.verify()).rejects.toSatisfy(expectCode('WORKFLOW_COMPILER_BUSY'))

    pending.resolve(fake.source)
    await Promise.all([first, second])
  })

  it('detaches one cancelled subscriber without cancelling the shared work', async () => {
    const fake = harness()
    const pending = deferred<ResolvedWorkflowSource>()
    let underlyingAborted = false
    fake.materialize.mockImplementation(async (_descriptor, _credential, options) => {
      options?.signal?.addEventListener('abort', () => { underlyingAborted = true }, { once: true })
      return await pending.promise
    })
    const runtime = createWorkflowSourceRuntime({ resolver: fake.resolver, verifier: fake.verifier, rpcUrl })
    const cancellation = new AbortController()

    const cancelled = runtime.service.verify({ signal: cancellation.signal })
    const surviving = runtime.service.verify()
    await vi.waitFor(() => expect(fake.materialize).toHaveBeenCalledTimes(1))
    cancellation.abort()

    await expect(cancelled).rejects.toMatchObject({ name: 'AbortError' })
    expect(underlyingAborted).toBe(false)
    pending.resolve(fake.source)
    await expect(surviving).resolves.toEqual(fake.result)
  })

  it('aborts the shared pipeline after all subscribers detach', async () => {
    const fake = harness()
    let underlyingAborted = false
    fake.materialize.mockImplementation(async (_descriptor, _credential, options) => await new Promise(
      (_resolve, reject) => options?.signal?.addEventListener('abort', () => {
        underlyingAborted = true
        reject(abortError())
      }, { once: true }),
    ))
    const runtime = createWorkflowSourceRuntime({ resolver: fake.resolver, verifier: fake.verifier, rpcUrl })
    const firstCancellation = new AbortController()
    const secondCancellation = new AbortController()

    const first = runtime.service.verify({ signal: firstCancellation.signal })
    const second = runtime.service.verify({ signal: secondCancellation.signal })
    await vi.waitFor(() => expect(fake.materialize).toHaveBeenCalledTimes(1))
    firstCancellation.abort()
    await expect(first).rejects.toMatchObject({ name: 'AbortError' })
    expect(underlyingAborted).toBe(false)
    secondCancellation.abort()

    await expect(second).rejects.toMatchObject({ name: 'AbortError' })
    await vi.waitFor(() => expect(underlyingAborted).toBe(true))
  })

  it('starts the total deadline before discovery and maps expiry to source unavailable', async () => {
    const fake = harness()
    fake.discover.mockImplementation(async (_selector: ChainSelector, options?: { signal?: AbortSignal }) => await new Promise(
      (_resolve, reject) => options?.signal?.addEventListener('abort', () => reject(abortError()), { once: true }),
    ))
    const runtime = createWorkflowSourceRuntime({
      resolver: fake.resolver,
      verifier: fake.verifier,
      rpcUrl,
      timeoutMs: 10,
    })

    await expect(runtime.service.verify()).rejects.toSatisfy(expectCode('WORKFLOW_SOURCE_UNAVAILABLE'))
    expect(fake.materialize).not.toHaveBeenCalled()
  })

  it('observes discovery rejection when verify starts with an already-aborted signal', async () => {
    const fake = harness()
    fake.discover.mockImplementationOnce(async () => { throw abortError() })
    const runtime = createWorkflowSourceRuntime({ resolver: fake.resolver, verifier: fake.verifier, rpcUrl })
    const cancellation = new AbortController()
    cancellation.abort()

    await expect(runtime.service.verify({ signal: cancellation.signal })).rejects.toMatchObject({ name: 'AbortError' })
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
    expect(fake.discover).toHaveBeenCalledOnce()
    expect(fake.materialize).not.toHaveBeenCalled()
  })

  it('accepts only valid verification without letting request-specific failures erase unrelated accepted state', async () => {
    const fake = harness()
    const runtime = createWorkflowSourceRuntime({ resolver: fake.resolver, verifier: fake.verifier, rpcUrl })

    await expect(runtime.service.verify()).resolves.toMatchObject({ valid: true })
    expect(runtime.gate.assertAccepted(context(fake.result))).toMatchObject({ fingerprint: fake.result.fingerprint })

    const invalid = verification(fake.selected, { valid: false, reason: 'runtime_mismatch' })
    fake.verify.mockResolvedValueOnce(invalid)
    await expect(runtime.service.verify()).resolves.toMatchObject({ valid: false })
    expect(() => runtime.gate.assertAccepted(context(fake.result))).toThrowError(TasError)

    fake.verify.mockResolvedValueOnce(fake.result)
    await runtime.service.verify()
    fake.verify.mockRejectedValueOnce(new TasError('WORKFLOW_COMPILE_FAILED', 'failed'))
    await expect(runtime.service.verify()).rejects.toSatisfy(expectCode('WORKFLOW_COMPILE_FAILED'))
    expect(runtime.gate.assertAccepted(context(fake.result))).toMatchObject({ fingerprint: fake.result.fingerprint })
  })

  it('does not let a cancelled redundant verification erase accepted state', async () => {
    const fake = harness()
    const runtime = createWorkflowSourceRuntime({ resolver: fake.resolver, verifier: fake.verifier, rpcUrl })
    await runtime.service.verify()
    fake.materialize.mockImplementationOnce(async (_descriptor, _credential, options) => await new Promise(
      (_resolve, reject) => options?.signal?.addEventListener('abort', () => reject(abortError()), { once: true }),
    ))
    const cancellation = new AbortController()

    const pending = runtime.service.verify({ signal: cancellation.signal })
    await vi.waitFor(() => expect(fake.materialize).toHaveBeenCalledTimes(2))
    cancellation.abort()

    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    expect(runtime.gate.assertAccepted(context(fake.result))).toMatchObject({ fingerprint: fake.result.fingerprint })
  })

  it('freshly resolves and identifies get without compiling or releasing source before acceptance', async () => {
    const fake = harness()
    const runtime = createWorkflowSourceRuntime({ resolver: fake.resolver, verifier: fake.verifier, rpcUrl })

    await expect(runtime.service.get()).rejects.toSatisfy(expectCode('WORKFLOW_SOURCE_VERIFICATION_REQUIRED'))
    expect(fake.resolve).toHaveBeenCalledTimes(1)
    expect(fake.identify).toHaveBeenCalledTimes(1)
    expect(fake.verify).not.toHaveBeenCalled()

    await runtime.service.verify()
    const verifyCalls = fake.verify.mock.calls.length
    const freshSource = resolved(fake.selected, '// freshly resolved source')
    fake.resolve.mockResolvedValueOnce(freshSource)

    await expect(runtime.service.get()).resolves.toEqual({
      ...fake.result,
      sourceContent: '// freshly resolved source',
    })
    expect(fake.verify).toHaveBeenCalledTimes(verifyCalls)
  })

  it('returns the fresh block and Profile context when unchanged material remains accepted', async () => {
    const fake = harness()
    const runtime = createWorkflowSourceRuntime({ resolver: fake.resolver, verifier: fake.verifier, rpcUrl })
    await runtime.service.verify()
    const laterDescriptor = descriptor({
      blockSelector: { kind: 'block_hash', blockHash: hex32('b') },
      profile: { blockNumber: '11', blockHash: hex32('b'), version: 'profile-2' },
    })
    const laterIdentity: WorkflowVerificationIdentity = {
      ...fake.result,
      context: {
        ...fake.result.context,
        blockNumber: laterDescriptor.profile.blockNumber,
        blockHash: laterDescriptor.profile.blockHash,
        profileVersion: laterDescriptor.profile.version,
      },
    }
    fake.resolve.mockResolvedValueOnce(resolved(laterDescriptor, '// later source snapshot'))
    fake.identify.mockResolvedValueOnce(laterIdentity)

    await expect(runtime.service.get()).resolves.toMatchObject({
      fingerprint: fake.result.fingerprint,
      context: { blockNumber: '11', blockHash: hex32('b'), profileVersion: 'profile-2' },
      sourceContent: '// later source snapshot',
    })
  })

  it('reuses an accepted fingerprint across block and Profile-version-only changes', async () => {
    const fake = harness()
    let current = fake.selected
    fake.discover.mockImplementation(async () => current)
    const runtime = createWorkflowSourceRuntime({ resolver: fake.resolver, verifier: fake.verifier, rpcUrl })
    await runtime.service.verify()

    current = descriptor({
      blockSelector: { kind: 'block_hash', blockHash: hex32('b') },
      profile: { blockNumber: '11', blockHash: hex32('b'), version: 'profile-2' },
      repository: {
        ...fake.selected.repository,
        profile: { blockNumber: '11', blockHash: hex32('b'), version: 'profile-2' },
      },
    })

    await expect(runtime.gate.assertCurrent()).resolves.toEqual({
      ...context(fake.result),
      blockSelector: current.blockSelector,
    })
    expect(fake.identifyDeployment).toHaveBeenCalledWith({
      chainId: current.chainId,
      workflowAddress: current.workflowAddress,
      blockHash: current.blockSelector.blockHash,
    }, { signal: expect.any(AbortSignal) })
    expect(fake.discover.mock.calls.at(-1)?.[1]).toEqual({ signal: expect.any(AbortSignal) })
  })

  it('invalidates accepted state when the material locator or deployed runtime changes', async () => {
    const fake = harness()
    let current = fake.selected
    fake.discover.mockImplementation(async () => current)
    const runtime = createWorkflowSourceRuntime({ resolver: fake.resolver, verifier: fake.verifier, rpcUrl })
    await runtime.service.verify()

    current = descriptor({
      repository: repository('https://github.com/trustless-ai/other-workflow'),
    })
    await expect(runtime.gate.assertCurrent()).rejects.toSatisfy(expectCode('WORKFLOW_SOURCE_VERIFICATION_REQUIRED'))
    current = fake.selected
    await expect(runtime.gate.assertCurrent()).rejects.toSatisfy(expectCode('WORKFLOW_SOURCE_VERIFICATION_REQUIRED'))

    await runtime.service.verify()
    fake.identifyDeployment.mockResolvedValueOnce({ deployedCodeHash: hex32('9') })
    await expect(runtime.gate.assertCurrent()).rejects.toSatisfy(expectCode('WORKFLOW_SOURCE_VERIFICATION_REQUIRED'))
  })

  it('does not let an older current-state assertion erase a newer successful verification', async () => {
    const fake = harness()
    const runtime = createWorkflowSourceRuntime({ resolver: fake.resolver, verifier: fake.verifier, rpcUrl })
    await runtime.service.verify()
    const pendingDiscovery = deferred<WorkflowSourceDescriptor>()
    fake.discover.mockImplementationOnce(async () => await pendingDiscovery.promise)

    const olderAssertion = runtime.gate.assertCurrent()
    await vi.waitFor(() => expect(fake.discover).toHaveBeenCalledTimes(2))
    const newer = verification(fake.selected, { fingerprint: sha256('a') })
    fake.verify.mockResolvedValueOnce(newer)
    await runtime.service.verify()
    pendingDiscovery.resolve(fake.selected)

    await expect(olderAssertion).rejects.toSatisfy(expectCode('WORKFLOW_SOURCE_VERIFICATION_REQUIRED'))
    await expect(runtime.gate.assertCurrent()).resolves.toMatchObject({ fingerprint: newer.fingerprint })
  })

  it('does not let a stale runtime mismatch erase a newer successful verification', async () => {
    const fake = harness()
    const runtime = createWorkflowSourceRuntime({ resolver: fake.resolver, verifier: fake.verifier, rpcUrl })
    await runtime.service.verify()
    const pendingDeployment = deferred<{ deployedCodeHash: `0x${string}` }>()
    fake.identifyDeployment.mockImplementationOnce(async () => await pendingDeployment.promise)

    const olderAssertion = runtime.gate.assertCurrent()
    await vi.waitFor(() => expect(fake.identifyDeployment).toHaveBeenCalledTimes(1))
    const newer = verification(fake.selected, { fingerprint: sha256('a') })
    fake.verify.mockResolvedValueOnce(newer)
    await runtime.service.verify()
    pendingDeployment.resolve({ deployedCodeHash: hex32('9') })

    await expect(olderAssertion).rejects.toSatisfy(expectCode('WORKFLOW_SOURCE_VERIFICATION_REQUIRED'))
    await expect(runtime.gate.assertCurrent()).resolves.toMatchObject({ fingerprint: newer.fingerprint })
  })

  it('does not let a stale get invalidate a newer successful verification', async () => {
    const fake = harness()
    const runtime = createWorkflowSourceRuntime({ resolver: fake.resolver, verifier: fake.verifier, rpcUrl })
    await runtime.service.verify()
    const pendingIdentity = deferred<WorkflowVerificationIdentity>()
    fake.identify.mockImplementationOnce(async () => await pendingIdentity.promise)

    const staleGet = runtime.service.get()
    await vi.waitFor(() => expect(fake.identify).toHaveBeenCalledTimes(1))
    const newer = verification(fake.selected, { fingerprint: sha256('a') })
    fake.verify.mockResolvedValueOnce(newer)
    await runtime.service.verify()
    pendingIdentity.resolve(fake.result)

    await expect(staleGet).rejects.toSatisfy(expectCode('WORKFLOW_SOURCE_VERIFICATION_REQUIRED'))
    await expect(runtime.gate.assertCurrent()).resolves.toMatchObject({ fingerprint: newer.fingerprint })
  })

  it('does not retain or expose credentials or materialized source after settlement', async () => {
    const fake = harness()
    const secret = 'never-retain-this-private-token'
    const sourceText = fake.source.source.text
    const runtime = createWorkflowSourceRuntime({ resolver: fake.resolver, verifier: fake.verifier, rpcUrl })

    const result = await runtime.service.verify({ credential: { type: 'inline', secret } })

    expect(JSON.stringify(runtime)).not.toContain(secret)
    expect(JSON.stringify(runtime)).not.toContain(sourceText)
    expect(JSON.stringify(result)).not.toContain(secret)
    expect(JSON.stringify(result)).not.toContain(sourceText)
    fake.resolve.mockResolvedValueOnce(resolved(fake.selected, '// retrieved again'))
    await expect(runtime.service.get({ credential: { type: 'inline', secret } }))
      .resolves.toMatchObject({ sourceContent: '// retrieved again' })
    expect(fake.resolve).toHaveBeenCalledWith(
      { kind: 'latest' },
      { type: 'inline', secret },
      { signal: expect.any(AbortSignal) },
    )
  })

  it('close aborts an active flight and invalidates accepted state', async () => {
    const fake = harness()
    let underlyingAborted = false
    fake.materialize.mockImplementation(async (_descriptor, _credential, options) => await new Promise(
      (_resolve, reject) => options?.signal?.addEventListener('abort', () => {
        underlyingAborted = true
        reject(abortError())
      }, { once: true }),
    ))
    const runtime = createWorkflowSourceRuntime({ resolver: fake.resolver, verifier: fake.verifier, rpcUrl })

    const pending = runtime.service.verify()
    await vi.waitFor(() => expect(fake.materialize).toHaveBeenCalledTimes(1))
    await runtime.close()

    await expect(pending).rejects.toSatisfy(expectCode('WORKFLOW_SOURCE_UNAVAILABLE'))
    expect(underlyingAborted).toBe(true)
    expect(() => runtime.gate.assertAccepted(context(fake.result))).toThrowError(TasError)
    await expect(runtime.service.verify()).rejects.toSatisfy(expectCode('WORKFLOW_SOURCE_UNAVAILABLE'))
  })

  it('does not complete close until an abort-ignoring active verification flight settles', async () => {
    const fake = harness()
    const materialized = deferred<ResolvedWorkflowSource>()
    fake.materialize.mockImplementationOnce(async () => await materialized.promise)
    const runtime = createWorkflowSourceRuntime({ resolver: fake.resolver, verifier: fake.verifier, rpcUrl })
    const pending = runtime.service.verify()
    const pendingOutcome = pending.then(
      () => undefined,
      (error: unknown) => error,
    )
    await vi.waitFor(() => expect(fake.materialize).toHaveBeenCalledOnce())
    let closeSettled = false

    const closing = runtime.close().then(() => { closeSettled = true })
    await Promise.resolve()
    expect(closeSettled).toBe(false)

    materialized.resolve(fake.source)
    await closing
    expect(await pendingOutcome).toSatisfy(expectCode('WORKFLOW_SOURCE_UNAVAILABLE'))
    expect(closeSettled).toBe(true)
  })

  it('close aborts verification discovery before a flight exists', async () => {
    const fake = harness()
    let discoveryAborted = false
    fake.discover.mockImplementationOnce(async (_selector, options) => await new Promise(
      (_resolve, reject) => options?.signal?.addEventListener('abort', () => {
        discoveryAborted = true
        reject(abortError())
      }, { once: true }),
    ))
    const runtime = createWorkflowSourceRuntime({ resolver: fake.resolver, verifier: fake.verifier, rpcUrl })

    const pending = runtime.service.verify()
    await vi.waitFor(() => expect(fake.discover).toHaveBeenCalledTimes(1))
    await runtime.close()

    await expect(pending).rejects.toSatisfy(expectCode('WORKFLOW_SOURCE_UNAVAILABLE'))
    expect(discoveryAborted).toBe(true)
    expect(fake.materialize).not.toHaveBeenCalled()
  })

  it('close aborts a pending get resolution', async () => {
    const fake = harness()
    let resolutionAborted = false
    fake.resolve.mockImplementationOnce(async (_selector, _credential, options) => await new Promise(
      (_resolve, reject) => options?.signal?.addEventListener('abort', () => {
        resolutionAborted = true
        reject(abortError())
      }, { once: true }),
    ))
    const runtime = createWorkflowSourceRuntime({ resolver: fake.resolver, verifier: fake.verifier, rpcUrl })

    const pending = runtime.service.get()
    await vi.waitFor(() => expect(fake.resolve).toHaveBeenCalledTimes(1))
    await runtime.close()

    await expect(pending).rejects.toSatisfy(expectCode('WORKFLOW_SOURCE_UNAVAILABLE'))
    expect(resolutionAborted).toBe(true)
  })

  it('close aborts a pending current-state gate check', async () => {
    const fake = harness()
    const runtime = createWorkflowSourceRuntime({ resolver: fake.resolver, verifier: fake.verifier, rpcUrl })
    await runtime.service.verify()
    let discoveryAborted = false
    fake.discover.mockImplementationOnce(async (_selector, options) => await new Promise(
      (_resolve, reject) => options?.signal?.addEventListener('abort', () => {
        discoveryAborted = true
        reject(abortError())
      }, { once: true }),
    ))

    const pending = runtime.gate.assertCurrent()
    await vi.waitFor(() => expect(fake.discover).toHaveBeenCalledTimes(2))
    await runtime.close()

    await expect(pending).rejects.toSatisfy(expectCode('WORKFLOW_SOURCE_UNAVAILABLE'))
    expect(discoveryAborted).toBe(true)
  })

  it('treats an address change as material even when the runtime hash is unchanged', async () => {
    const fake = harness()
    let current = fake.selected
    fake.discover.mockImplementation(async () => current)
    const runtime = createWorkflowSourceRuntime({ resolver: fake.resolver, verifier: fake.verifier, rpcUrl })
    await runtime.service.verify()

    current = descriptor({ workflowAddress: alternateAddress })
    await expect(runtime.gate.assertCurrent()).rejects.toSatisfy(expectCode('WORKFLOW_SOURCE_VERIFICATION_REQUIRED'))
  })
})
