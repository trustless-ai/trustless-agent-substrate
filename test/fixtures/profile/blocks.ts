import {
  createPublicClient,
  custom,
  decodeFunctionData,
  encodeErrorResult,
  encodeFunctionResult,
  type Hex,
} from 'viem'

import {
  erc165Abi,
  erc721OwnerAbi,
  erc8004IdentityRegistryAbi,
  tawgProfileAbi,
} from '../../../src/clients/chain/profileAbi.js'

export const fixtureProfileAddress = '0x1000000000000000000000000000000000000001' as const
export const fixtureRegistryAddress = '0x2000000000000000000000000000000000000002' as const
export const fixtureGovernanceAddress = '0x3000000000000000000000000000000000000003' as const
export const fixtureWorkflowAddress = '0x4000000000000000000000000000000000000004' as const
export const fixtureVerifierAddress = '0x5000000000000000000000000000000000000005' as const
export const fixtureOwnerAddress = '0x6000000000000000000000000000000000000006' as const
export const fixtureWalletAddress = '0x7000000000000000000000000000000000000007' as const
export const fixtureAgentId = (2n ** 256n - 2n).toString()
export const fixtureVersion = (2n ** 256n - 3n).toString()
export const fixtureAlternateVersion = '2'

export const fixtureBlocks = {
  latest: { number: 100n, hash: `0x${'10'.repeat(32)}` as Hex },
  safe: { number: 99n, hash: `0x${'20'.repeat(32)}` as Hex },
  finalized: { number: 98n, hash: `0x${'30'.repeat(32)}` as Hex },
  historical: { number: 77n, hash: `0x${'40'.repeat(32)}` as Hex },
} as const

export interface ProfileRpcFixtureOptions {
  readonly unsupportedInterface?: boolean
  readonly unsupportedFinality?: 'safe' | 'finalized'
  readonly unavailableTag?: 'latest' | 'safe' | 'finalized'
  readonly unavailableBlock?: bigint
  readonly blockResolutionFailure?: Readonly<{
    code: -32000 | -32001 | -32002
    message: string
  }>
  readonly historicalStateFailure?: Readonly<{
    code: -32000 | -32001 | -32002
    message: string
    data?: Hex
  }>
  readonly ambiguousRpcFailure?: -32000 | -32001 | -32002
  readonly reorgAfterReads?: boolean
  readonly blockUnavailableAfterReads?: boolean
  readonly blockHashMismatch?: boolean
  readonly blockNumberMismatch?: boolean
  readonly loadBalancedNumberState?: boolean
  readonly unsupportedEip1898?: boolean
  readonly canonicalityFailure?: 'not canonical' | 'non-canonical'
  readonly duplicateAgentIds?: boolean
  readonly agentCount?: bigint
  readonly duplicateDataKeys?: boolean
  readonly failFunction?: 'governance'
  readonly holdFunction?: 'agentIdAt' | 'dataKeyAt' | 'version'
  readonly holdFirstMethod?: 'eth_chainId' | 'eth_getBlockByNumber'
  readonly holdMethod?: 'eth_chainId' | 'eth_getBlockByNumber'
  readonly indexFailure?: Readonly<{
    functionName: 'agentIdAt' | 'dataKeyAt'
    kind: 'historical' | 'revert' | 'transport'
  }>
  readonly missingEnumeratedData?: boolean
  readonly member?: boolean
  readonly transportFailure?: boolean
  readonly workflowData?: string
}

export interface ProfileRpcFixture {
  readonly client: ReturnType<typeof createPublicClient>
  readonly heldCallAborted: Promise<void>
  readonly heldCallStarted: Promise<void>
  readonly requests: readonly Readonly<{ method: string; params?: readonly unknown[] }>[]
}

const zeroHash = `0x${'00'.repeat(32)}` as const
const zeroAddress = '0x0000000000000000000000000000000000000000' as const

function rpcBlock(number: bigint, hash: Hex) {
  return {
    number: `0x${number.toString(16)}`,
    hash,
    parentHash: zeroHash,
    nonce: '0x0000000000000000',
    sha3Uncles: zeroHash,
    logsBloom: `0x${'00'.repeat(256)}`,
    transactionsRoot: zeroHash,
    stateRoot: zeroHash,
    receiptsRoot: zeroHash,
    miner: zeroAddress,
    difficulty: '0x0',
    totalDifficulty: '0x0',
    extraData: '0x',
    size: '0x1',
    gasLimit: '0x1c9c380',
    gasUsed: '0x0',
    timestamp: '0x1',
    transactions: [],
    uncles: [],
    mixHash: zeroHash,
    baseFeePerGas: '0x1',
  }
}

function rpcFailure(code: number, message: string, data?: Hex): Error & { code: number; data?: Hex } {
  return Object.assign(new Error(message), { code }, data === undefined ? {} : { data })
}

function blockForNumber(number: bigint) {
  return Object.values(fixtureBlocks).find((block) => block.number === number)
}

export function createProfileRpcFixture(options: ProfileRpcFixtureOptions = {}): ProfileRpcFixture {
  const requests: Array<Readonly<{ method: string; params?: readonly unknown[] }>> = []
  let exactBlockFetches = 0
  let announceHeldCall: (() => void) | undefined
  const heldCallStarted = new Promise<void>((resolve) => { announceHeldCall = resolve })
  let announceHeldAbort: (() => void) | undefined
  const heldCallAborted = new Promise<void>((resolve) => { announceHeldAbort = resolve })
  let heldFirstMethod = false

  const holdUntilAborted = (signal: AbortSignal | undefined): Promise<never> => {
    announceHeldCall?.()
    return new Promise((_, reject) => {
      signal?.addEventListener('abort', () => {
        announceHeldAbort?.()
        const error = new Error('fixture request aborted')
        error.name = 'AbortError'
        reject(error)
      }, { once: true })
    })
  }

  const provider = {
    async request(
      { method, params }: { method: string; params?: readonly unknown[] },
      requestOptions?: { readonly signal?: AbortSignal },
    ): Promise<unknown> {
      requests.push({ method, params })

      if (method === options.holdMethod) return holdUntilAborted(requestOptions?.signal)
      if (method === options.holdFirstMethod && !heldFirstMethod) {
        heldFirstMethod = true
        return holdUntilAborted(requestOptions?.signal)
      }

      if (options.transportFailure) throw rpcFailure(-32603, 'transport failed at https://secret.invalid/rpc?token=raw-secret')
      if (method === 'eth_chainId') return '0x7a69'

      if (method === 'eth_getBlockByHash') {
        const requestedHash = params?.[0]
        const block = Object.values(fixtureBlocks).find(({ hash }) => hash === requestedHash)
        if (!block) return null
        return rpcBlock(block.number, options.blockHashMismatch ? fixtureBlocks.latest.hash : block.hash)
      }

      if (method === 'eth_getBlockByNumber') {
        if (options.blockResolutionFailure) {
          throw rpcFailure(options.blockResolutionFailure.code, options.blockResolutionFailure.message)
        }
        const selector = params?.[0]
        if (selector === options.unsupportedFinality) {
          throw rpcFailure(-32602, `unsupported tag at https://secret.invalid/${String(selector)}`)
        }
        const tagged = typeof selector === 'string' && selector in fixtureBlocks
          ? fixtureBlocks[selector as keyof typeof fixtureBlocks]
          : undefined
        if (selector === options.unavailableTag) return null
        const number = typeof selector === 'string' && selector.startsWith('0x') ? BigInt(selector) : undefined
        if (number !== undefined && options.unavailableBlock === number) return null
        if (number !== undefined && options.blockUnavailableAfterReads) return null
        const block = tagged ?? (number === undefined ? undefined : blockForNumber(number))
        if (!block) return null
        if (number !== undefined) exactBlockFetches += 1
        const hash = options.reorgAfterReads && exactBlockFetches > 0
          ? (`0x${'ff'.repeat(32)}` as Hex)
          : block.hash
        return rpcBlock(options.blockNumberMismatch && number !== undefined ? fixtureBlocks.latest.number : block.number, hash)
      }

      if (method !== 'eth_call') throw rpcFailure(-32601, `unexpected RPC method ${method}`)
      if (options.historicalStateFailure) {
        throw rpcFailure(
          options.historicalStateFailure.code,
          options.historicalStateFailure.message,
          options.historicalStateFailure.data,
        )
      }
      if (options.ambiguousRpcFailure) {
        throw rpcFailure(options.ambiguousRpcFailure, 'ambiguous service failure at https://secret.invalid/archive?token=raw-secret')
      }

      const call = params?.[0] as { to?: string; data?: Hex } | undefined
      const blockSelector = params?.[1]
      if (options.unsupportedEip1898 && blockSelector !== null && typeof blockSelector === 'object') {
        throw rpcFailure(-32602, 'EIP-1898 block selectors are unsupported at https://secret.invalid/rpc?token=raw-secret')
      }
      if (options.canonicalityFailure && blockSelector !== null && typeof blockSelector === 'object') {
        throw rpcFailure(-32000, `resolved block is ${options.canonicalityFailure} at https://secret.invalid/rpc?token=raw-secret`)
      }
      if (!call?.to || !call.data) throw rpcFailure(-32602, 'invalid call')
      if (call.to.toLowerCase() === fixtureProfileAddress.toLowerCase()) {
        const decoded = decodeFunctionData({ abi: [...erc165Abi, ...tawgProfileAbi], data: call.data })
        switch (decoded.functionName) {
          case 'supportsInterface':
            return encodeFunctionResult({ abi: erc165Abi, functionName: 'supportsInterface', result: !options.unsupportedInterface })
          case 'version':
            if (options.holdFunction === 'version') {
              return holdUntilAborted(requestOptions?.signal)
            }
            return encodeFunctionResult({
              abi: tawgProfileAbi,
              functionName: 'version',
              result: BigInt(options.loadBalancedNumberState && typeof blockSelector === 'string' ? fixtureAlternateVersion : fixtureVersion),
            })
          case 'governance':
            if (options.failFunction === 'governance') throw rpcFailure(-32603, 'governance read failed at https://secret.invalid/rpc?token=raw-secret')
            return encodeFunctionResult({ abi: tawgProfileAbi, functionName: 'governance', result: fixtureGovernanceAddress })
          case 'identityRegistry':
            return encodeFunctionResult({ abi: tawgProfileAbi, functionName: 'identityRegistry', result: fixtureRegistryAddress })
          case 'getCharter':
            return encodeFunctionResult({
              abi: tawgProfileAbi,
              functionName: 'getCharter',
              result: { repository: 'https://github.com/trustless-ai/example', commitHash: 'a'.repeat(40), path: 'charter/' },
            })
          case 'agentCount':
            return encodeFunctionResult({ abi: tawgProfileAbi, functionName: 'agentCount', result: options.agentCount ?? (options.duplicateAgentIds ? 2n : 1n) })
          case 'agentIdAt':
            if (options.holdFunction === 'agentIdAt') {
              return holdUntilAborted(requestOptions?.signal)
            }
            if (options.indexFailure?.functionName === 'agentIdAt') {
              if (options.indexFailure.kind === 'transport') throw rpcFailure(-32603, 'transport failed at https://secret.invalid/rpc?token=raw-secret')
              if (options.indexFailure.kind === 'historical') throw rpcFailure(-32000, 'missing trie node at https://secret.invalid/rpc?token=raw-secret')
              throw Object.assign(new Error('execution reverted'), {
                code: -32000,
                data: encodeErrorResult({ abi: tawgProfileAbi, errorName: 'IndexOutOfBounds', args: [0n, 1n] }),
              })
            }
            return encodeFunctionResult({ abi: tawgProfileAbi, functionName: 'agentIdAt', result: BigInt(fixtureAgentId) })
          case 'getAgent': {
            const member = options.member !== false
            return encodeFunctionResult({
              abi: tawgProfileAbi,
              functionName: 'getAgent',
              result: member ? [true, '{"role":"contributor"}', fixtureVerifierAddress] : [false, '', zeroAddress],
            })
          }
          case 'dataCount':
            return encodeFunctionResult({ abi: tawgProfileAbi, functionName: 'dataCount', result: options.duplicateDataKeys ? 2n : 1n })
          case 'dataKeyAt':
            if (options.holdFunction === 'dataKeyAt') {
              return holdUntilAborted(requestOptions?.signal)
            }
            if (options.indexFailure?.functionName === 'dataKeyAt') {
              if (options.indexFailure.kind === 'transport') throw rpcFailure(-32603, 'transport failed at https://secret.invalid/rpc?token=raw-secret')
              if (options.indexFailure.kind === 'historical') throw rpcFailure(-32000, 'missing trie node at https://secret.invalid/rpc?token=raw-secret')
              throw Object.assign(new Error('execution reverted'), {
                code: -32000,
                data: encodeErrorResult({ abi: tawgProfileAbi, errorName: 'IndexOutOfBounds', args: [0n, 1n] }),
              })
            }
            return encodeFunctionResult({ abi: tawgProfileAbi, functionName: 'dataKeyAt', result: 'artifacts' })
          case 'getData':
            return encodeFunctionResult({
              abi: tawgProfileAbi,
              functionName: 'getData',
              result: options.missingEnumeratedData ? [false, ''] : [true, '{"type":"git"}'],
            })
          case 'getWorkflow':
            return encodeFunctionResult({
              abi: tawgProfileAbi,
              functionName: 'getWorkflow',
              result: [fixtureWorkflowAddress, options.workflowData ?? '{"kind":"demo"}'],
            })
          default:
            throw rpcFailure(-32601, `unexpected Profile function ${decoded.functionName}`)
        }
      }

      if (call.to.toLowerCase() === fixtureRegistryAddress.toLowerCase()) {
        try {
          const decoded = decodeFunctionData({ abi: erc721OwnerAbi, data: call.data })
          if (decoded.functionName === 'ownerOf') {
            return encodeFunctionResult({ abi: erc721OwnerAbi, functionName: 'ownerOf', result: fixtureOwnerAddress })
          }
        } catch {
          const decoded = decodeFunctionData({ abi: erc8004IdentityRegistryAbi, data: call.data })
          if (decoded.functionName === 'getAgentWallet') {
            return encodeFunctionResult({ abi: erc8004IdentityRegistryAbi, functionName: 'getAgentWallet', result: fixtureWalletAddress })
          }
        }
      }

      throw rpcFailure(-32601, 'unexpected contract call')
    },
  }

  return {
    client: createPublicClient({ transport: custom(provider, { retryCount: 0 }) }),
    heldCallAborted,
    heldCallStarted,
    requests,
  }
}
