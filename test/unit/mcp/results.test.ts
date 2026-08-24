import { describe, expect, it } from 'vitest'

import { TasError } from '../../../src/core/errors.js'
import {
  createTasResultBuilder,
  type ResolutionContext,
  type TasPublicInstance,
} from '../../../src/mcp/results.js'

const tawgAddress = '0x8004000000000000000000000000000000000002' as const
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

const member: TasPublicInstance = {
  phase: 'member',
  chain_id: '31337',
  tawg_address: tawgAddress,
  agent_id: '340282366920938463463374607431768211457',
}

const resolution = {
  chain: { block_number: '42', block_hash: '0xabc' },
  profile: { version: '1' },
  repository: { url: 'https://github.com/trustless-ai/tawg', commit: 'a'.repeat(40) },
  da: { type: 'git', commit: 'b'.repeat(40), path: 'data/result.json' },
} satisfies ResolutionContext

describe('native TAS MCP results', () => {
  it('preserves scalar and array success values for generated dependency tools', () => {
    const builder = createTasResultBuilder(member)

    expect(builder.success('42').structuredContent).toMatchObject({ data: '42' })
    expect(builder.success(['0x01', { ok: true }]).structuredContent).toMatchObject({
      data: ['0x01', { ok: true }],
    })
  })

  it('returns a native success result with only context and data as structured content', () => {
    const result = createTasResultBuilder(member, resolution).success({ value: 'complete' })

    expect(result).toMatchObject({
      content: [{ type: 'text', text: 'Tool completed.' }],
      structuredContent: {
        context: {
          instance: member,
          request_id: expect.stringMatching(uuid),
          resolved: resolution,
        },
        data: { value: 'complete' },
      },
    })
    expect(result.isError).toBeUndefined()
    expect(JSON.stringify(result)).not.toMatch(/"(?:ok|success|operation_id|retry_journal)"/)
  })

  it.each<TasPublicInstance>([
    { phase: 'identity_setup', chain_id: '1', identity_registry_address: tawgAddress },
    { phase: 'tawg_setup', chain_id: '1', tawg_address: tawgAddress },
    member,
  ])('projects the canonical %s context variant', (instance) => {
    const result = createTasResultBuilder(instance).success({})

    expect(result.structuredContent).toEqual({
      context: { instance, request_id: expect.stringMatching(uuid) },
      data: {},
    })
  })

  it('creates a valid, fresh UUID request ID for every result invocation', () => {
    const results = createTasResultBuilder(member)

    const first = results.success({})
    const second = results.toolError(new TasError('CONFIG_FIELD_INVALID', 'Invalid configuration field', { field: 'chain_id' }))

    const firstId = (first.structuredContent as { context: { request_id: string } }).context.request_id
    const secondId = (second.structuredContent as { context: { request_id: string } }).context.request_id

    expect(firstId).toMatch(uuid)
    expect(secondId).toMatch(uuid)
    expect(secondId).not.toBe(firstId)
  })

  it('returns a native MCP tool error with an allowlisted TAS error projection', () => {
    const result = createTasResultBuilder(member, resolution)
      .toolError(new TasError('CONFIG_FIELD_INVALID', 'Invalid configuration field', { field: 'chain_id' }))

    expect(result).toEqual({
      content: [{ type: 'text', text: 'Invalid configuration field' }],
      isError: true,
      structuredContent: {
        context: {
          instance: member,
          request_id: expect.stringMatching(uuid),
          resolved: resolution,
        },
        error: {
          code: 'CONFIG_FIELD_INVALID',
          category: 'configuration',
          message: 'Invalid configuration field',
          retryable: false,
          recovery: { action: 'change_request' },
        },
      },
    })
  })

  it('does not serialize an unknown Error message, stack, cause, or upstream response body', () => {
    const secret = 'upstream-secret-that-must-not-appear'
    const error = Object.assign(new Error(secret), {
      cause: { response: { body: { token: secret } } },
      request: { authorization: secret },
      response: { body: { credential: secret } },
      stack: secret,
    })

    const result = createTasResultBuilder(member).toolError(error)

    expect(result.structuredContent).toEqual({
      context: { instance: member, request_id: expect.stringMatching(uuid) },
      error: {
        code: 'INTERNAL_ERROR',
        category: 'internal',
        message: 'The tool could not be completed.',
        retryable: false,
        recovery: { action: 'abort' },
      },
    })
    expect(JSON.stringify(result)).not.toContain(secret)
  })

  it('requires reconciliation instead of retry when an external side-effect outcome is unknown', () => {
    const result = createTasResultBuilder(member).toolError(new TasError(
      'OPERATION_OUTCOME_UNKNOWN',
      'untrusted source message',
    ))

    expect(result.structuredContent).toMatchObject({
      error: {
        code: 'OPERATION_OUTCOME_UNKNOWN',
        retryable: false,
        recovery: { action: 'reconcile' },
      },
    })
  })

  it('requires source verification reconciliation before a Workflow operation', () => {
    const result = createTasResultBuilder(member).toolError(new TasError(
      'WORKFLOW_SOURCE_VERIFICATION_REQUIRED',
      'untrusted source message',
    ))

    expect(result.structuredContent).toMatchObject({
      error: {
        code: 'WORKFLOW_SOURCE_VERIFICATION_REQUIRED',
        category: 'conflict',
        retryable: false,
        recovery: { action: 'reconcile' },
      },
    })
  })

  it.each([
    ['WORKFLOW_SOURCE_UNAVAILABLE', 'unavailable', true, 'retry'],
    ['WORKFLOW_METADATA_INVALID', 'integrity', false, 'abort'],
    ['WORKFLOW_COMPILER_UNAVAILABLE', 'configuration', false, 'user_action'],
    ['WORKFLOW_COMPILER_BUSY', 'unavailable', true, 'retry'],
    ['WORKFLOW_COMPILE_FAILED', 'integrity', false, 'abort'],
    ['WORKFLOW_DEPLOYMENT_UNSUPPORTED', 'integrity', false, 'abort'],
  ] as const)('projects the Workflow source error %s', (code, category, retryable, action) => {
    const result = createTasResultBuilder(member).toolError(new TasError(code, 'untrusted detail'))

    expect(result.structuredContent).toMatchObject({
      error: { code, category, retryable, recovery: { action } },
    })
    expect(JSON.stringify(result)).not.toContain('untrusted detail')
  })

  it('projects only allowlisted resolution fields instead of traversing injected secrets', () => {
    const secret = 'rpc-url-that-must-not-appear'
    const contaminated = {
      ...resolution,
      chain: { ...resolution.chain, rpc_url: secret },
      credential: secret,
    } as ResolutionContext

    const result = createTasResultBuilder(member, contaminated).success({})

    expect(JSON.stringify(result)).not.toContain(secret)
  })

  it('preserves legitimate JSON success fields without applying logging redaction', () => {
    const result = createTasResultBuilder(member).success({ credential_name: 'public credential label' })

    expect(result.structuredContent).toEqual({
      context: { instance: member, request_id: expect.stringMatching(uuid) },
      data: { credential_name: 'public credential label' },
    })
  })

  it('preserves prototype-named JSON keys as inert data properties', () => {
    const data = JSON.parse('{"__proto__":{"polluted":true},"constructor":"safe","prototype":1,"toJSON":"inert"}') as Record<string, unknown>
    const result = createTasResultBuilder(member).success({ data } as never)
    const projected = (result.structuredContent as { data: { data: Record<string, unknown> } }).data.data

    expect(Object.getPrototypeOf(projected)).toBeNull()
    expect(Object.keys(projected)).toEqual(['__proto__', 'constructor', 'prototype', 'toJSON'])
    expect(Object.getOwnPropertyDescriptor(projected, '__proto__')?.value).toEqual({ polluted: true })
    expect((Object.prototype as { polluted?: unknown }).polluted).toBeUndefined()
  })

  it('retains an immutable IPFS resolution without adding empty resolution sections', () => {
    const result = createTasResultBuilder(member, {
      chain: { block_number: '0', block_hash: '0x0' },
      da: { type: 'ipfs', cid: 'bafybeigdyrzt' },
    }).success({ items: [] })

    expect(result.structuredContent).toEqual({
      context: {
        instance: member,
        request_id: expect.stringMatching(uuid),
        resolved: {
          chain: { block_number: '0', block_hash: '0x0' },
          da: { type: 'ipfs', cid: 'bafybeigdyrzt' },
        },
      },
      data: { items: [] },
    })
  })

  it('uses fixed TasError messages and omits all details', () => {
    const secret = 'tas-error-secret-that-must-not-appear'
    const error = new TasError('CONFIG_FIELD_INVALID', secret, {
      field: 'chain_id',
      variable: 'TAS_RPC_URL',
      nested: secret,
    } as never)

    const result = createTasResultBuilder(member).toolError(error)

    expect(result.structuredContent).toEqual({
      context: { instance: member, request_id: expect.stringMatching(uuid) },
      error: {
        code: 'CONFIG_FIELD_INVALID',
        category: 'configuration',
        message: 'Invalid configuration field',
        retryable: false,
        recovery: { action: 'change_request' },
      },
    })
    expect(JSON.stringify(result)).not.toContain(secret)
  })

  it.each([
    [
      'REPOSITORY_CURSOR_INVALID',
      {
        code: 'REPOSITORY_CURSOR_INVALID',
        category: 'configuration',
        message: 'The Repository cursor is invalid.',
        retryable: false,
        recovery: { action: 'change_request' },
      },
    ],
    [
      'REPOSITORY_CURSOR_CONTEXT_MISMATCH',
      {
        code: 'REPOSITORY_CURSOR_CONTEXT_MISMATCH',
        category: 'conflict',
        message: 'The Repository cursor does not match the current request context.',
        retryable: false,
        recovery: { action: 'change_request' },
      },
    ],
    [
      'REPOSITORY_NOT_FOUND',
      {
        code: 'REPOSITORY_NOT_FOUND',
        category: 'unavailable',
        message: 'The Profile-selected Repository was not found.',
        retryable: false,
        recovery: { action: 'user_action' },
      },
    ],
    [
      'REPOSITORY_FETCH_FAILED',
      {
        code: 'REPOSITORY_FETCH_FAILED',
        category: 'unavailable',
        message: 'The Profile-selected Repository could not be read.',
        retryable: true,
        recovery: { action: 'retry' },
      },
    ],
    [
      'REPOSITORY_RATE_LIMITED',
      {
        code: 'REPOSITORY_RATE_LIMITED',
        category: 'unavailable',
        message: 'The Repository provider rate limit was reached.',
        retryable: true,
        recovery: { action: 'retry' },
      },
    ],
    [
      'SKILL_NOT_FOUND',
      {
        code: 'SKILL_NOT_FOUND',
        category: 'unavailable',
        message: 'The requested Skill was not found.',
        retryable: false,
        recovery: { action: 'user_action' },
      },
    ],
    [
      'SKILL_INVALID',
      {
        code: 'SKILL_INVALID',
        category: 'integrity',
        message: 'The requested Skill content is invalid.',
        retryable: false,
        recovery: { action: 'abort' },
      },
    ],
    [
      'SKILL_ROLE_INVALID',
      {
        code: 'SKILL_ROLE_INVALID',
        category: 'configuration',
        message: 'The Role Skill identifier is invalid.',
        retryable: false,
        recovery: { action: 'change_request' },
      },
    ],
    [
      'SKILL_MEMBER_CONTEXT_REQUIRED',
      {
        code: 'SKILL_MEMBER_CONTEXT_REQUIRED',
        category: 'configuration',
        message: 'A valid TAWG member context is required to load this Skill.',
        retryable: false,
        recovery: { action: 'user_action' },
      },
    ],
    [
      'SKILL_FETCH_FAILED',
      {
        code: 'SKILL_FETCH_FAILED',
        category: 'unavailable',
        message: 'The requested Skill could not be read.',
        retryable: true,
        recovery: { action: 'retry' },
      },
    ],
    [
      'SKILL_CONTENT_TOO_LARGE',
      {
        code: 'SKILL_CONTENT_TOO_LARGE',
        category: 'integrity',
        message: 'The requested Skill exceeds the content size limit.',
        retryable: false,
        recovery: { action: 'abort' },
      },
    ],
  ] as const)('uses a fixed public projection for %s', (code, expected) => {
    const result = createTasResultBuilder(member).toolError(new TasError(code, 'untrusted cursor detail'))

    expect(result.structuredContent).toMatchObject({ error: expected })
    expect(JSON.stringify(result)).not.toContain('untrusted cursor detail')
  })

  it.each([
    'https://github.com/trustless-ai/tawg.git',
    'https://user:secret@github.com/trustless-ai/tawg',
    'https://github.com/trustless-ai/tawg?token=secret',
    'https://github.com/trustless-ai/tawg/',
    'http://github.com/trustless-ai/tawg',
  ])('rejects a non-canonical repository URL without echoing it', (url) => {
    expect(() => createTasResultBuilder(member, {
      repository: { url, commit: 'a'.repeat(40) },
    })).toThrow('TAS public result invariant violated.')
  })

  it('clones repeated JSON aliases but rejects unsafe or cyclic success data', () => {
    const shared = { label: 'shared' }
    const success = createTasResultBuilder(member).success({ first: shared, second: shared })
    const invalidValues = [
      { value: 1n },
      { value: () => undefined },
      { value: Symbol('secret') },
      { value: undefined },
      { value: Number.NaN },
      { value: Number.POSITIVE_INFINITY },
      { get value() { throw new Error('getter must not run') } },
      new Proxy({}, { ownKeys() { throw new Error('proxy must not run twice') } }),
    ]
    const cyclic: { self?: unknown } = {}
    cyclic.self = cyclic

    expect(success.structuredContent).toMatchObject({
      data: { first: { label: 'shared' }, second: { label: 'shared' } },
    })
    for (const invalid of [...invalidValues, cyclic]) {
      expect(() => createTasResultBuilder(member).success(invalid)).toThrow('TAS public result invariant violated.')
    }
    expect(() => createTasResultBuilder(member).success({ values: Array.from({ length: 10_001 }, () => 0) })).toThrow('TAS public result invariant violated.')
    const arrayWithExtra = [0] as Array<number> & { extra?: number }
    arrayWithExtra.extra = 1
    expect(() => createTasResultBuilder(member).success({ values: arrayWithExtra })).toThrow('TAS public result invariant violated.')
  })

  it('accepts a dense nested 5,001-item array within the shared entry budget and rejects 10,001 items', () => {
    const builder = createTasResultBuilder(member)
    const accepted = builder.success({ values: Array.from({ length: 5_001 }, (_, index) => index) })

    expect(accepted.structuredContent).toMatchObject({
      data: { values: expect.arrayContaining([0, 5_000]) },
    })
    expect((accepted.structuredContent as { data: { values: number[] } }).data.values).toHaveLength(5_001)
    expect(() => builder.success({ values: Array.from({ length: 10_001 }, () => 0) })).toThrow('TAS public result invariant violated.')
  })

  it('stops guarded wide-object projection at the shared entry boundary', () => {
    let descriptorReads = 0
    const descriptorKeys = new Set<string>()
    const wide = new Proxy({}, {
      ownKeys: () => Array.from({ length: 20_000 }, (_, index) => String(index)),
      getOwnPropertyDescriptor: (_target, key) => {
        descriptorReads += 1
        descriptorKeys.add(String(key))
        return { configurable: true, enumerable: true, value: 0, writable: true }
      },
    })

    expect(() => createTasResultBuilder(member).success(wide)).toThrow('TAS public result invariant violated.')
    expect(descriptorKeys.size).toBe(10_000)
    expect(descriptorReads).toBe(20_000)
  })

  it('snapshots each optional resolution field by one own data descriptor without ordinary gets', () => {
    const descriptorReads = new Map<string, number>()
    let ordinaryGets = 0
    const statefulResolution = new Proxy({ ...resolution }, {
      getOwnPropertyDescriptor: (target, key) => {
        const name = String(key)
        descriptorReads.set(name, (descriptorReads.get(name) ?? 0) + 1)
        return Reflect.getOwnPropertyDescriptor(target, key)
      },
      get: () => {
        ordinaryGets += 1
        throw new Error('ordinary property access must not be used')
      },
    })

    const result = createTasResultBuilder(member, statefulResolution).success({})

    expect(result.structuredContent).toMatchObject({ context: { resolved: resolution } })
    expect(Object.fromEntries(descriptorReads)).toEqual({ profile: 1, chain: 1, repository: 1, da: 1 })
    expect(ordinaryGets).toBe(0)
  })

  it('rejects an enumerable optional-resolution accessor without invoking it', () => {
    let getterCalls = 0
    const accessorResolution: Record<string, unknown> = {}
    Object.defineProperty(accessorResolution, 'profile', {
      configurable: true,
      enumerable: true,
      get: () => {
        getterCalls += 1
        return { version: '1' }
      },
    })

    expect(() => createTasResultBuilder(member, accessorResolution as ResolutionContext)).toThrow('TAS public result invariant violated.')
    expect(getterCalls).toBe(0)
  })

  it('captures a proxied TasError code once and projects its first validated value', () => {
    let descriptorReads = 0
    let ordinaryGets = 0
    const error = new Proxy(new TasError('CONFIG_FIELD_INVALID', 'untrusted message'), {
      getOwnPropertyDescriptor: (target, key) => {
        if (key === 'code') {
          descriptorReads += 1
          const descriptor = Reflect.getOwnPropertyDescriptor(target, key)
          return descriptorReads === 1 ? descriptor : { ...descriptor, value: 'CONFIG_CONFLICT' }
        }
        return Reflect.getOwnPropertyDescriptor(target, key)
      },
      get: (target, key, receiver) => {
        ordinaryGets += 1
        return Reflect.get(target, key, receiver)
      },
    })

    const result = createTasResultBuilder(member).toolError(error)

    expect(result.structuredContent).toMatchObject({ error: { code: 'CONFIG_FIELD_INVALID', message: 'Invalid configuration field' } })
    expect(descriptorReads).toBe(1)
    expect(ordinaryGets).toBe(0)
  })

  it('falls back to INTERNAL_ERROR for invalid or inherited TasError codes', () => {
    const invalid = new TasError('CONFIG_FIELD_INVALID', 'untrusted message') as TasError & { code: string }
    Object.defineProperty(invalid, 'code', { configurable: true, enumerable: true, value: 'NOT_A_TAS_ERROR_CODE', writable: true })
    const inherited = Object.create(Object.assign(Object.create(TasError.prototype), { code: 'CONFIG_FIELD_INVALID' }))

    for (const error of [invalid, inherited]) {
      const result = createTasResultBuilder(member).toolError(error)
      expect(result.structuredContent).toMatchObject({ error: { code: 'INTERNAL_ERROR', message: 'The tool could not be completed.' } })
    }
  })

  it('snapshots the public instance when the builder is created', () => {
    const mutableMember = { ...member }
    const builder = createTasResultBuilder(mutableMember)
    mutableMember.chain_id = '1'
    mutableMember.agent_id = '2'

    const result = builder.success({})

    expect(result.structuredContent).toMatchObject({ context: { instance: member } })
  })

  it('returns a newly detached resolution context for every result', () => {
    const builder = createTasResultBuilder(member, resolution)
    const first = builder.success({})
    const firstResolved = (first.structuredContent as { context: { resolved: { chain: { block_number: string } } } }).context.resolved
    firstResolved.chain.block_number = '999'

    const second = builder.success({})

    expect(second.structuredContent).toMatchObject({ context: { resolved: resolution } })
  })

  it.each([
    'https://github.com/trustless-ai-',
    'https://github.com/trustless--ai/tawg',
    `https://github.com/${'a'.repeat(40)}/tawg`,
    'https://github.com/trustless-ai/.',
    'https://github.com/trustless-ai/..',
    `https://github.com/trustless-ai/${'a'.repeat(101)}`,
    'https://github.com/trustless-ai/tawg.GiT',
  ])('rejects invalid GitHub repository component %s', (url) => {
    expect(() => createTasResultBuilder(member, {
      repository: { url, commit: 'a'.repeat(40) },
    })).toThrow('TAS public result invariant violated.')
  })

  it('accepts a canonical .github repository name', () => {
    const result = createTasResultBuilder(member, {
      repository: { url: 'https://github.com/trustless-ai/.github', commit: 'a'.repeat(40) },
    }).success({})

    expect(result.structuredContent).toMatchObject({
      context: { resolved: { repository: { url: 'https://github.com/trustless-ai/.github' } } },
    })
  })
})
