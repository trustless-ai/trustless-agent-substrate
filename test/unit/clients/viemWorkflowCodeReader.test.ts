import { describe, expect, it, vi } from 'vitest'
import type { PublicClient } from 'viem'

import { createViemWorkflowCodeReader } from '../../../src/clients/workflow/viemWorkflowCodeReader.js'
import { TasError } from '../../../src/core/errors.js'

const chainId = '31337'
const address = '0x1000000000000000000000000000000000000001'
const blockHash = `0x${'ab'.repeat(32)}` as const

function client(request = vi.fn(async () => '0x6001' as const)): PublicClient {
  return { chain: { id: 31_337 }, request } as unknown as PublicClient
}

describe('viem Workflow code reader', () => {
  it('binds runtime reads to the configured chain and canonical EIP-1898 block hash', async () => {
    const request = vi.fn(async () => '0x6001' as const)
    const reader = createViemWorkflowCodeReader({ client: client(request), chainId })
    const controller = new AbortController()

    await expect(reader.readCode({
      chainId,
      address,
      blockHash,
      requireCanonical: true,
      signal: controller.signal,
    })).resolves.toBe('0x6001')
    expect(request).toHaveBeenCalledWith({
      method: 'eth_getCode',
      params: [address, { blockHash, requireCanonical: true }],
    }, {
      dedupe: false,
      retryCount: 0,
      signal: controller.signal,
    })
  })

  it('rejects a reader or request bound to another chain', async () => {
    expect(() => createViemWorkflowCodeReader({ client: client(), chainId: '1' }))
      .toThrowError(TasError)
    const reader = createViemWorkflowCodeReader({ client: client(), chainId })

    await expect(reader.readCode({
      chainId: '1',
      address,
      blockHash,
      requireCanonical: true,
    })).rejects.toMatchObject({ code: 'WORKFLOW_SOURCE_UNAVAILABLE' })
  })

  it('projects empty runtime code as unavailable data', async () => {
    const reader = createViemWorkflowCodeReader({
      client: client(vi.fn(async () => '0x' as const)),
      chainId,
    })

    await expect(reader.readCode({ chainId, address, blockHash, requireCanonical: true }))
      .resolves.toBeUndefined()
  })

  it('keeps cancellation isolated between identical exact-block reads', async () => {
    const completions: Array<(value: `0x${string}`) => void> = []
    const request = vi.fn((_parameters: unknown, options?: { readonly signal?: AbortSignal }) => new Promise<`0x${string}`>((resolve, reject) => {
      completions.push(resolve)
      options?.signal?.addEventListener('abort', () => {
        const error = new Error('aborted')
        error.name = 'AbortError'
        reject(error)
      }, { once: true })
    }))
    const reader = createViemWorkflowCodeReader({ client: client(request), chainId })
    const firstController = new AbortController()
    const secondController = new AbortController()
    const common = { chainId, address, blockHash, requireCanonical: true as const }

    const first = reader.readCode({ ...common, signal: firstController.signal })
    const second = reader.readCode({ ...common, signal: secondController.signal })
    firstController.abort()
    completions[1]!('0x6002')

    await expect(first).rejects.toMatchObject({ name: 'AbortError' })
    await expect(second).resolves.toBe('0x6002')
    expect(request).toHaveBeenNthCalledWith(1, expect.anything(), expect.objectContaining({ dedupe: false }))
    expect(request).toHaveBeenNthCalledWith(2, expect.anything(), expect.objectContaining({ dedupe: false }))
  })
})
