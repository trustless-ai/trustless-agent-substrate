import { createHash } from 'node:crypto'

import type { ChainSelector } from '../profile/types.js'
import type { RepositoryReadOptions } from '../repository/client.js'
import type { RepositoryCredential } from '../repository/types.js'
import { TasError } from '../errors.js'
import { createWorkflowSourceGate } from './sourceGate.js'
import type {
  ResolvedWorkflowSource,
  WorkflowSourceDescriptor,
} from './sourceResolver.js'
import type {
  WorkflowSourceVerifier,
  WorkflowVerificationIdentity,
  WorkflowVerificationResult,
} from './sourceVerifier.js'
import type {
  MutableWorkflowVerificationGate,
  VerifiedWorkflowContext,
} from './types.js'

const defaultTimeoutMs = 30_000
const maxFlightSubscribers = 2

type ValidWorkflowVerificationResult = Extract<WorkflowVerificationResult, { readonly valid: true }>

export interface WorkflowSourceRuntimeResolver {
  discover(
    selector: ChainSelector,
    options?: RepositoryReadOptions,
  ): Promise<WorkflowSourceDescriptor>
  materialize(
    descriptor: WorkflowSourceDescriptor,
    credential?: RepositoryCredential,
    options?: RepositoryReadOptions,
  ): Promise<ResolvedWorkflowSource>
  resolve(
    selector: ChainSelector,
    credential?: RepositoryCredential,
    options?: RepositoryReadOptions,
  ): Promise<ResolvedWorkflowSource>
}

export interface WorkflowSourceServiceInput {
  readonly selector?: ChainSelector
  readonly credential?: RepositoryCredential
  readonly signal?: AbortSignal
}

export type WorkflowSourceGetResult = ValidWorkflowVerificationResult & {
  readonly sourceContent: string
}

export interface WorkflowSourceService {
  verify(input?: WorkflowSourceServiceInput): Promise<WorkflowVerificationResult>
  get(input?: WorkflowSourceServiceInput): Promise<WorkflowSourceGetResult>
}

export interface WorkflowSourceRuntimeOptions {
  readonly resolver: WorkflowSourceRuntimeResolver
  readonly verifier: WorkflowSourceVerifier
  readonly rpcUrl: string
  readonly timeoutMs?: number
}

export interface WorkflowSourceRuntime {
  readonly service: WorkflowSourceService
  readonly gate: MutableWorkflowVerificationGate
  close(): Promise<void>
}

interface AcceptedVerification {
  readonly descriptor: WorkflowSourceDescriptor
  readonly result: ValidWorkflowVerificationResult
}

interface VerificationFlight {
  readonly key: string
  readonly controller: AbortController
  readonly subscribers: Set<symbol>
  promise: Promise<WorkflowVerificationResult>
  settled: boolean
}

interface RequestDeadline {
  readonly signal: AbortSignal
  readonly timedOut: () => boolean
  readonly shutDown: () => boolean
  dispose(): void
}

function sourceUnavailable(): TasError {
  return new TasError(
    'WORKFLOW_SOURCE_UNAVAILABLE',
    'The Profile-selected Workflow source is unavailable.',
  )
}

function compilerBusy(): TasError {
  return new TasError(
    'WORKFLOW_COMPILER_BUSY',
    'The Workflow compiler is busy with another verification.',
  )
}

function verificationRequired(): TasError {
  return new TasError(
    'WORKFLOW_SOURCE_VERIFICATION_REQUIRED',
    'The current Workflow source must be verified before this operation can run.',
  )
}

function aborted(): Error {
  const error = new Error('The Workflow source request was aborted.')
  error.name = 'AbortError'
  return error
}

function digest(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

function credentialIdentity(credential: RepositoryCredential | undefined): string {
  return credential === undefined
    ? digest('credential:none')
    : digest(`credential:${credential.type}:${credential.secret}`)
}

function descriptorIdentity(descriptor: WorkflowSourceDescriptor): string {
  return JSON.stringify({
    chainId: descriptor.chainId,
    blockSelectorKind: descriptor.blockSelector.kind,
    blockHash: descriptor.blockSelector.blockHash,
    profileBlockNumber: descriptor.profile.blockNumber,
    profileBlockHash: descriptor.profile.blockHash,
    profileVersion: descriptor.profile.version,
    workflowAddress: descriptor.workflowAddress.toLowerCase(),
    repositoryProvider: descriptor.repository.provider,
    repositoryLocator: descriptor.repository.locator,
    repositoryOwner: descriptor.repository.owner,
    repositoryName: descriptor.repository.repository,
    repositoryProfileBlockNumber: descriptor.repository.profile.blockNumber,
    repositoryProfileBlockHash: descriptor.repository.profile.blockHash,
    repositoryProfileVersion: descriptor.repository.profile.version,
    charterCommit: descriptor.repository.charter.commit,
    charterPath: descriptor.repository.charter.path,
    commit: descriptor.commit,
    sourcePath: descriptor.sourcePath,
    metadataPath: descriptor.metadataPath,
  })
}

function materialIdentity(descriptor: WorkflowSourceDescriptor): string {
  return JSON.stringify({
    chainId: descriptor.chainId,
    workflowAddress: descriptor.workflowAddress.toLowerCase(),
    repositoryProvider: descriptor.repository.provider,
    repositoryLocator: descriptor.repository.locator,
    repositoryOwner: descriptor.repository.owner,
    repositoryName: descriptor.repository.repository,
    commit: descriptor.commit,
    sourcePath: descriptor.sourcePath,
    metadataPath: descriptor.metadataPath,
  })
}

function flightIdentity(
  descriptor: WorkflowSourceDescriptor,
  credential: RepositoryCredential | undefined,
): string {
  return digest(`${descriptorIdentity(descriptor)}\n${credentialIdentity(credential)}`)
}

function snapshotDescriptor(descriptor: WorkflowSourceDescriptor): WorkflowSourceDescriptor {
  return Object.freeze({
    chainId: descriptor.chainId,
    blockSelector: Object.freeze({ ...descriptor.blockSelector }),
    profile: Object.freeze({ ...descriptor.profile }),
    workflowAddress: descriptor.workflowAddress,
    repository: Object.freeze({
      provider: descriptor.repository.provider,
      locator: descriptor.repository.locator,
      owner: descriptor.repository.owner,
      repository: descriptor.repository.repository,
      profile: Object.freeze({ ...descriptor.repository.profile }),
      charter: Object.freeze({ ...descriptor.repository.charter }),
    }),
    commit: descriptor.commit,
    sourcePath: descriptor.sourcePath,
    metadataPath: descriptor.metadataPath,
  })
}

function verifiedResult(
  result: WorkflowVerificationIdentity,
): ValidWorkflowVerificationResult {
  return Object.freeze({
    valid: true,
    reason: 'verified',
    fingerprint: result.fingerprint,
    compiler: Object.freeze({ ...result.compiler }),
    source: Object.freeze({ ...result.source }),
    deployedCodeHash: result.deployedCodeHash,
    context: Object.freeze({ ...result.context }),
  })
}

function verificationContext(
  identity: WorkflowVerificationIdentity,
  rpcUrl: string,
): VerifiedWorkflowContext {
  return {
    chainId: identity.context.chainId,
    rpcUrl,
    workflowAddress: identity.context.workflowAddress,
    blockSelector: { kind: 'block_hash', blockHash: identity.context.blockHash },
    fingerprint: identity.fingerprint,
  }
}

function createDeadline(
  signal: AbortSignal | undefined,
  shutdownSignal: AbortSignal,
  timeoutMs: number,
): RequestDeadline {
  const controller = new AbortController()
  let expired = false
  let shutdown = false
  const onCallerAbort = (): void => controller.abort()
  const onShutdown = (): void => {
    shutdown = true
    controller.abort()
  }
  if (signal?.aborted) controller.abort()
  else signal?.addEventListener('abort', onCallerAbort, { once: true })
  if (shutdownSignal.aborted) onShutdown()
  else shutdownSignal.addEventListener('abort', onShutdown, { once: true })

  const timer = setTimeout(() => {
    expired = true
    controller.abort()
  }, timeoutMs)
  timer.unref()

  return {
    signal: controller.signal,
    timedOut: () => expired,
    shutDown: () => shutdown,
    dispose(): void {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onCallerAbort)
      shutdownSignal.removeEventListener('abort', onShutdown)
    },
  }
}

function requestAbortError(deadline: RequestDeadline): Error {
  return deadline.timedOut() || deadline.shutDown() ? sourceUnavailable() : aborted()
}

function awaitWithinDeadline<T>(
  operation: Promise<T>,
  deadline: RequestDeadline,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false
    const finish = (callback: () => void): void => {
      if (settled) return
      settled = true
      deadline.signal.removeEventListener('abort', onAbort)
      callback()
    }
    const onAbort = (): void => finish(() => reject(requestAbortError(deadline)))
    operation.then(
      (value) => finish(() => resolve(value)),
      (error: unknown) => finish(() => reject(
        deadline.signal.aborted ? requestAbortError(deadline) : error,
      )),
    )
    deadline.signal.addEventListener('abort', onAbort, { once: true })
    if (deadline.signal.aborted) onAbort()
  })
}

function isVerificationRequired(error: unknown): boolean {
  return error instanceof TasError && error.code === 'WORKFLOW_SOURCE_VERIFICATION_REQUIRED'
}

export function createWorkflowSourceRuntime(
  options: WorkflowSourceRuntimeOptions,
): WorkflowSourceRuntime {
  const { resolver, verifier, rpcUrl } = options
  const timeoutMs = options.timeoutMs ?? defaultTimeoutMs
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || rpcUrl.length === 0) {
    throw new RangeError('Workflow source runtime options are invalid.')
  }

  let closed = false
  let closePromise: Promise<void> | undefined
  const shutdownController = new AbortController()
  let accepted: AcceptedVerification | undefined
  let activeFlight: VerificationFlight | undefined

  const sharedGate = createWorkflowSourceGate({
    resolveCurrent: async (signal?: AbortSignal): Promise<VerifiedWorkflowContext> => {
      const expected = accepted
      if (expected === undefined) throw verificationRequired()
      const current = await resolver.discover({ kind: 'latest' }, { signal })
      const deployment = await verifier.identifyDeployment({
        chainId: current.chainId,
        workflowAddress: current.workflowAddress,
        blockHash: current.blockSelector.blockHash,
      }, { signal })
      const matches = materialIdentity(current) === materialIdentity(expected.descriptor)
        && deployment.deployedCodeHash === expected.result.deployedCodeHash
      return {
        chainId: current.chainId,
        rpcUrl,
        workflowAddress: current.workflowAddress,
        blockSelector: current.blockSelector,
        fingerprint: matches
          ? expected.result.fingerprint
          : `mismatch:${digest(`${materialIdentity(current)}:${deployment.deployedCodeHash}`)}`,
      }
    },
  })

  const gate: MutableWorkflowVerificationGate = Object.freeze({
    accept(context: VerifiedWorkflowContext): void {
      sharedGate.accept(context)
    },
    assertAccepted(context: VerifiedWorkflowContext): VerifiedWorkflowContext {
      const expected = accepted
      try {
        return sharedGate.assertAccepted(context)
      } catch (error) {
        if (isVerificationRequired(error) && accepted === expected) accepted = undefined
        throw error
      }
    },
    invalidate(): void {
      accepted = undefined
      sharedGate.invalidate()
    },
    async assertCurrent(signal?: AbortSignal): Promise<VerifiedWorkflowContext> {
      const expected = accepted
      if (closed) throw sourceUnavailable()
      const deadline = createDeadline(signal, shutdownController.signal, timeoutMs)
      try {
        return await awaitWithinDeadline(sharedGate.assertCurrent(deadline.signal), deadline)
      } catch (error) {
        if (isVerificationRequired(error) && accepted === expected) accepted = undefined
        throw error
      } finally {
        deadline.dispose()
      }
    },
  })

  function invalidate(): void {
    gate.invalidate()
  }

  async function runFlight(
    selected: WorkflowSourceDescriptor,
    credential: RepositoryCredential | undefined,
    signal: AbortSignal,
  ): Promise<WorkflowVerificationResult> {
    let source: ResolvedWorkflowSource | undefined
    try {
      source = await resolver.materialize(selected, credential, { signal })
      if (signal.aborted) throw aborted()
      const result = await verifier.verify(source, { signal })
      if (signal.aborted) throw aborted()
      if (!result.valid) {
        if (accepted?.result.fingerprint === result.fingerprint) invalidate()
        return result
      }
      const stored = {
        descriptor: snapshotDescriptor(selected),
        result: verifiedResult(result),
      }
      accepted = stored
      gate.accept(verificationContext(stored.result, rpcUrl))
      return result
    } catch (error) {
      if (closed) throw sourceUnavailable()
      throw error
    } finally {
      source = undefined
    }
  }

  function createFlight(
    key: string,
    selected: WorkflowSourceDescriptor,
    credential: RepositoryCredential | undefined,
  ): VerificationFlight {
    const controller = new AbortController()
    const flight: VerificationFlight = {
      key,
      controller,
      subscribers: new Set(),
      promise: Promise.resolve(undefined as never),
      settled: false,
    }
    flight.promise = runFlight(selected, credential, controller.signal)
    activeFlight = flight
    void flight.promise.then(
      () => {
        flight.settled = true
        if (activeFlight === flight) activeFlight = undefined
      },
      () => {
        flight.settled = true
        if (activeFlight === flight) activeFlight = undefined
      },
    )
    return flight
  }

  function subscribe(
    flight: VerificationFlight,
    deadline: RequestDeadline,
  ): Promise<WorkflowVerificationResult> {
    if (flight.subscribers.size >= maxFlightSubscribers) return Promise.reject(compilerBusy())
    if (deadline.signal.aborted) return Promise.reject(requestAbortError(deadline))
    const token = Symbol('workflow-source-subscriber')
    flight.subscribers.add(token)

    return new Promise<WorkflowVerificationResult>((resolve, reject) => {
      let settled = false
      const detach = (): void => {
        deadline.signal.removeEventListener('abort', onRequestAbort)
        flight.controller.signal.removeEventListener('abort', onFlightAbort)
        flight.subscribers.delete(token)
        if (!flight.settled && flight.subscribers.size === 0) flight.controller.abort()
      }
      const finish = (callback: () => void): void => {
        if (settled) return
        settled = true
        detach()
        callback()
      }
      const onRequestAbort = (): void => finish(() => reject(requestAbortError(deadline)))
      const onFlightAbort = (): void => {
        if (closed) finish(() => reject(sourceUnavailable()))
      }
      deadline.signal.addEventListener('abort', onRequestAbort, { once: true })
      flight.controller.signal.addEventListener('abort', onFlightAbort, { once: true })
      flight.promise.then(
        (result) => finish(() => resolve(result)),
        (error: unknown) => finish(() => reject(closed ? sourceUnavailable() : error)),
      )
    })
  }

  async function verify(
    input: WorkflowSourceServiceInput = {},
  ): Promise<WorkflowVerificationResult> {
    if (closed) throw sourceUnavailable()
    const deadline = createDeadline(input.signal, shutdownController.signal, timeoutMs)
    try {
      const selected = await awaitWithinDeadline(
        resolver.discover(input.selector ?? { kind: 'latest' }, { signal: deadline.signal }),
        deadline,
      )
      if (closed) throw sourceUnavailable()
      const key = flightIdentity(selected, input.credential)
      const current = activeFlight
      const flight = current === undefined
        ? createFlight(key, selected, input.credential)
        : current.key === key
          ? current
          : undefined
      if (flight === undefined) throw compilerBusy()
      return await subscribe(flight, deadline)
    } finally {
      deadline.dispose()
    }
  }

  async function get(
    input: WorkflowSourceServiceInput = {},
  ): Promise<WorkflowSourceGetResult> {
    if (closed) throw sourceUnavailable()
    const acceptedAtStart = accepted
    const deadline = createDeadline(input.signal, shutdownController.signal, timeoutMs)
    let source: ResolvedWorkflowSource | undefined
    try {
      source = await awaitWithinDeadline(
        resolver.resolve(
          input.selector ?? { kind: 'latest' },
          input.credential,
          { signal: deadline.signal },
        ),
        deadline,
      )
      const identity = await awaitWithinDeadline(
        verifier.identify(source, { signal: deadline.signal }),
        deadline,
      )
      if (accepted !== acceptedAtStart) throw verificationRequired()
      gate.assertAccepted(verificationContext(identity, rpcUrl))
      return Object.freeze({
        ...verifiedResult(identity),
        sourceContent: source.source.text,
      })
    } finally {
      source = undefined
      deadline.dispose()
    }
  }

  const service: WorkflowSourceService = Object.freeze({ verify, get })
  return Object.freeze({
    service,
    gate,
    close(): Promise<void> {
      closePromise ??= (() => {
        closed = true
        shutdownController.abort()
        invalidate()
        const flight = activeFlight
        flight?.controller.abort()
        return flight === undefined
          ? Promise.resolve()
          : flight.promise.then(() => undefined, () => undefined)
      })()
      return closePromise
    },
  })
}
