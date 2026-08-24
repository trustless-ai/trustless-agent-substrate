import { describe, expect, it, vi } from 'vitest'
import type { Account } from 'viem'

import type { AgentSdkBindingClient } from '../../../src/clients/workflow/agentSdkClient.js'
import { TasError } from '../../../src/core/errors.js'
import { createWorkflowOperationService } from '../../../src/core/workflow/operationService.js'
import type {
  VerifiedWorkflowContext,
  WorkflowContractAddressResolver,
  WorkflowMemberResolver,
  WorkflowOperationRegistry,
  WorkflowVerificationGate,
} from '../../../src/core/workflow/types.js'
import type { GeneratedToolEntry } from '../../../src/mcp/manifest/types.js'

const agentId = '340282366920938463463374607431768211457'
const memberWallet = '0x2000000000000000000000000000000000000002'
const workflowAddress = '0x1000000000000000000000000000000000000001'
const selectedAddress = '0x3000000000000000000000000000000000000003'
const privateKey = `0x${'1'.repeat(64)}`
const blockHash = `0x${'a'.repeat(64)}` as const
const context: VerifiedWorkflowContext = {
  chainId: '31337',
  rpcUrl: 'http://127.0.0.1:8545',
  workflowAddress,
  blockSelector: { kind: 'block_hash', blockHash },
  fingerprint: `sha256:${'b'.repeat(64)}`,
}

const objectSchema = (properties: Readonly<Record<string, unknown>>, required: readonly string[] = []) => ({
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  additionalProperties: false,
  properties,
  required,
  type: 'object',
})

function entry(overrides: Partial<GeneratedToolEntry> = {}): GeneratedToolEntry {
  return {
    name: 'workflow.execution.erc8301.recompute.compute_task_hash',
    description: 'fixture',
    source: { entrypoint: './execution/ERC8301/recompute', export: 'computeTaskHash', member: 'computeTaskHash' },
    binding: {
      kind: 'function',
      target: 'computeTaskHash',
      arguments: [
        { kind: 'input', name: 'first' },
        { kind: 'input', name: 'optionalMiddle' },
        { kind: 'input', name: 'last' },
      ],
    },
    input_schema: objectSchema({
      first: { type: 'string' },
      last: { format: 'bigint', type: 'string' },
      optionalMiddle: { type: 'string' },
    }, ['first', 'last']),
    output_schema: { $schema: 'https://json-schema.org/draft/2020-12/schema', format: 'bigint', type: 'string' },
    operation: { effect: 'read', completion: 'synchronous' },
    runtime_dependencies: [],
    credential: 'none',
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    ...overrides,
  }
}

function classEntry(overrides: Partial<GeneratedToolEntry> = {}): GeneratedToolEntry {
  return entry({
    name: 'workflow.execution.erc8301.agent_workflow.get_task',
    source: { entrypoint: './execution/ERC8301', export: 'AgentWorkflowClient', member: 'getTask' },
    binding: { kind: 'class_method', target: 'AgentWorkflowClient.getTask', arguments: [{ kind: 'input', name: 'taskHash' }] },
    input_schema: objectSchema({ taskHash: { type: 'string' } }, ['taskHash']),
    output_schema: objectSchema({ sequence: { format: 'bigint', type: 'string' } }, ['sequence']),
    runtime_dependencies: ['chain_client', 'contract_address', 'account'],
    ...overrides,
  })
}

function member(wallet = memberWallet) {
  return {
    data: {
      agent_id: agentId,
      is_member: true as const,
      data: {},
      agent_verifier: '0x4000000000000000000000000000000000000004',
      authentication_wallet: wallet,
    },
    resolution: { chain: { block_number: '42', block_hash: blockHash }, profile: { version: '1' } },
  }
}

interface HarnessOptions {
  readonly tool?: GeneratedToolEntry
  readonly invoke?: AgentSdkBindingClient['invoke']
  readonly gate?: WorkflowVerificationGate
  readonly wallet?: string
  readonly privateKeyAddress?: string
}

function harness(options: HarnessOptions = {}) {
  const tool = options.tool ?? entry()
  const events: string[] = []
  const gate = options.gate ?? { assertCurrent: vi.fn(async () => { events.push('gate'); return context }) }
  const registry: WorkflowOperationRegistry = { get: vi.fn((name) => name === tool.name ? tool : undefined) }
  const getAgent = vi.fn(async () => member(options.wallet))
  const memberResolver: WorkflowMemberResolver = { getAgent }
  const resolve = vi.fn(async () => selectedAddress)
  const contractAddressResolver: WorkflowContractAddressResolver = { resolve }
  let addressSequence = 0
  const accountFromAddress = vi.fn((address: `0x${string}`) => ({ address, nonce: ++addressSequence } as unknown as Account))
  const accountFromPrivateKey = vi.fn((_secret: `0x${string}`) => ({
    address: options.privateKeyAddress ?? memberWallet,
    nonce: ++addressSequence,
  } as unknown as Account))
  const invoke = vi.fn(options.invoke ?? (async () => 17n))
  const client: AgentSdkBindingClient = { accountFromAddress, accountFromPrivateKey, invoke }
  const serviceOptions = {
    agentId,
    gate,
    registry,
    memberResolver,
    contractAddressResolver,
    client,
  }
  const service = createWorkflowOperationService(serviceOptions)
  return { service, serviceOptions, events, gate, registry, getAgent, resolve, accountFromAddress, accountFromPrivateKey, invoke }
}

async function expectCode(promise: Promise<unknown>, code: string): Promise<TasError> {
  try {
    await promise
  } catch (error) {
    expect(error).toBeInstanceOf(TasError)
    expect((error as TasError).code).toBe(code)
    return error as TasError
  }
  throw new Error('Expected Workflow operation to fail')
}

describe('WorkflowOperationService', () => {
  it('asserts the current source gate before inspecting or dispatching an invocation', async () => {
    const gateError = new TasError('WORKFLOW_SOURCE_VERIFICATION_REQUIRED', 'verify first')
    const gate = { assertCurrent: vi.fn(async () => { throw gateError }) }
    const app = harness({ gate })
    const hostile = new Proxy({} as never, { ownKeys: () => { throw new Error('must not inspect') } })

    await expect(app.service.invoke(hostile)).rejects.toBe(gateError)
    expect(gate.assertCurrent).toHaveBeenCalledTimes(1)
    expect(app.registry.get).not.toHaveBeenCalled()
    expect(app.invoke).not.toHaveBeenCalled()
  })

  it('decodes function inputs in declared positional order and preserves an omitted optional hole', async () => {
    const runtimeTool = entry({
      binding: {
        kind: 'function',
        target: 'computeTaskHash',
        arguments: [
          { kind: 'input', name: 'first' },
          { kind: 'input', name: 'optionalMiddle' },
          { kind: 'runtime', source: 'chain_config' },
          { kind: 'input', name: 'last' },
        ],
      },
      runtime_dependencies: ['chain_client', 'contract_address'],
    })
    const app = harness({ tool: runtimeTool })

    await expect(app.service.invoke({
      toolName: runtimeTool.name,
      arguments: { first: 'alpha', last: '42' },
    })).resolves.toBe('17')

    expect(app.invoke).toHaveBeenCalledWith(runtimeTool, [
      'alpha',
      undefined,
      { rpcUrl: context.rpcUrl, address: selectedAddress },
      42n,
    ], { chainId: context.chainId, rpcUrl: context.rpcUrl, contractAddress: selectedAddress })
    expect(app.resolve).toHaveBeenCalledWith(runtimeTool, context)
    expect(app.getAgent).not.toHaveBeenCalled()
  })

  it('captures its injected boundaries once when the service is constructed', async () => {
    const app = harness()
    const mutable = app.serviceOptions as unknown as Record<string, unknown>
    mutable.gate = { assertCurrent: async () => { throw new Error('replacement gate') } }
    mutable.client = { invoke: async () => { throw new Error('replacement client') } }
    mutable.registry = { get: () => undefined }

    await expect(app.service.invoke({
      toolName: entry().name,
      arguments: { first: 'alpha', last: '42' },
    })).resolves.toBe('17')
    expect(app.invoke).toHaveBeenCalledTimes(1)
  })

  it('creates a new address-only Account from the same-block member wallet for every read class call', async () => {
    const tool = classEntry()
    const app = harness({ tool, invoke: async () => ({ sequence: 9n }) })
    const invocation = { toolName: tool.name, arguments: { taskHash: 'task-1' } }

    await expect(app.service.invoke(invocation)).resolves.toEqual({ sequence: '9' })
    await expect(app.service.invoke(invocation)).resolves.toEqual({ sequence: '9' })

    expect(app.getAgent).toHaveBeenCalledTimes(2)
    expect(app.getAgent).toHaveBeenNthCalledWith(1, agentId, context.blockSelector)
    expect(app.accountFromAddress).toHaveBeenCalledTimes(2)
    const firstAccount = app.invoke.mock.calls[0]?.[2].account
    const secondAccount = app.invoke.mock.calls[1]?.[2].account
    expect(firstAccount).not.toBe(secondAccount)
    expect(firstAccount).toMatchObject({ address: memberWallet })
    expect(app.invoke).toHaveBeenNthCalledWith(1, tool, ['task-1'], {
      account: firstAccount,
      chainId: context.chainId,
      rpcUrl: context.rpcUrl,
      contractAddress: selectedAddress,
    })
  })

  it('constructs a write Account per call and authorizes it against the same-block member wallet', async () => {
    const tool = classEntry({
      name: 'workflow.execution.erc8301.agent_workflow.on_agent_reply',
      source: { entrypoint: './execution/ERC8301', export: 'AgentWorkflowClient', member: 'onAgentReply' },
      binding: { kind: 'class_method', target: 'AgentWorkflowClient.onAgentReply', arguments: [{ kind: 'input', name: 'reply' }] },
      input_schema: objectSchema({
        credential: { type: 'object' },
        reply: { type: 'string' },
      }, ['reply']),
      output_schema: { $schema: 'https://json-schema.org/draft/2020-12/schema', type: 'string' },
      operation: { effect: 'side_effect', completion: 'external_handle' },
      credential: 'evm_private_key',
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    })
    const app = harness({ tool, invoke: async () => '0xreceipt' })
    const invocation = {
      toolName: tool.name,
      arguments: { reply: 'reply-1', credential: { type: 'inline', secret: privateKey } },
    }

    await expect(app.service.invoke(invocation)).resolves.toBe('0xreceipt')
    await expect(app.service.invoke(invocation)).resolves.toBe('0xreceipt')

    expect(app.accountFromPrivateKey).toHaveBeenCalledTimes(2)
    expect(app.getAgent).toHaveBeenCalledTimes(2)
    expect(app.getAgent).toHaveBeenNthCalledWith(1, agentId, context.blockSelector)
    for (const call of app.invoke.mock.calls) {
      expect(call[1]).toEqual(['reply-1'])
      expect(call[2].account).toMatchObject({ address: memberWallet })
      expect(JSON.stringify(call)).not.toContain(privateKey)
    }
  })

  it('rejects a write key that is not the current same-block authentication wallet', async () => {
    const tool = classEntry({
      operation: { effect: 'side_effect', completion: 'external_handle' },
      credential: 'evm_private_key',
      input_schema: objectSchema({ credential: { type: 'object' }, taskHash: { type: 'string' } }, ['taskHash']),
    })
    const app = harness({ tool, privateKeyAddress: '0x5000000000000000000000000000000000000005' })

    await expectCode(app.service.invoke({
      toolName: tool.name,
      arguments: { taskHash: 'task-1', credential: { type: 'inline', secret: privateKey } },
    }), 'WALLET_MISMATCH')
    expect(app.invoke).not.toHaveBeenCalled()
  })

  it('rejects a malformed write credential before any address or membership lookup', async () => {
    const tool = classEntry({
      operation: { effect: 'side_effect', completion: 'external_handle' },
      credential: 'evm_private_key',
      input_schema: objectSchema({ credential: { type: 'object' }, taskHash: { type: 'string' } }, ['taskHash']),
    })
    const app = harness({ tool })

    await expectCode(app.service.invoke({
      toolName: tool.name,
      arguments: { taskHash: 'task-1', credential: { type: 'inline', secret: 'not-a-key' } },
    }), 'CREDENTIAL_REQUIRED')
    expect(app.resolve).not.toHaveBeenCalled()
    expect(app.getAgent).not.toHaveBeenCalled()
    expect(app.invoke).not.toHaveBeenCalled()
  })

  it('rejects an address-only Account that does not represent the resolved member wallet', async () => {
    const tool = classEntry()
    const app = harness({ tool })
    app.accountFromAddress.mockReturnValueOnce({
      address: '0x5000000000000000000000000000000000000005',
    } as unknown as Account)

    await expectCode(app.service.invoke({
      toolName: tool.name,
      arguments: { taskHash: 'task-1' },
    }), 'EXTERNAL_UNAVAILABLE')
    expect(app.invoke).not.toHaveBeenCalled()
  })

  it('maps an external-handle failure to unknown outcome and never retries it', async () => {
    const tool = classEntry({
      operation: { effect: 'side_effect', completion: 'external_handle' },
      credential: 'evm_private_key',
      input_schema: objectSchema({ credential: { type: 'object' }, taskHash: { type: 'string' } }, ['taskHash']),
    })
    const app = harness({ tool, invoke: async () => { throw new Error(`upstream leaked ${privateKey}`) } })

    const error = await expectCode(app.service.invoke({
      toolName: tool.name,
      arguments: { taskHash: 'task-1', credential: { type: 'inline', secret: privateKey } },
    }), 'OPERATION_OUTCOME_UNKNOWN')
    expect(error.message).not.toContain(privateKey)
    expect(app.invoke).toHaveBeenCalledTimes(1)
  })

  it('preserves a binding capability rejection without exposing adapter detail', async () => {
    const app = harness({
      invoke: async () => {
        throw new TasError('MANIFEST_BINDING_UNSUPPORTED', `adapter detail ${privateKey}`)
      },
    })

    const error = await expectCode(app.service.invoke({
      toolName: entry().name,
      arguments: { first: 'alpha', last: '42' },
    }), 'MANIFEST_BINDING_UNSUPPORTED')
    expect(error.message).toBe('The requested Workflow binding is unavailable.')
    expect(error.message).not.toContain(privateKey)
    expect(app.invoke).toHaveBeenCalledTimes(1)
  })

  it('rejects invalid schema inputs before invoking the binding', async () => {
    const app = harness()
    await expectCode(app.service.invoke({
      toolName: entry().name,
      arguments: { first: 'alpha', last: 'not-a-bigint' },
    }), 'INVALID_ARGUMENT')
    expect(app.invoke).not.toHaveBeenCalled()
  })
})
