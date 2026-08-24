import {
  type Abi,
  BaseError,
  BlockNotFoundError,
  type CallParameters,
  type ContractFunctionArgs,
  type ContractFunctionName,
  type ContractFunctionReturnType,
  ContractFunctionRevertedError,
  decodeFunctionResult,
  encodeFunctionData,
  type EncodeFunctionDataParameters,
  ExecutionRevertedError,
  getContractError,
  InvalidParamsRpcError,
  InvalidInputRpcError,
  type ReadContractParameters,
  ResourceNotFoundRpcError,
  ResourceUnavailableRpcError,
  type PublicClient,
} from 'viem'

import { TasError } from '../../core/errors.js'
import type { ProfileReader } from '../../core/profile/reader.js'
import type {
  ChainSelector,
  ProfileSnapshot,
  RawAgentSnapshot,
  RawDataEntry,
} from '../../core/profile/types.js'
import type { EvmAddress } from '../../local/config/types.js'
import {
  erc165Abi,
  erc721OwnerAbi,
  erc8004IdentityRegistryAbi,
  tawgProfileAbi,
  tawgProfileInterfaceId,
} from './profileAbi.js'

interface ViemProfileReaderOptions {
  readonly client: PublicClient
  readonly tawgAddress: EvmAddress
  readonly operationTimeoutMs?: number
}

interface ResolvedBlock {
  readonly number: bigint
  readonly hash: `0x${string}`
}

class ProfileReadAbortedError extends Error {
  constructor() {
    super('The Profile read was aborted.')
    this.name = 'AbortError'
  }
}

const canonicalDecimal = /^(?:0|[1-9][0-9]*)$/
const canonicalHash = /^0x[0-9a-fA-F]{64}$/
const maxUint256 = 2n ** 256n - 1n
const zeroAddress = '0x0000000000000000000000000000000000000000'
const defaultOperationTimeoutMs = 30_000

const publicMessages = {
  PROFILE_INCONSISTENT: 'The selected TAWG Profile state is inconsistent.',
  FINALITY_UNSUPPORTED: 'The requested chain finality is unsupported.',
  HISTORICAL_STATE_UNAVAILABLE: 'The requested historical chain state is unavailable.',
  RESOLUTION_CONFLICT: 'The selected chain block changed during resolution.',
  EXTERNAL_UNAVAILABLE: 'The chain service is unavailable.',
} as const

type ProfileReaderErrorCode = keyof typeof publicMessages

function fail(code: ProfileReaderErrorCode): never {
  throw new TasError(code, publicMessages[code])
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new ProfileReadAbortedError()
}

interface OperationCancellation {
  readonly signal: AbortSignal
  readonly didTimeout: () => boolean
  readonly cleanup: () => void
}

function createOperationCancellation(callerSignal: AbortSignal | undefined, timeoutMs: number): OperationCancellation {
  const controller = new AbortController()
  let timedOut = false
  const abort = (): void => controller.abort()
  const timeout = setTimeout(() => {
    timedOut = true
    abort()
  }, timeoutMs)
  timeout.unref()
  callerSignal?.addEventListener('abort', abort, { once: true })
  if (callerSignal?.aborted) abort()

  return {
    signal: controller.signal,
    didTimeout: () => timedOut,
    cleanup: () => {
      abort()
      clearTimeout(timeout)
      callerSignal?.removeEventListener('abort', abort)
    },
  }
}

function requireOperationTimeout(value: number | undefined): number {
  const timeoutMs = value ?? defaultOperationTimeoutMs
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) throw new RangeError('operationTimeoutMs must be a positive safe integer.')
  return timeoutMs
}

function abortable<T>(signal: AbortSignal | undefined, operation: () => Promise<T>): Promise<T> {
  throwIfAborted(signal)
  if (!signal) return operation()

  let request: Promise<T>
  try {
    request = operation()
  } catch (error) {
    return Promise.reject(error)
  }

  return new Promise<T>((resolve, reject) => {
    let settled = false
    const cleanup = (): void => signal.removeEventListener('abort', onAbort)
    const onAbort = (): void => {
      if (settled) return
      settled = true
      cleanup()
      reject(new ProfileReadAbortedError())
    }

    request.then(
      (value) => {
        if (settled) return
        settled = true
        cleanup()
        resolve(value)
      },
      (error: unknown) => {
        if (settled) return
        settled = true
        cleanup()
        reject(error)
      },
    )
    signal.addEventListener('abort', onAbort, { once: true })
    if (signal.aborted) onAbort()
  })
}

async function readContractWithSignal<
  const abi extends Abi | readonly unknown[],
  functionName extends ContractFunctionName<abi, 'pure' | 'view'>,
  const args extends ContractFunctionArgs<abi, 'pure' | 'view', functionName>,
>(
  client: PublicClient,
  parameters: ReadContractParameters<abi, functionName, args>,
  signal: AbortSignal,
): Promise<ContractFunctionReturnType<abi, 'pure' | 'view', functionName, args>> {
  const { abi, address, args, functionName, ...rest } = parameters as ReadContractParameters
  const calldata = encodeFunctionData({ abi, args, functionName } as EncodeFunctionDataParameters)
  try {
    const { data } = await client.call({
      ...(rest as CallParameters),
      data: calldata,
      to: address!,
      requestOptions: { dedupe: false, signal },
    })
    return decodeFunctionResult({
      abi,
      args,
      functionName,
      data: data || '0x',
    }) as ContractFunctionReturnType<abi, 'pure' | 'view', functionName, args>
  } catch (error) {
    throw getContractError(error as BaseError, {
      abi,
      address,
      args,
      docsPath: '/docs/contract/readContract',
      functionName,
    })
  }
}

function rethrowAbort(error: unknown): void {
  if (error instanceof ProfileReadAbortedError) throw error
}

type ErrorConstructor = abstract new (...args: never[]) => Error

type HistoricalStateRpcError = InvalidInputRpcError | ResourceNotFoundRpcError | ResourceUnavailableRpcError

// Ethereum RPC providers do not standardize archive-state errors. Keep this
// allowlist deliberately narrow and apply it only to exact-block eth_call.
const historicalStateMarkers = [
  /\bmissing trie node\b/,
  /\bhistorical state (?:is )?(?:unavailable|pruned)\b/,
  /\bstate (?:at|for) block(?: [^\s]+)? (?:is )?(?:unavailable|pruned)\b/,
] as const
const canonicalityMarkers = [/\bnot canonical\b/, /\bnon-canonical\b/] as const

function containsViemError(error: unknown, constructor: ErrorConstructor): boolean {
  try {
    if (error instanceof constructor) return true
    return error instanceof BaseError && error.walk((cause) => cause instanceof constructor) instanceof constructor
  } catch {
    return false
  }
}

function findHistoricalStateRpcError(error: unknown): HistoricalStateRpcError | null {
  try {
    if (error instanceof InvalidInputRpcError || error instanceof ResourceNotFoundRpcError || error instanceof ResourceUnavailableRpcError) return error
    if (!(error instanceof BaseError)) return null
    const candidate = error.walk((cause) => cause instanceof InvalidInputRpcError
      || cause instanceof ResourceNotFoundRpcError
      || cause instanceof ResourceUnavailableRpcError)
    return candidate instanceof InvalidInputRpcError
      || candidate instanceof ResourceNotFoundRpcError
      || candidate instanceof ResourceUnavailableRpcError
      ? candidate
      : null
  } catch {
    return null
  }
}

function hasNonemptyRpcData(error: unknown): boolean {
  const hasData = (candidate: unknown): boolean => {
    if (candidate === null || typeof candidate !== 'object') return false
    const descriptor = Object.getOwnPropertyDescriptor(candidate, 'data')
    if (!descriptor || !('value' in descriptor)) return false
    return descriptor.value !== undefined && descriptor.value !== null && descriptor.value !== '0x'
  }

  try {
    if (hasData(error)) return true
    return error instanceof BaseError && error.walk(hasData) !== null
  } catch {
    return true
  }
}

function isHistoricalContractStateUnavailable(error: unknown): boolean {
  const rpcError = findHistoricalStateRpcError(error)
  if (!rpcError) return false
  if (containsViemError(error, ExecutionRevertedError)
    || containsViemError(error, ContractFunctionRevertedError)
    || hasNonemptyRpcData(error)) return false

  const details = rpcError.details.toLowerCase()
  return historicalStateMarkers.some((marker) => marker.test(details))
}

function isCanonicalityConflict(error: unknown): boolean {
  const rpcError = findHistoricalStateRpcError(error)
  if (!rpcError) return false
  if (containsViemError(error, ExecutionRevertedError)
    || containsViemError(error, ContractFunctionRevertedError)
    || hasNonemptyRpcData(error)) return false

  try {
    const details = rpcError.details.toLowerCase()
    return canonicalityMarkers.some((marker) => marker.test(details))
  } catch {
    return false
  }
}

function isStructuralIndexRevert(error: unknown): boolean {
  try {
    const reverted = error instanceof ContractFunctionRevertedError
      ? error
      : error instanceof BaseError
        ? error.walk((cause) => cause instanceof ContractFunctionRevertedError)
        : null
    return (reverted instanceof ContractFunctionRevertedError && reverted.data?.errorName === 'IndexOutOfBounds')
      || containsViemError(error, ExecutionRevertedError)
  } catch {
    return false
  }
}

function isExplicitHistorical(selector: ChainSelector): boolean {
  return selector.kind === 'block_number' || selector.kind === 'block_hash'
}

function parseBlockNumber(value: string): bigint {
  if (!canonicalDecimal.test(value)) return fail('HISTORICAL_STATE_UNAVAILABLE')
  const number = BigInt(value)
  if (number > maxUint256) return fail('HISTORICAL_STATE_UNAVAILABLE')
  return number
}

function parseAgentId(value: string): bigint {
  if (!canonicalDecimal.test(value)) return fail('PROFILE_INCONSISTENT')
  const agentId = BigInt(value)
  if (agentId > maxUint256) return fail('PROFILE_INCONSISTENT')
  return agentId
}

function requireResolvedBlock(
  block: { readonly number: bigint | null; readonly hash: `0x${string}` | null },
  missingCode: 'EXTERNAL_UNAVAILABLE' | 'HISTORICAL_STATE_UNAVAILABLE' | 'RESOLUTION_CONFLICT',
): ResolvedBlock {
  if (block.number === null || block.hash === null) return fail(missingCode)
  return { number: block.number, hash: block.hash }
}

async function requestBlockByNumberOrTag(
  client: PublicClient,
  block: `0x${string}` | 'latest' | 'safe' | 'finalized',
  signal: AbortSignal,
): Promise<ResolvedBlock> {
  const result = await client.request(
    { method: 'eth_getBlockByNumber', params: [block, false] },
    { dedupe: false, signal },
  )
  if (!result) throw new BlockNotFoundError(block.startsWith('0x') ? { blockNumber: BigInt(block) } : {})
  return requireResolvedBlock({
    number: result.number === null ? null : BigInt(result.number),
    hash: result.hash,
  }, block.startsWith('0x') ? 'HISTORICAL_STATE_UNAVAILABLE' : 'EXTERNAL_UNAVAILABLE')
}

async function requestBlockByHash(
  client: PublicClient,
  blockHash: `0x${string}`,
  signal: AbortSignal,
): Promise<ResolvedBlock> {
  const result = await client.request(
    { method: 'eth_getBlockByHash', params: [blockHash, false] },
    { dedupe: false, signal },
  )
  if (!result) throw new BlockNotFoundError({ blockHash })
  return requireResolvedBlock({
    number: result.number === null ? null : BigInt(result.number),
    hash: result.hash,
  }, 'HISTORICAL_STATE_UNAVAILABLE')
}

async function resolveBlock(client: PublicClient, selector: ChainSelector, signal: AbortSignal): Promise<ResolvedBlock> {
  try {
    if (selector.kind === 'latest' || selector.kind === 'safe' || selector.kind === 'finalized') {
      return await abortable(signal, () => requestBlockByNumberOrTag(client, selector.kind, signal))
    }
    if (selector.kind === 'block_number') {
      const requestedNumber = parseBlockNumber(selector.blockNumber)
      const block = await abortable(signal, () => requestBlockByNumberOrTag(client, `0x${requestedNumber.toString(16)}`, signal))
      if (block.number !== requestedNumber) return fail('RESOLUTION_CONFLICT')
      return block
    }
    if (!canonicalHash.test(selector.blockHash)) return fail('HISTORICAL_STATE_UNAVAILABLE')
    const block = await abortable(signal, () => requestBlockByHash(client, selector.blockHash, signal))
    if (block.hash.toLowerCase() !== selector.blockHash.toLowerCase()) return fail('RESOLUTION_CONFLICT')
    return block
  } catch (error) {
    rethrowAbort(error)
    if (error instanceof TasError) throw error
    if ((selector.kind === 'safe' || selector.kind === 'finalized') && containsViemError(error, InvalidParamsRpcError)) {
      return fail('FINALITY_UNSUPPORTED')
    }
    if (isExplicitHistorical(selector) && containsViemError(error, BlockNotFoundError)) return fail('HISTORICAL_STATE_UNAVAILABLE')
    return fail('EXTERNAL_UNAVAILABLE')
  }
}

async function readAtBlock<T>(selector: ChainSelector, signal: AbortSignal | undefined, operation: () => Promise<T>): Promise<T> {
  try {
    return await abortable(signal, operation)
  } catch (error) {
    rethrowAbort(error)
    if (error instanceof TasError) throw error
    if (containsViemError(error, BlockNotFoundError) || isCanonicalityConflict(error)) return fail('RESOLUTION_CONFLICT')
    if (isExplicitHistorical(selector)
      && isHistoricalContractStateUnavailable(error)) {
      return fail('HISTORICAL_STATE_UNAVAILABLE')
    }
    return fail('EXTERNAL_UNAVAILABLE')
  }
}

async function readEnumeratedValueAtBlock<T>(selector: ChainSelector, signal: AbortSignal | undefined, operation: () => Promise<T>): Promise<T> {
  try {
    return await abortable(signal, operation)
  } catch (error) {
    rethrowAbort(error)
    if (error instanceof TasError) throw error
    if (isStructuralIndexRevert(error)) return fail('PROFILE_INCONSISTENT')
    if (containsViemError(error, BlockNotFoundError) || isCanonicalityConflict(error)) return fail('RESOLUTION_CONFLICT')
    if (isExplicitHistorical(selector)
      && isHistoricalContractStateUnavailable(error)) {
      return fail('HISTORICAL_STATE_UNAVAILABLE')
    }
    return fail('EXTERNAL_UNAVAILABLE')
  }
}

async function assertBlockUnchanged(client: PublicClient, block: ResolvedBlock, signal: AbortSignal): Promise<void> {
  let current: ResolvedBlock
  try {
    current = await abortable(signal, () => requestBlockByNumberOrTag(client, `0x${block.number.toString(16)}`, signal))
  } catch (error) {
    rethrowAbort(error)
    if (error instanceof TasError) return fail('RESOLUTION_CONFLICT')
    if (containsViemError(error, BlockNotFoundError)) return fail('RESOLUTION_CONFLICT')
    return fail('EXTERNAL_UNAVAILABLE')
  }
  if (current.number !== block.number || current.hash.toLowerCase() !== block.hash.toLowerCase()) return fail('RESOLUTION_CONFLICT')
}

async function getChainId(client: PublicClient, signal: AbortSignal): Promise<string> {
  try {
    const chainId = await abortable(signal, () => client.request({ method: 'eth_chainId' }, { dedupe: false, signal }))
    return BigInt(chainId).toString()
  } catch (error) {
    rethrowAbort(error)
    return fail('EXTERNAL_UNAVAILABLE')
  }
}

async function supportsProfile(client: PublicClient, address: EvmAddress, blockHash: `0x${string}`, signal: AbortSignal): Promise<boolean> {
  return readContractWithSignal(client, {
    address,
    abi: erc165Abi,
    functionName: 'supportsInterface',
    args: [tawgProfileInterfaceId],
    blockHash,
    requireCanonical: true,
  }, signal)
}

export function createViemProfileReader(options: ViemProfileReaderOptions): ProfileReader {
  const { client, tawgAddress } = options
  const operationTimeoutMs = requireOperationTimeout(options.operationTimeoutMs)

  return {
    async readProfile(selector, readOptions = {}): Promise<ProfileSnapshot> {
      const cancellation = createOperationCancellation(readOptions.signal, operationTimeoutMs)
      const { signal } = cancellation
      try {
        throwIfAborted(signal)
        const block = await resolveBlock(client, selector, signal)
        const chainId = await getChainId(client, signal)
        const supported = await readAtBlock(selector, signal, () => supportsProfile(client, tawgAddress, block.hash, signal))
        if (!supported) {
          await assertBlockUnchanged(client, block, signal)
          return fail('PROFILE_INCONSISTENT')
        }

        const canonicalBlock = { blockHash: block.hash, requireCanonical: true } as const
        const [version, governance, identityRegistry, charter, agentCount, dataCount, workflow] = await readAtBlock(selector, signal, () => Promise.all([
          readContractWithSignal(client, { address: tawgAddress, abi: tawgProfileAbi, functionName: 'version', ...canonicalBlock }, signal),
          readContractWithSignal(client, { address: tawgAddress, abi: tawgProfileAbi, functionName: 'governance', ...canonicalBlock }, signal),
          readContractWithSignal(client, { address: tawgAddress, abi: tawgProfileAbi, functionName: 'identityRegistry', ...canonicalBlock }, signal),
          readContractWithSignal(client, { address: tawgAddress, abi: tawgProfileAbi, functionName: 'getCharter', ...canonicalBlock }, signal),
          readContractWithSignal(client, { address: tawgAddress, abi: tawgProfileAbi, functionName: 'agentCount', ...canonicalBlock }, signal),
          readContractWithSignal(client, { address: tawgAddress, abi: tawgProfileAbi, functionName: 'dataCount', ...canonicalBlock }, signal),
          readContractWithSignal(client, { address: tawgAddress, abi: tawgProfileAbi, functionName: 'getWorkflow', ...canonicalBlock }, signal),
        ]))

        const agentIds: string[] = []
        const seenAgentIds = new Set<string>()
        for (let index = 0n; index < agentCount; index += 1n) {
          const agentId = await readEnumeratedValueAtBlock(selector, signal, () => readContractWithSignal(client, {
            address: tawgAddress,
            abi: tawgProfileAbi,
            functionName: 'agentIdAt',
            args: [index],
            ...canonicalBlock,
          }, signal))
          const agentIdValue = agentId.toString()
          if (seenAgentIds.has(agentIdValue)) return fail('PROFILE_INCONSISTENT')
          seenAgentIds.add(agentIdValue)
          agentIds.push(agentIdValue)
        }

        const dataEntries: RawDataEntry[] = []
        const seenDataKeys = new Set<string>()
        for (let index = 0n; index < dataCount; index += 1n) {
          const key = await readEnumeratedValueAtBlock(selector, signal, () => readContractWithSignal(client, {
            address: tawgAddress,
            abi: tawgProfileAbi,
            functionName: 'dataKeyAt',
            args: [index],
            ...canonicalBlock,
          }, signal))
          if (seenDataKeys.has(key)) return fail('PROFILE_INCONSISTENT')
          seenDataKeys.add(key)
          const [exists, data] = await readAtBlock(selector, signal, () => readContractWithSignal(client, {
            address: tawgAddress,
            abi: tawgProfileAbi,
            functionName: 'getData',
            args: [key],
            ...canonicalBlock,
          }, signal))
          dataEntries.push({ key, exists, data })
        }

        await assertBlockUnchanged(client, block, signal)
        if (dataEntries.some(({ exists }) => !exists)) return fail('PROFILE_INCONSISTENT')

        return {
          chainId,
          tawgAddress,
          blockNumber: block.number.toString(),
          blockHash: block.hash,
          version: version.toString(),
          governance,
          identityRegistry,
          charter,
          agentIds,
          dataEntries,
          workflow: { workflowAddress: workflow[0], data: workflow[1] },
        }
      } catch (error) {
        if (cancellation.didTimeout() && error instanceof ProfileReadAbortedError) return fail('EXTERNAL_UNAVAILABLE')
        throw error
      } finally {
        cancellation.cleanup()
      }
    },

    async readAgent(agentIdValue, selector, readOptions = {}): Promise<RawAgentSnapshot> {
      const cancellation = createOperationCancellation(readOptions.signal, operationTimeoutMs)
      const { signal } = cancellation
      try {
        throwIfAborted(signal)
        const agentId = parseAgentId(agentIdValue)
        const block = await resolveBlock(client, selector, signal)
        const chainId = await getChainId(client, signal)
        const supported = await readAtBlock(selector, signal, () => supportsProfile(client, tawgAddress, block.hash, signal))
        if (!supported) {
          await assertBlockUnchanged(client, block, signal)
          return fail('PROFILE_INCONSISTENT')
        }
        const canonicalBlock = { blockHash: block.hash, requireCanonical: true } as const
        const [version, identityRegistry, agent] = await readAtBlock(selector, signal, () => Promise.all([
          readContractWithSignal(client, { address: tawgAddress, abi: tawgProfileAbi, functionName: 'version', ...canonicalBlock }, signal),
          readContractWithSignal(client, { address: tawgAddress, abi: tawgProfileAbi, functionName: 'identityRegistry', ...canonicalBlock }, signal),
          readContractWithSignal(client, { address: tawgAddress, abi: tawgProfileAbi, functionName: 'getAgent', args: [agentId], ...canonicalBlock }, signal),
        ]))

        let authenticationWallet: EvmAddress | undefined
        if (agent[0]) {
          await readAtBlock(selector, signal, () => readContractWithSignal(client, {
            address: identityRegistry,
            abi: erc721OwnerAbi,
            functionName: 'ownerOf',
            args: [agentId],
            ...canonicalBlock,
          }, signal))
          authenticationWallet = await readAtBlock(selector, signal, () => readContractWithSignal(client, {
            address: identityRegistry,
            abi: erc8004IdentityRegistryAbi,
            functionName: 'getAgentWallet',
            args: [agentId],
            ...canonicalBlock,
          }, signal))
        }

        await assertBlockUnchanged(client, block, signal)
        if (!agent[0] && (agent[1] !== '' || agent[2].toLowerCase() !== zeroAddress)) return fail('PROFILE_INCONSISTENT')

        return {
          chainId,
          tawgAddress,
          blockNumber: block.number.toString(),
          blockHash: block.hash,
          version: version.toString(),
          identityRegistry,
          agentId: agentId.toString(),
          isMember: agent[0],
          data: agent[1],
          agentVerifier: agent[2],
          ...(authenticationWallet ? { authenticationWallet } : {}),
        }
      } catch (error) {
        if (cancellation.didTimeout() && error instanceof ProfileReadAbortedError) return fail('EXTERNAL_UNAVAILABLE')
        throw error
      } finally {
        cancellation.cleanup()
      }
    },
  }
}
