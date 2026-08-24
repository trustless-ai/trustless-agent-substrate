import { describe, expect, it } from 'vitest'

import { dependencyManifestSchema, parseDependencyManifest, viemMemberToToolSegment } from '../../../src/mcp/manifest/types.js'

const integrity = 'sha512-4QPIX0eYPLsOBk53NKswVMkQoxuP7GlOBnB4wM6dkDokREO4QENNc3bmyPKK1PBTViXh0TPJCHLjIuU20Qi3fg=='

function tool(profile: 'viem-public' | 'viem-wallet', name = profile === 'viem-public'
  ? 'workflow.chain.public.get_block'
  : 'workflow.chain.wallet.send_transaction') {
  const isWallet = profile === 'viem-wallet'
  const member = isWallet ? 'sendTransaction' : 'getBlock'
  const sourceExport = isWallet ? 'WalletActions' : 'PublicActions'

  return {
    name,
    description: `Invoke viem ${member}.`,
    source: {
      entrypoint: './actions',
      export: sourceExport,
      member,
    },
    binding: { kind: 'client_action', target: `${sourceExport}.${member}` },
    input_schema: isWallet
      ? {
        type: 'object',
        properties: {
          credential: {
            type: 'object',
            properties: {
              type: { const: 'inline' },
              secret: { type: 'string', minLength: 1, maxLength: 4_096, writeOnly: true },
            },
            additionalProperties: false,
          },
        },
        additionalProperties: false,
      }
      : { type: 'object', additionalProperties: false },
    output_schema: {},
    operation: {
      effect: isWallet ? 'side_effect' : 'read',
      completion: 'synchronous',
    },
    runtime_dependencies: isWallet ? ['chain_client', 'account'] : ['chain_client'],
    credential: isWallet ? 'evm_private_key' : 'none',
    annotations: {
      readOnlyHint: !isWallet,
      destructiveHint: false,
      idempotentHint: !isWallet,
      openWorldHint: true,
    },
  }
}

function manifest(profile: 'viem-public' | 'viem-wallet' = 'viem-public') {
  return {
    schema_version: 'tas-manifest/v1',
    manifest_id: profile,
    kind: 'dependency',
    source_profile: profile,
    source: {
      package: 'viem',
      version: '2.55.19',
      package_integrity: integrity,
      entrypoint_digest: `sha256:${'a'.repeat(64)}`,
      entrypoints: ['./actions'],
    },
    generator: {
      name: '@trustless-ai/tas-manifest',
      version: '0.1.0',
      typescript_version: '7.0.2',
    },
    tools: [tool(profile)],
  }
}

function agentSdkManifest() {
  return {
    schema_version: 'tas-manifest/v1',
    manifest_id: 'agent-sdk',
    kind: 'dependency',
    source_profile: 'agent-sdk',
    source: {
      package: '@trustless-ai/agent-sdk',
      version: '0.3.0',
      package_integrity: integrity,
      entrypoint_digest: `sha256:${'b'.repeat(64)}`,
      entrypoints: ['./execution/ERC8301', './execution/ERC8301/recompute', './verify/ERC8274'],
    },
    generator: {
      name: '@trustless-ai/tas-manifest',
      version: '0.1.0',
      typescript_version: '7.0.2',
    },
    tools: [
      {
        name: 'workflow.execution.erc8301.agent_workflow.result',
        description: 'Read one ERC-8301 Workflow result.',
        source: {
          entrypoint: './execution/ERC8301',
          export: 'AgentWorkflowClient',
          member: 'result',
        },
        binding: {
          kind: 'class_method',
          target: 'AgentWorkflowClient.result',
          arguments: [{ kind: 'input', name: 'taskId' }, { kind: 'input', name: 'options' }],
        },
        input_schema: {
          type: 'object',
          properties: { options: { type: 'string' }, taskId: { type: 'string' } },
          required: ['taskId'],
          additionalProperties: false,
        },
        output_schema: { type: 'object', additionalProperties: false },
        operation: { effect: 'read', completion: 'synchronous' },
        runtime_dependencies: ['chain_client', 'contract_address', 'account'],
        credential: 'none',
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: true,
        },
      },
      {
        name: 'workflow.execution.erc8301.recompute.compute_task_hash',
        description: 'Recompute one ERC-8301 task hash.',
        source: {
          entrypoint: './execution/ERC8301/recompute',
          export: 'computeTaskHash',
          member: 'computeTaskHash',
        },
        binding: {
          kind: 'function',
          target: 'computeTaskHash',
          arguments: [{ kind: 'input', name: 'task' }],
        },
        input_schema: {
          type: 'object',
          properties: { task: { type: 'string' } },
          required: ['task'],
          additionalProperties: false,
        },
        output_schema: { type: 'string', format: 'hex' },
        operation: { effect: 'read', completion: 'synchronous' },
        runtime_dependencies: [],
        credential: 'none',
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: true,
        },
      },
      {
        name: 'workflow.verify.erc8274.get_trusted_verifier',
        description: 'Resolve the configured trusted verifier.',
        source: {
          entrypoint: './verify/ERC8274',
          export: 'getTrustedVerifier',
          member: 'getTrustedVerifier',
        },
        binding: {
          kind: 'function',
          target: 'getTrustedVerifier',
          arguments: [{ kind: 'runtime', source: 'chain_config' }],
        },
        input_schema: { type: 'object', properties: {}, required: [], additionalProperties: false },
        output_schema: { type: 'string', format: 'evm-address' },
        operation: { effect: 'read', completion: 'synchronous' },
        runtime_dependencies: ['chain_client', 'contract_address'],
        credential: 'none',
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: true,
        },
      },
    ],
  }
}

describe('Dependency Manifest schema', () => {
  it.each([
    ['getBlock', 'get_block'],
    ['getEip712Domain', 'get_eip712_domain'],
    ['sendRawTransaction', 'send_raw_transaction'],
    ['URLValue', 'url_value'],
  ])('derives the canonical tool segment for %s', (member, expected) => {
    expect(viemMemberToToolSegment(member)).toBe(expected)
  })

  it.each(['viem-public', 'viem-wallet'] as const)('accepts one strict %s Manifest', (profile) => {
    const parsed = parseDependencyManifest(manifest(profile))

    expect(parsed).toEqual(manifest(profile))
    expect(dependencyManifestSchema.safeParse(parsed).success).toBe(true)
  })

  it('accepts one strict agent-sdk Manifest without treating constructor Account injection as a write credential', () => {
    expect(parseDependencyManifest(agentSdkManifest())).toEqual(agentSdkManifest())
  })

  it('fails closed on agent-sdk ownership, naming, binding, injection, and credential mismatches', () => {
    const base = agentSdkManifest()
    const read = base.tools[0]
    const recompute = base.tools[1]
    const configured = base.tools[2]
    const invalid = [
      { ...base, source: { ...base.source, package: 'viem' } },
      { ...base, tools: [{ ...read, name: 'workflow.chain.public.result' }, recompute, configured] },
      { ...base, tools: [{ ...read, binding: { kind: 'client_action', target: read.binding.target } }, recompute, configured] },
      { ...base, tools: [{ ...read, binding: { ...read.binding, target: 'AgentWorkflowClient.run' } }, recompute, configured] },
      { ...base, tools: [{ ...read, runtime_dependencies: ['chain_client', 'account'] }, recompute, configured] },
      { ...base, tools: [{ ...read, credential: 'evm_private_key' }, recompute, configured] },
      {
        ...base,
        tools: [{ ...read, operation: { ...read.operation, effect: 'side_effect' }, credential: 'none' }, recompute, configured],
      },
      {
        ...base,
        tools: [read, { ...recompute, source: { ...recompute.source, export: 'otherFunction' } }, configured],
      },
      {
        ...base,
        tools: [read, { ...recompute, operation: { ...recompute.operation, effect: 'side_effect' } }, configured],
      },
    ]

    for (const manifest_ of invalid) expect(() => parseDependencyManifest(manifest_)).toThrow()
  })

  it('fails closed when agent-sdk invocation slots do not exactly cover caller inputs and runtime injection', () => {
    const base = agentSdkManifest()
    const [read, recompute, configured] = base.tools
    const invalid = [
      { ...base, tools: [{ ...read, binding: { kind: 'class_method', target: read.binding.target } }, recompute, configured] },
      { ...base, tools: [{ ...read, binding: { ...read.binding, arguments: [{ kind: 'input', name: 'taskId' }] } }, recompute, configured] },
      { ...base, tools: [{ ...read, binding: { ...read.binding, arguments: [{ kind: 'input', name: 'taskId' }, { kind: 'input', name: 'taskId' }] } }, recompute, configured] },
      { ...base, tools: [read, { ...recompute, binding: { ...recompute.binding, arguments: [{ kind: 'runtime', source: 'chain_config' }] } }, configured] },
      { ...base, tools: [read, recompute, { ...configured, binding: { ...configured.binding, arguments: [] } }] },
      { ...base, tools: [read, recompute, { ...configured, runtime_dependencies: [] }] },
    ]

    for (const manifest_ of invalid) expect(() => parseDependencyManifest(manifest_)).toThrow()
  })

  it('rejects invocation arguments on viem client actions', () => {
    const value = manifest('viem-public')
    const publicTool = value.tools[0]
    expect(() => parseDependencyManifest({
      ...value,
      tools: [{ ...publicTool, binding: { ...publicTool.binding, arguments: [] } }],
    })).toThrow()
  })

  it('requires credential schemas to use the bounded common secret shape', () => {
    const wallet = manifest('viem-wallet')
    const walletTool = wallet.tools[0]
    const input = walletTool.input_schema as {
      readonly properties: { readonly credential: { readonly properties: { readonly secret: object } } }
    }
    expect(() => parseDependencyManifest({
      ...wallet,
      tools: [{
        ...walletTool,
        input_schema: {
          ...input,
          properties: {
            ...input.properties,
            credential: {
              ...input.properties.credential,
              properties: {
                ...input.properties.credential.properties,
                secret: { ...input.properties.credential.properties.secret, maxLength: 4_095 },
              },
            },
          },
        },
      }],
    })).toThrow()

    const public_ = manifest('viem-public')
    expect(() => parseDependencyManifest({
      ...public_,
      tools: [{ ...public_.tools[0], input_schema: walletTool.input_schema }],
    })).toThrow()
  })

  it.each([
    ['top-level', { unexpected: true }],
    ['source', { source: { ...manifest().source, unexpected: true } }],
    ['generator', { generator: { ...manifest().generator, unexpected: true } }],
    ['tool', { tools: [{ ...tool('viem-public'), unexpected: true }] }],
    ['tool source', { tools: [{ ...tool('viem-public'), source: { ...tool('viem-public').source, unexpected: true } }] }],
    ['binding', { tools: [{ ...tool('viem-public'), binding: { ...tool('viem-public').binding, unexpected: true } }] }],
    ['operation', { tools: [{ ...tool('viem-public'), operation: { ...tool('viem-public').operation, unexpected: true } }] }],
    ['annotations', { tools: [{ ...tool('viem-public'), annotations: { ...tool('viem-public').annotations, unexpected: true } }] }],
  ])('rejects unknown fields at the %s object', (_label, override) => {
    expect(() => parseDependencyManifest({ ...manifest(), ...override })).toThrow()
  })

  it('rejects duplicate tool names', () => {
    const duplicate = tool('viem-public')

    expect(() => parseDependencyManifest({ ...manifest(), tools: [duplicate, { ...duplicate }] })).toThrow()
  })

  it.each(['top', 'source', 'tool'] as const)('rejects an unknown own __proto__ field at the %s level', (level) => {
    const value = manifest()
    const target = level === 'top' ? value : level === 'source' ? value.source : value.tools[0]
    Object.defineProperty(target, '__proto__', {
      value: { unexpected: true },
      enumerable: true,
      configurable: true,
      writable: true,
    })

    expect(dependencyManifestSchema.safeParse(value).success).toBe(false)
    expect(() => parseDependencyManifest(value)).toThrow()
  })

  it('requires fields to be own data properties instead of accepting inherited values', () => {
    const value = manifest() as ReturnType<typeof manifest> & { schema_version?: string }
    const previous = Object.getOwnPropertyDescriptor(Object.prototype, 'schema_version')
    delete value.schema_version
    let result: ReturnType<typeof dependencyManifestSchema.safeParse> | undefined
    let calls = 0
    Object.defineProperty(Object.prototype, 'schema_version', {
      configurable: true,
      get() {
        calls += 1
        return 'tas-manifest/v1'
      },
    })
    try {
      result = dependencyManifestSchema.safeParse(value)
    } finally {
      if (previous === undefined) delete (Object.prototype as { schema_version?: unknown }).schema_version
      else Object.defineProperty(Object.prototype, 'schema_version', previous)
    }

    expect(result?.success).toBe(false)
    expect(calls).toBe(0)
  })

  it('fails closed without invoking an Object prototype setter during Zod projection', () => {
    const previous = Object.getOwnPropertyDescriptor(Object.prototype, 'schema_version')
    let calls = 0
    let result: ReturnType<typeof dependencyManifestSchema.safeParse> | undefined
    Object.defineProperty(Object.prototype, 'schema_version', {
      configurable: true,
      set() {
        calls += 1
      },
    })
    try {
      result = dependencyManifestSchema.safeParse(manifest())
    } finally {
      if (previous === undefined) delete (Object.prototype as { schema_version?: unknown }).schema_version
      else Object.defineProperty(Object.prototype, 'schema_version', previous)
    }

    expect(result?.success).toBe(false)
    expect(calls).toBe(0)
  })

  it('fails closed without invoking an Array prototype index setter during Zod projection', () => {
    const previous = Object.getOwnPropertyDescriptor(Array.prototype, '0')
    let calls = 0
    let result: ReturnType<typeof dependencyManifestSchema.safeParse> | undefined
    let failure: unknown
    Object.defineProperty(Array.prototype, '0', {
      configurable: true,
      set() {
        calls += 1
      },
    })
    try {
      result = dependencyManifestSchema.safeParse(manifest())
    } catch (error) {
      failure = error
    } finally {
      if (previous === undefined) delete (Array.prototype as unknown as Record<string, unknown>)['0']
      else Object.defineProperty(Array.prototype, '0', previous)
    }

    expect(failure).toBeInstanceOf(TypeError)
    expect(result).toBeUndefined()
    expect(calls).toBe(0)
  })

  it.each(['entrypoints', 'runtime_dependencies'] as const)('rejects a Proxy-backed %s array without reading it', (field) => {
    const value = manifest()
    let reads = 0
    const proxy = new Proxy(field === 'entrypoints' ? value.source.entrypoints : value.tools[0].runtime_dependencies, {
      get(target, property, receiver) {
        reads += 1
        return Reflect.get(target, property, receiver)
      },
    })
    if (field === 'entrypoints') value.source.entrypoints = proxy as string[]
    else value.tools[0].runtime_dependencies = proxy as string[]

    expect(dependencyManifestSchema.safeParse(value).success).toBe(false)
    expect(reads).toBe(0)
  })

  it.each([
    'workflow.chain.public',
    'workflow.chain.public.getBlock',
    'workflow.chain.public.get-block',
    'workflow.chain.public..get_block',
    'workflow.chain.wallet.get_block',
    'profile.get',
  ])('rejects a malformed or profile-inconsistent Public namespace: %s', (name) => {
    expect(() => parseDependencyManifest({ ...manifest(), tools: [tool('viem-public', name)] })).toThrow()
  })

  it.each([
    { package_integrity: undefined },
    { package_integrity: '' },
    { package_integrity: 'not-sri' },
    { package_integrity: 'sha512-YQ==' },
    { version: '^2.55.19' },
    { entrypoint_digest: `sha256:${'A'.repeat(64)}` },
    { entrypoints: [] },
    { entrypoints: ['./z', './a'] },
    { entrypoints: ['./actions', './actions'] },
    { entrypoints: ['./../private'] },
  ])('rejects malformed source metadata: %o', (sourceOverride) => {
    expect(() => parseDependencyManifest({
      ...manifest(),
      source: { ...manifest().source, ...sourceOverride },
    })).toThrow()
  })

  it('requires tools to be sorted by their full MCP names', () => {
    const first = tool('viem-public', 'workflow.chain.public.get_block')
    const second = {
      ...tool('viem-public', 'workflow.chain.public.call'),
      source: { ...tool('viem-public').source, member: 'call' },
      binding: { kind: 'client_action', target: 'PublicActions.call' },
    }

    expect(() => parseDependencyManifest({ ...manifest(), tools: [first, second] })).toThrow()
    expect(() => parseDependencyManifest({ ...manifest(), tools: [second, first] })).not.toThrow()
  })

  it('preserves prototype-named JSON Schema keys as inert data', () => {
    const inputSchema = JSON.parse('{"__proto__":{"type":"string"},"constructor":{"nested":{"type":"number"}},"toJSON":"inert"}') as Record<string, unknown>
    const publicTool = { ...tool('viem-public'), input_schema: inputSchema }

    const parsed = parseDependencyManifest({ ...manifest(), tools: [publicTool] })
    const projected = parsed.tools[0]?.input_schema as Record<string, unknown>

    expect(Object.keys(projected)).toEqual(['__proto__', 'constructor', 'toJSON'])
    expect(Object.getOwnPropertyDescriptor(projected, '__proto__')?.value).toEqual({ type: 'string' })
    expect(Object.getPrototypeOf(projected)).toBeNull()
    expect(Object.getPrototypeOf(projected.constructor as object)).toBeNull()
    expect(Object.getPrototypeOf((projected.constructor as { nested: object }).nested)).toBeNull()
    expect(projected.toJSON).toBe('inert')
    expect((Object.prototype as { type?: unknown }).type).toBeUndefined()
  })

  it.each(['input_schema', 'output_schema'] as const)('returns a detached inert clone for %s', (field) => {
    const nested = { type: 'string' }
    const source = { type: 'object', variants: [nested] }
    const publicTool = { ...tool('viem-public'), [field]: source }

    const parsed = parseDependencyManifest({ ...manifest(), tools: [publicTool] })
    const projected = parsed.tools[0]?.[field] as Record<string, unknown>
    const variants = projected.variants as unknown[]
    const projectedNested = Object.getOwnPropertyDescriptor(variants, '0')?.value as Record<string, unknown>

    nested.type = 'number'
    source.type = 'array'
    expect(projected.type).toBe('object')
    expect(projectedNested.type).toBe('string')
    expect(projected).not.toBe(source)
    expect(projectedNested).not.toBe(nested)
    expect(Object.getPrototypeOf(projected)).toBeNull()
    expect(Object.getPrototypeOf(variants)).toBeNull()
    expect(Object.getPrototypeOf(projectedNested)).toBeNull()
  })

  it.each(['input_schema', 'output_schema'] as const)('recursively rejects unsafe JSON values in %s without executing them', (field) => {
    let getterCalls = 0
    let proxyReads = 0
    const accessor = {}
    Object.defineProperty(accessor, 'type', {
      enumerable: true,
      get() {
        getterCalls += 1
        return 'string'
      },
    })
    const withSymbol = { type: 'object', [Symbol('hidden')]: true }
    const withHidden = { type: 'object' }
    Object.defineProperty(withHidden, 'hidden', { value: true })
    const proxy = new Proxy({}, {
      get(target, property, receiver) {
        proxyReads += 1
        return Reflect.get(target, property, receiver)
      },
    })
    const cycle: { self?: unknown } = {}
    cycle.self = cycle
    const invalid = [
      { nested: accessor },
      { nested: proxy },
      withSymbol,
      withHidden,
      { toJSON: () => ({}) },
      { nested: () => undefined },
      { nested: 1n },
      { nested: Number.NaN },
      { nested: Number.POSITIVE_INFINITY },
      cycle,
    ]

    for (const schema of invalid) {
      const publicTool = { ...tool('viem-public'), [field]: schema }
      expect(() => parseDependencyManifest({ ...manifest(), tools: [publicTool] })).toThrow()
    }
    expect(getterCalls).toBe(0)
    expect(proxyReads).toBe(0)
  })

  it('rejects Proxy-backed structural objects and embedded schemas', () => {
    const proxiedRoot = new Proxy(manifest(), {})
    const publicTool = { ...tool('viem-public'), input_schema: new Proxy({}, {}) }

    expect(() => parseDependencyManifest(proxiedRoot)).toThrow()
    expect(() => parseDependencyManifest({ ...manifest(), tools: [publicTool] })).toThrow()
  })

  it('requires manifest id, source profile, source export, binding, and entrypoint ownership to agree', () => {
    const base = manifest()
    const publicTool = tool('viem-public')
    const invalid = [
      { ...base, manifest_id: 'viem-wallet' },
      { ...base, source_profile: 'viem-wallet' },
      { ...base, tools: [{ ...publicTool, source: { ...publicTool.source, export: 'WalletActions' } }] },
      { ...base, tools: [{ ...publicTool, source: { ...publicTool.source, member: 'sendTransaction' } }] },
      { ...base, tools: [{ ...publicTool, source: { ...publicTool.source, entrypoint: './missing' } }] },
      { ...base, tools: [{ ...publicTool, binding: { kind: 'client_action', target: 'PublicActions.other' } }] },
      { ...base, tools: [{ ...publicTool, name: 'workflow.chain.public.send_transaction' }] },
    ]

    for (const value of invalid) expect(() => parseDependencyManifest(value)).toThrow()
  })

  it('requires exact runtime injection and credential rules for Public Actions', () => {
    const publicTool = tool('viem-public')
    const invalid = [
      { ...publicTool, runtime_dependencies: [] },
      { ...publicTool, runtime_dependencies: ['chain_client', 'account'] },
      { ...publicTool, runtime_dependencies: ['chain_client', 'chain_client'] },
      { ...publicTool, runtime_dependencies: ['chain_client', 'repository'] },
      { ...publicTool, credential: 'evm_private_key' },
    ]

    for (const value of invalid) {
      expect(() => parseDependencyManifest({ ...manifest(), tools: [value] })).toThrow()
    }
  })

  it('requires Account injection and an inline key for Wallet Actions', () => {
    const walletManifest = manifest('viem-wallet')
    const walletTool = tool('viem-wallet')
    const invalid = [
      { ...walletTool, runtime_dependencies: ['chain_client'] },
      { ...walletTool, runtime_dependencies: ['account'] },
      { ...walletTool, runtime_dependencies: ['account', 'chain_client'] },
      { ...walletTool, runtime_dependencies: ['chain_client', 'account', 'account'] },
      { ...walletTool, credential: 'none' },
    ]

    for (const value of invalid) {
      expect(() => parseDependencyManifest({ ...walletManifest, tools: [value] })).toThrow()
    }
  })
})
