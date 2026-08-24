import { describe, expect, it } from 'vitest'

import { TasError } from '../../../src/core/errors.js'
import { createWorkflowContractAddressResolver } from '../../../src/core/workflow/contractAddressResolver.js'
import type { VerifiedWorkflowContext } from '../../../src/core/workflow/types.js'
import type { GeneratedToolEntry } from '../../../src/mcp/manifest/types.js'

const workflowAddress = '0x4000000000000000000000000000000000000004'
const context: VerifiedWorkflowContext = {
  chainId: '31337',
  rpcUrl: 'http://127.0.0.1:8545',
  workflowAddress,
  blockSelector: { kind: 'block_hash', blockHash: `0x${'1'.repeat(64)}` },
  fingerprint: 'sha256:test',
}

function entry(entrypoint: string): GeneratedToolEntry {
  return {
    name: 'workflow.test',
    description: 'test',
    source: { entrypoint, export: 'Client', member: 'method' },
    binding: { kind: 'class_method', target: 'Client.method', arguments: [] },
    input_schema: { type: 'object' },
    output_schema: { type: 'null' },
    operation: { effect: 'read', completion: 'synchronous' },
    runtime_dependencies: ['chain_client', 'contract_address', 'account'],
    credential: 'none',
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  }
}

describe('Workflow contract address resolution', () => {
  it('binds only the standard ERC-8301 namespace to the verified Profile Workflow', async () => {
    const resolver = createWorkflowContractAddressResolver()

    await expect(resolver.resolve(entry('./execution/ERC8301'), context)).resolves.toBe(workflowAddress)
  })

  it.each([
    './identity/ERC8004',
    './verify/ERC8274',
    './settlement/ERC8203',
    './execution/ERC8301/recompute',
  ])('fails closed when the Profile does not authoritatively locate %s', async (entrypoint) => {
    const resolver = createWorkflowContractAddressResolver()

    await expect(resolver.resolve(entry(entrypoint), context)).rejects.toMatchObject<TasError>({
      code: 'MANIFEST_BINDING_UNSUPPORTED',
    })
  })
})
