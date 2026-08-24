import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { API, TypeFlags } from 'typescript/unstable/sync'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { analyzeViemActions } from '../../../tools/manifest/analyzeViem.js'
import {
  encodeTypeSchema,
  projectViemActionSchemas,
  type ActionSchemaProjection,
} from '../../../tools/manifest/schemaEncoder.js'

const repositoryRoot = resolve(import.meta.dirname, '../../..')
const fixtureIntegrity = `sha512-${Buffer.alloc(64, 9).toString('base64')}`
let fixtureRoot: string
let fixtureDeclaration: string

beforeAll(() => {
  fixtureRoot = mkdtempSync(join(tmpdir(), 'tas-schema-fixture-'))
  fixtureDeclaration = join(fixtureRoot, 'schema-mini.d.ts')
  writeFileSync(fixtureDeclaration, `
export interface PrivateKeyAccount { readonly address: Address; readonly type: 'local'; readonly sign: (value: Hex) => Promise<Hex> }
export type Address = \`0x\${string}\`
export type Hex = \`0x\${string}\`
export type Account = PrivateKeyAccount | { readonly address: Address; readonly type: 'json-rpc' }
export interface AbiParameter { readonly name?: string; readonly type: string; readonly components?: readonly AbiParameter[] }
export interface Chain { readonly id: number }
export interface Kzg { readonly commit: (blob: Hex) => Hex }
export type ContractFunctionReturnType<abi> = abi extends readonly unknown[] ? unknown : never
export type PublicActions = {
  optionalNarrow(parameters:
    | { readonly x: string; readonly a?: string }
    | { readonly x: string; readonly a?: 'lit' }
  ): Promise<boolean>
  overlap(parameters:
    | { readonly kind?: 'left'; readonly shared?: string; readonly left?: number }
    | { readonly kind?: 'right'; readonly shared?: string; readonly right?: boolean }
  ): Promise<{ readonly ok: boolean }>
  inspect(parameters: {
    readonly text: string
    readonly flag: boolean
    readonly count: number
    readonly amount: bigint
    readonly hash: Hex
    readonly address: Address
    readonly optional?: string
    readonly nullable: string | null
    readonly tags: readonly string[]
    readonly pair: readonly [string, bigint]
    readonly scores: Readonly<Record<string, bigint>>
    readonly mode: 'fast' | 'safe'
    readonly choice: { readonly kind: 'text'; readonly value: string } | { readonly kind: 'count'; readonly value: number }
    readonly intersection: { readonly left: string } & { readonly right: bigint }
    readonly branded: string & {}
    readonly topics: [] | [Hex, ...Hex[]]
    readonly literalBigint: 1n
    readonly literalBigintUnion: 1n | -2n
    readonly nestedBigintUnion: { readonly value: 1n } | { readonly value: 2n }
  }): Promise<{ readonly ok: boolean; readonly amount?: bigint; readonly raw: Uint8Array; readonly status: 1n | 2n }>
  readContract<const abi extends readonly AbiParameter[]>(parameters: {
    readonly account?: Address | Account
    readonly abi: abi
    readonly functionName: string
    readonly args?: readonly unknown[]
  }): Promise<ContractFunctionReturnType<abi>>
}
export type WalletActions = {
  writeContract(parameters: {
    readonly account: Account
    readonly chain?: { readonly id: number }
    readonly abi: readonly AbiParameter[]
    readonly functionName: string
    readonly args?: readonly unknown[]
    readonly kzg?: Kzg
  }): Promise<Hex>
  trustedChain(parameters: { readonly account: Account; readonly chain?: Chain; readonly to: Address }): Promise<Hex>
}
export type BadMap = Map<string, string>
export type BadSet = Set<string>
export type BadDate = Date
export class BadClass { value: string }
export type BadFunction = (value: string) => string
export type BadSymbol = symbol
export type BadStream = ReadableStream<string>
export interface BadRecursive { readonly next?: BadRecursive }
export type BadAmbiguous = { readonly value: bigint } | { readonly value: string }
export type BadNestedAmbiguous =
  | { readonly value: 1n | 'two'; readonly left?: boolean }
  | { readonly value: string; readonly right?: boolean }
export type BadConflict = { readonly value: string } & { readonly value: number }
export type BadHugeUnion = ${Array.from({ length: 257 }, (_, index) => JSON.stringify(`member-${index}`)).join(' | ')}
export type BadHugeBigintLiteral = 10000000000000000000000000000000000000000000000000000000000000000000000000000000n
export type BadHugeBigintUnion = 1n | 10000000000000000000000000000000000000000000000000000000000000000000000000000000n
export type BadHugeBigintObject = { readonly value: 10000000000000000000000000000000000000000000000000000000000000000000000000000000n }
`, 'utf8')
})

afterAll(() => {
  rmSync(fixtureRoot, { recursive: true, force: true })
})

function analyzeFixture(): ReturnType<typeof analyzeViemActions<ActionSchemaProjection>> {
  return analyzeViemActions({
    cwd: repositoryRoot,
    fixture: {
      moduleSpecifier: fixtureDeclaration.replace(/\.d\.ts$/, '.js'),
      packageVersion: '1.2.3',
      packageIntegrity: fixtureIntegrity,
    },
    project: projectViemActionSchemas,
  })
}

function rootSchemaProperties(schema: Record<string, unknown>): Set<string> {
  const names = new Set<string>()
  const properties = schema.properties
  if (typeof properties === 'object' && properties !== null && !Array.isArray(properties)) {
    for (const name of Object.keys(properties)) names.add(name)
  }
  const union = Array.isArray(schema.oneOf) ? schema.oneOf : schema.anyOf
  if (Array.isArray(union)) {
    for (const branch of union) {
      if (typeof branch !== 'object' || branch === null || Array.isArray(branch)) continue
      for (const name of rootSchemaProperties(branch as Record<string, unknown>)) names.add(name)
    }
  }
  return names
}

function rootPropertySchemas(schema: Record<string, unknown>, name: string): Record<string, unknown>[] {
  const matches: Record<string, unknown>[] = []
  const properties = schema.properties
  if (typeof properties === 'object' && properties !== null && !Array.isArray(properties)) {
    const property = (properties as Record<string, unknown>)[name]
    if (typeof property === 'object' && property !== null && !Array.isArray(property)) {
      matches.push(property as Record<string, unknown>)
    }
  }
  const union = Array.isArray(schema.oneOf) ? schema.oneOf : schema.anyOf
  if (Array.isArray(union)) {
    for (const branch of union) {
      if (typeof branch === 'object' && branch !== null && !Array.isArray(branch)) {
        matches.push(...rootPropertySchemas(branch as Record<string, unknown>, name))
      }
    }
  }
  return matches
}

describe('projectViemActionSchemas', () => {
  it('projects every analyzer-included installed viem action without narrowing source fields', () => {
    const analysis = analyzeViemActions({
      cwd: repositoryRoot,
      project: (context) => {
        const projection = projectViemActionSchemas(context)
        const schemaNames = rootSchemaProperties(projection.input_schema as Record<string, unknown>)
        const omitted = new Set(context.boundary.omittedInputProperties)
        const branches = context.inputType.isUnionType()
          ? context.inputType.getTypes().filter((type) => (type.flags & (TypeFlags.Null | TypeFlags.Undefined)) === 0)
          : [context.inputType]
        for (const branch of branches) {
          for (const property of context.checker.getPropertiesOfType(branch)) {
            if (omitted.has(property.name)) continue
            const propertyType = context.checker.getTypeOfSymbol(property)
            if (propertyType === undefined) throw new Error(`unresolved source property ${property.name}`)
            const possible = propertyType.isUnionType()
              ? propertyType.getTypes().filter((part) => (part.flags & (TypeFlags.Never | TypeFlags.Undefined)) === 0)
              : ((propertyType.flags & (TypeFlags.Never | TypeFlags.Undefined)) === 0 ? [propertyType] : [])
            if (possible.length > 0 && !schemaNames.has(property.name)) {
              throw new Error(`${context.sourceProfile}:${context.sourceName} silently lost source property ${property.name}`)
            }
          }
        }
        return projection
      },
    })
    const classified = [...analysis.included, ...analysis.excluded]
      .map(({ sourceProfile, sourceName }) => `${sourceProfile}:${sourceName}`)
      .toSorted()
    expect(classified).toHaveLength(new Set(classified).size)
    const projected = new Map(analysis.included.map((action) => [
      `${action.sourceProfile}:${action.sourceName}`,
      action.projection,
    ]))
    for (const name of [
      'viem-public:readContract',
      'viem-public:getTransactionReceipt',
      'viem-wallet:writeContract',
      'viem-wallet:sendTransaction',
    ]) {
      expect(projected.get(name)?.input_schema, name).toBeDefined()
      expect(projected.get(name)?.output_schema, name).toBeDefined()
    }
    const readContractSchema = projected.get('viem-public:readContract')?.input_schema as Record<string, unknown>
    const writeContractSchema = projected.get('viem-wallet:writeContract')?.input_schema as Record<string, unknown>
    const sendTransactionSchema = projected.get('viem-wallet:sendTransaction')?.input_schema as Record<string, unknown>
    expect(rootSchemaProperties(readContractSchema)).toContain('stateOverride')
    expect([...rootSchemaProperties(writeContractSchema)]).toEqual(expect.arrayContaining(['value', 'blobs', 'dataSuffix']))
    expect(JSON.stringify(rootPropertySchemas(writeContractSchema, 'blobs')))
      .toContain('"x-tas-type":"bytes"')
    expect(JSON.stringify(rootPropertySchemas(writeContractSchema, 'dataSuffix')))
      .not.toContain('"x-tas-type":"bytes"')
    expect(rootSchemaProperties(sendTransactionSchema)).toContain('blobs')
    expect(rootSchemaProperties(projected.get('viem-public:estimateFeesPerGas')?.input_schema as Record<string, unknown>)).toContain('type')
    expect(rootSchemaProperties(projected.get('viem-public:getBlockNumber')?.input_schema as Record<string, unknown>)).toContain('cacheTime')
    for (const action of ['getBlockReceipts', 'getBlockTransactionCount']) {
      const names = rootSchemaProperties(projected.get(`viem-public:${action}`)?.input_schema as Record<string, unknown>)
      expect([...names].toSorted(), action).toEqual(['blockHash', 'blockNumber', 'blockTag'])
    }
  }, 15_000)

  it('projects finite TypeScript requests and Promise outputs as detached 2020-12 schemas', () => {
    const inspect = analyzeFixture().included.find(({ sourceName }) => sourceName === 'inspect')
    const input = inspect?.projection.input_schema
    expect(input?.$schema).toBe('https://json-schema.org/draft/2020-12/schema')
    expect(input?.type).toBe('object')
    expect(input?.required).toEqual([
      'address', 'amount', 'branded', 'choice', 'count', 'flag', 'hash', 'intersection', 'literalBigint', 'literalBigintUnion', 'mode', 'nestedBigintUnion', 'nullable', 'pair', 'scores', 'tags', 'text', 'topics',
    ])
    expect(input?.properties).toMatchObject({
      text: { type: 'string' },
      flag: { type: 'boolean' },
      count: { type: 'number' },
      amount: { type: 'string', format: 'bigint', pattern: '^(?:0|-?[1-9][0-9]*)$', maxLength: 79 },
      hash: { type: 'string', format: 'hex' },
      // Address and Hex are transparent aliases of the same template-literal
      // type. Only analyzer-proven address boundaries receive evm-address.
      address: { type: 'string', format: 'hex' },
      optional: { type: 'string' },
      nullable: { oneOf: [{ type: 'null' }, { type: 'string' }] },
      tags: { type: 'array', items: { type: 'string' } },
      pair: {
        type: 'array',
        prefixItems: [{ type: 'string' }, { type: 'string', format: 'bigint', pattern: '^(?:0|-?[1-9][0-9]*)$' }],
        minItems: 2,
        maxItems: 2,
        items: false,
      },
      scores: { type: 'object', additionalProperties: { type: 'string', format: 'bigint', pattern: '^(?:0|-?[1-9][0-9]*)$' } },
      mode: { type: 'string', enum: ['fast', 'safe'] },
      choice: {
        oneOf: [
          expect.objectContaining({ properties: expect.objectContaining({ kind: expect.objectContaining({ const: 'count' }) }) }),
          expect.objectContaining({ properties: expect.objectContaining({ kind: expect.objectContaining({ const: 'text' }) }) }),
        ],
      },
      intersection: {
        type: 'object',
        properties: {
          left: { type: 'string' },
          right: { type: 'string', format: 'bigint' },
        },
      },
      branded: { type: 'string' },
      topics: {
        oneOf: [
          expect.objectContaining({ minItems: 0, maxItems: 0 }),
          expect.objectContaining({ minItems: 1, items: { type: 'string', format: 'hex' } }),
        ],
      },
      literalBigint: {
        type: 'string', format: 'bigint', pattern: '^(?:0|-?[1-9][0-9]*)$', maxLength: 79, const: '1',
      },
      literalBigintUnion: {
        type: 'string', format: 'bigint', pattern: '^(?:0|-?[1-9][0-9]*)$', maxLength: 79, enum: ['-2', '1'],
      },
      nestedBigintUnion: {
        oneOf: [
          expect.objectContaining({ properties: expect.objectContaining({ value: expect.objectContaining({ const: '1' }) }) }),
          expect.objectContaining({ properties: expect.objectContaining({ value: expect.objectContaining({ const: '2' }) }) }),
        ],
      },
    })
    expect(inspect?.projection.output_schema).toMatchObject({
      type: 'object',
      required: ['ok', 'raw', 'status'],
      properties: {
        ok: { type: 'boolean' },
        amount: { type: 'string', format: 'bigint', pattern: '^(?:0|-?[1-9][0-9]*)$', maxLength: 79 },
        raw: {
          type: 'object',
          'x-tas-type': 'bytes',
          properties: {
            encoding: { type: 'string', const: 'hex' },
            value: { type: 'string', format: 'hex' },
          },
          required: ['encoding', 'value'],
          additionalProperties: false,
        },
        status: {
          type: 'string', format: 'bigint', pattern: '^(?:0|-?[1-9][0-9]*)$', maxLength: 79, enum: ['1', '2'],
        },
      },
    })
    expect(JSON.stringify(inspect?.projection)).not.toContain('inputType')
  })

  it('uses anyOf only when source union branches overlap with equivalent JSON decoding', () => {
    const overlap = analyzeFixture().included.find(({ sourceName }) => sourceName === 'overlap')
    expect(overlap?.projection.input_schema).toMatchObject({
      anyOf: [
        expect.objectContaining({ properties: expect.objectContaining({ kind: { type: 'string', const: 'left' } }) }),
        expect.objectContaining({ properties: expect.objectContaining({ kind: { type: 'string', const: 'right' } }) }),
      ],
    })
    expect(overlap?.projection.input_schema).not.toHaveProperty('oneOf')
    const optionalNarrow = analyzeFixture().included.find(({ sourceName }) => sourceName === 'optionalNarrow')
    expect(optionalNarrow?.projection.input_schema).toHaveProperty('anyOf')
    expect(optionalNarrow?.projection.input_schema).not.toHaveProperty('oneOf')
  })

  it('uses recursive JSON value schemas for ABI args and default-generic output', () => {
    const read = analyzeFixture().included.find(({ sourceName }) => sourceName === 'readContract')
    expect(read?.projection.input_schema.properties).toMatchObject({
      account: { type: 'string', format: 'evm-address' },
      abi: { type: 'array', items: { $ref: '#/$defs/jsonValue' } },
      args: { type: 'array', items: { $ref: '#/$defs/jsonValue' } },
    })
    expect(read?.projection.output_schema).toMatchObject({
      $ref: '#/$defs/jsonValue',
      $defs: { jsonValue: expect.any(Object) },
    })
  })

  it('removes resolved Wallet runtime inputs, omits optional providers, and adds optional inline credential', () => {
    const write = analyzeFixture().included.find(({ sourceName }) => sourceName === 'writeContract')
    expect(write?.projection.input_schema.properties).not.toHaveProperty('account')
    expect(write?.projection.input_schema.properties).not.toHaveProperty('kzg')
    expect(write?.projection.input_schema.properties).toHaveProperty('chain')
    expect(write?.projection.input_schema.properties).toMatchObject({
      credential: {
        type: 'object',
        properties: {
          type: { const: 'inline' },
          secret: { type: 'string', minLength: 1, writeOnly: true },
        },
        required: ['secret', 'type'],
        additionalProperties: false,
      },
    })
    expect(write?.projection.input_schema.required).not.toContain('credential')
    const trustedChain = analyzeFixture().included.find(({ sourceName }) => sourceName === 'trustedChain')
    expect(trustedChain?.projection.input_schema.properties).not.toHaveProperty('chain')
  })

  it('rejects unsupported and ambiguous TypeScript boundaries', () => {
    const api = new API({ cwd: repositoryRoot })
    let snapshot: ReturnType<API['updateSnapshot']> | undefined
    try {
      snapshot = api.updateSnapshot({ openFiles: [fixtureDeclaration] })
      const project = snapshot.getDefaultProjectForFile(fixtureDeclaration)
      const source = project?.program.getSourceFile(fixtureDeclaration)
      if (project === undefined || source === undefined) throw new Error('schema rejection fixture did not resolve')
      const exports = project.checker.getSymbolAtLocation(source)?.getExports()
      if (exports === undefined) throw new Error('schema rejection fixture has no exports')
      for (const name of [
        'BadMap', 'BadSet', 'BadDate', 'BadClass', 'BadFunction', 'BadSymbol', 'BadStream', 'BadRecursive',
        'BadAmbiguous', 'BadNestedAmbiguous', 'BadConflict', 'BadHugeUnion', 'BadHugeBigintLiteral',
        'BadHugeBigintUnion', 'BadHugeBigintObject',
      ]) {
        const symbol = [...exports.values()].find((candidate) => candidate.name === name)
        if (symbol === undefined) throw new Error(`missing rejection alias ${name}`)
        const type = project.checker.getDeclaredTypeOfSymbol(symbol)
        expect(() => encodeTypeSchema(type, project.checker, { position: 'input' }), name).toThrowError()
      }
    } finally {
      snapshot?.dispose()
      api.close()
    }
  })

  it.each(['required', 'optional'] as const)('rejects a Wallet source %s credential collision', (kind) => {
    const collisionDeclaration = join(fixtureRoot, `credential-${kind}.d.ts`)
    writeFileSync(collisionDeclaration, `
export type Address = \`0x\${string}\`
export interface PrivateKeyAccount { readonly address: Address; readonly type: 'local' }
export type Account = PrivateKeyAccount
export type PublicActions = {}
export type WalletActions = {
  collide(parameters: { readonly account: Account; readonly credential${kind === 'optional' ? '?' : ''}: string }): Promise<Address>
}
`, 'utf8')
    expect(() => analyzeViemActions({
      cwd: repositoryRoot,
      fixture: {
        moduleSpecifier: collisionDeclaration.replace(/\.d\.ts$/, '.js'),
        packageVersion: '1.2.3',
        packageIntegrity: fixtureIntegrity,
      },
      project: projectViemActionSchemas,
    })).toThrowError(/credential/i)
  })

  it.each(['required', 'optional'] as const)('rejects a Wallet %s credential hidden in a root union branch', (kind) => {
    const collisionDeclaration = join(fixtureRoot, `credential-union-${kind}.d.ts`)
    writeFileSync(collisionDeclaration, `
export type Address = \`0x\${string}\`
export interface PrivateKeyAccount { readonly address: Address; readonly type: 'local' }
export type Account = PrivateKeyAccount
export type PublicActions = {}
export type WalletActions = {
  collide(parameters: { readonly account: Account; readonly credential${kind === 'optional' ? '?' : ''}: string } | { readonly account: Account; readonly to: Address }): Promise<Address>
}
`, 'utf8')
    expect(() => analyzeViemActions({
      cwd: repositoryRoot,
      fixture: {
        moduleSpecifier: collisionDeclaration.replace(/\.d\.ts$/, '.js'),
        packageVersion: '1.2.3',
        packageIntegrity: fixtureIntegrity,
      },
      project: projectViemActionSchemas,
    })).toThrowError(/credential/i)
  })

  it('rejects overlapping union branches that decode as bytes and an ordinary object', () => {
    const collisionDeclaration = join(fixtureRoot, 'bytes-object-union.d.ts')
    writeFileSync(collisionDeclaration, `
export type Hex = \`0x\${string}\`
export type Address = \`0x\${string}\`
export interface PrivateKeyAccount { readonly address: Address; readonly type: 'local' }
export type Account = PrivateKeyAccount
export type PublicActions = {
  collide(parameters: {
    readonly value: Uint8Array | { readonly encoding: 'hex'; readonly value: Hex }
  }): Promise<boolean>
  collideNested(parameters:
    | { readonly value: Uint8Array | bigint; readonly left?: boolean }
    | { readonly value: { readonly encoding: 'hex'; readonly value: Hex } | string; readonly right?: boolean }
  ): Promise<boolean>
}
export type WalletActions = {}
`, 'utf8')
    expect(() => analyzeViemActions({
      cwd: repositoryRoot,
      fixture: {
        moduleSpecifier: collisionDeclaration.replace(/\.d\.ts$/, '.js'),
        packageVersion: '1.2.3',
        packageIntegrity: fixtureIntegrity,
      },
      project: projectViemActionSchemas,
    })).toThrowError(/different decoded representations/i)
  })
})
