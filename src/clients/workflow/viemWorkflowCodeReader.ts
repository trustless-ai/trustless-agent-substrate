import type { PublicClient } from 'viem'

import { TasError } from '../../core/errors.js'
import type { WorkflowCodeReader } from '../../core/workflow/sourceVerifier.js'
import type { CanonicalDecimal } from '../../local/config/types.js'

export interface ViemWorkflowCodeReaderOptions {
  readonly client: PublicClient
  readonly chainId: CanonicalDecimal
}

function unavailable(): never {
  throw new TasError('WORKFLOW_SOURCE_UNAVAILABLE', 'The deployed Workflow source is unavailable.')
}

/** Reads runtime code only through an EIP-1898 canonical block-hash selector. */
export function createViemWorkflowCodeReader(
  options: ViemWorkflowCodeReaderOptions,
): WorkflowCodeReader {
  const { client, chainId } = options
  if (client.chain === undefined || String(client.chain.id) !== chainId) return unavailable()

  const reader: WorkflowCodeReader = {
    async readCode(request) {
      if (request.chainId !== chainId || request.requireCanonical !== true) return unavailable()
      const code = await client.request({
        method: 'eth_getCode',
        params: [request.address, {
          blockHash: request.blockHash,
          requireCanonical: true,
        }],
      }, {
        // Signals are caller-scoped; sharing a viem request would let one caller
        // cancel another request for the same exact block.
        dedupe: false,
        retryCount: 0,
        signal: request.signal,
      })
      return code === '0x' ? undefined : code
    },
  }
  return Object.freeze(reader)
}
