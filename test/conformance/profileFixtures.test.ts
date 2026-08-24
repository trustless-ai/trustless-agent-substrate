import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

const fixtureDirectory = new URL('../fixtures/profile/public/', import.meta.url)
const canonicalDecimal = /^(?:0|[1-9][0-9]*)$/
const address = /^0x[0-9a-f]{40}$/
const blockHash = /^0x[0-9a-f]{64}$/
const gitCommit = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/
const forbiddenKey = /^(?:private[_-]?key|access[_-]?token|api[_-]?key|credential|secret)$/i
const credentialShape = /(?:\bgh[pousr]_[A-Za-z0-9_]{20,}\b|\bAKIA[0-9A-Z]{16}\b|-----BEGIN [A-Z ]*PRIVATE KEY-----|\b0x[0-9a-fA-F]{64}\b)/
const localAbsolutePath = /^(?:\/|[A-Za-z]:[\\/]|\\\\|file:\/\/)/i

type JsonRecord = { readonly [key: string]: JsonValue }
type JsonValue = null | boolean | number | string | readonly JsonValue[] | JsonRecord

function record(value: JsonValue, label: string): JsonRecord {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`)
  return value
}

function stringField(value: JsonRecord, key: string): string {
  const field = value[key]
  if (typeof field !== 'string') throw new Error(`${key} must be a string`)
  return field
}

function stringArrayField(value: JsonRecord, key: string): readonly string[] {
  const field = value[key]
  if (!Array.isArray(field) || field.some((item) => typeof item !== 'string')) throw new Error(`${key} must be a string array`)
  return field
}

function deepFreeze<T extends JsonValue>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) deepFreeze(child)
    Object.freeze(value)
  }
  return value
}

function loadFixture(name: string): JsonRecord {
  return record(deepFreeze(JSON.parse(readFileSync(new URL(name, fixtureDirectory), 'utf8')) as JsonValue), name)
}

function assertSafePublicValue(value: JsonValue, path = '$', rootBlockHashValidated = false): void {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error(`${path} contains a non-finite number`)
    return
  }
  if (typeof value === 'string') {
    if (!(rootBlockHashValidated && path === '$.block_hash') && credentialShape.test(value)) {
      throw new Error(`${path} contains credential-shaped material`)
    }
    if (localAbsolutePath.test(value)) throw new Error(`${path} contains a local absolute path`)
    if (/^https?:\/\//i.test(value) && !/^https:\/\/github\.com\/[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/.test(value)) {
      throw new Error(`${path} contains a non-Repository endpoint`)
    }
    return
  }
  if (value === null || typeof value === 'boolean') return
  if (Array.isArray(value)) {
    value.forEach((child, index) => assertSafePublicValue(child, `${path}[${index}]`, rootBlockHashValidated))
    return
  }
  for (const [key, child] of Object.entries(value)) {
    if (forbiddenKey.test(key)) throw new Error(`${path}.${key} is secret-bearing`)
    assertSafePublicValue(child, `${path}.${key}`, rootBlockHashValidated)
  }
}

function assertContext(fixture: JsonRecord): void {
  expect(stringField(fixture, 'chain_id')).toMatch(/^[1-9][0-9]*$/)
  expect(stringField(fixture, 'tawg_address')).toMatch(address)
  expect(stringField(fixture, 'block_number')).toMatch(canonicalDecimal)
  expect(stringField(fixture, 'block_hash')).toMatch(blockHash)
  expect(stringField(fixture, 'version')).toMatch(/^[1-9][0-9]*$/)
}

function assertProfileFixture(fixture: JsonRecord): void {
  assertContext(fixture)
  assertSafePublicValue(fixture, '$', true)
  expect(stringField(fixture, 'governance')).toMatch(address)
  const charter = record(fixture.charter, 'charter')
  expect(stringField(charter, 'repository')).toBe('https://github.com/trustless-ai/tawg-demo')
  expect(stringField(charter, 'commit')).toMatch(gitCommit)
  expect(stringField(charter, 'path')).toBe('charter/')
  const agents = record(fixture.agents, 'agents')
  expect(stringField(agents, 'identity_registry')).toMatch(address)
  expect(stringArrayField(agents, 'agent_ids')).toEqual([expect.stringMatching(canonicalDecimal)])
  const workflow = record(fixture.workflow, 'workflow')
  expect(stringField(workflow, 'address')).toMatch(address)
  expect(stringField(record(workflow.data, 'workflow.data'), 'source_commit')).toMatch(gitCommit)
}

function assertAgentFixture(fixture: JsonRecord, expectedMembership: boolean): void {
  assertContext(fixture)
  assertSafePublicValue(fixture, '$', true)
  expect(stringField(fixture, 'agent_id')).toMatch(canonicalDecimal)
  expect(fixture.is_member).toBe(expectedMembership)
  if (expectedMembership) {
    expect(stringField(fixture, 'agent_verifier')).toMatch(address)
    expect(stringField(fixture, 'agent_verifier')).not.toBe('0x0000000000000000000000000000000000000000')
    expect(stringField(fixture, 'authentication_wallet')).toMatch(address)
    expect(stringField(fixture, 'authentication_wallet')).not.toBe('0x0000000000000000000000000000000000000000')
  } else {
    expect(Object.keys(fixture).sort()).toEqual([
      'agent_id', 'block_hash', 'block_number', 'chain_id', 'is_member', 'tawg_address', 'version',
    ])
  }
}

function expectFrozenTree(value: JsonValue): void {
  if (value === null || typeof value !== 'object') return
  expect(Object.isFrozen(value)).toBe(true)
  for (const child of Object.values(value)) expectFrozenTree(child)
}

describe('immutable public Profile fixtures', () => {
  it('loads a complete frozen Profile snapshot with exact public identifiers and inert extensions', () => {
    const fixture = loadFixture('profile.json')
    assertProfileFixture(fixture)
    expect(BigInt(stringArrayField(record(fixture.agents, 'agents'), 'agent_ids')[0]!)).toBeGreaterThan(BigInt(Number.MAX_SAFE_INTEGER))
    const extensions = record(record(fixture.data, 'data').extensions, 'extensions')
    expect(Object.getOwnPropertyDescriptor(extensions, '__proto__')?.value).toEqual({ inert: true })
    expectFrozenTree(fixture)
  })

  it('loads frozen member and successful nonmember snapshots', () => {
    const member = loadFixture('member.json')
    const nonmember = loadFixture('nonmember.json')
    assertAgentFixture(member, true)
    assertAgentFixture(nonmember, false)
    expect(BigInt(stringField(member, 'agent_id'))).toBeGreaterThan(BigInt(Number.MAX_SAFE_INTEGER))
    expectFrozenTree(member)
    expectFrozenTree(nonmember)
  })

  it.each([
    ['numeric Agent ID', { agents: { identity_registry: '0x3000000000000000000000000000000000000003', agent_ids: [9_007_199_254_740_992] } }],
    ['numeric block', { block_number: 42 }],
    ['numeric version', { version: 1 }],
    ['short address', { tawg_address: '0x1234' }],
    ['short block hash', { block_hash: '0x1010' }],
    ['short commit', { charter: { repository: 'https://github.com/trustless-ai/tawg-demo', commit: 'abc1234', path: 'charter/' } }],
    ['RPC endpoint', { rpc_url: 'https://mainnet.example.org/rpc' }],
    ['private key', { private_key: `0x${'12'.repeat(32)}` }],
    ['access token', { access_token: ['gh', 'p_', '123456789012345678901234'].join('') }],
    ['token shape under an innocuous key', { public_note: ['gh', 'p_', '000000000000000000000000'].join('') }],
    ['local path', { source: '/Users/example/private/profile.json' }],
    ['etc path', { source: `/${['etc', 'passwd'].join('/')}` }],
    ['root path', { source: `/${['root', 'profile.json'].join('/')}` }],
    ['opt path', { source: `/${['opt', 'tas', 'profile.json'].join('/')}` }],
    ['Windows drive path with backslashes', { source: ['C:', 'Users', 'example', 'profile.json'].join('\\') }],
    ['Windows drive path with slashes', { source: ['D:', 'tas', 'profile.json'].join('/') }],
    ['UNC path with backslashes', { source: `\\\\${['server', 'share', 'profile.json'].join('\\')}` }],
    ['UNC path with slashes', { source: `//${['server', 'share', 'profile.json'].join('/')}` }],
    ['file URL', { source: ['file:', '', '', 'etc', 'passwd'].join('/') }],
    ['nested block hash containing key-shaped material', {
      data: { extensions: { block_hash: `0x${'78'.repeat(32)}` } },
    }],
  ])('rejects a contaminated fixture variant: %s', (_name, replacement) => {
    const fixture = loadFixture('profile.json')
    const contaminated = deepFreeze({ ...fixture, ...replacement } as JsonRecord)
    expect(() => assertProfileFixture(contaminated)).toThrow()
  })
})
