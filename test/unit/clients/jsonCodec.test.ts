import { describe, expect, it, vi } from 'vitest'
import { decodeBySchema, encodeEvmJson } from '../../../src/clients/chain/jsonCodec.js'

describe('EVM JSON codec', () => {
  it('encodes bigint, bytes, and source-native receipt data without inventing operation metadata', () => {
    expect(encodeEvmJson(2n ** 255n)).toBe('57896044618658097711785492504343953926634992332820282019728792003956564819968')
    expect(encodeEvmJson(new Uint8Array([0, 15, 255]))).toEqual({
      encoding: 'hex',
      value: '0x000fff',
    })
    expect(encodeEvmJson({
      transactionHash: '0x1234',
      status: 'success',
      blockNumber: 42n,
    })).toEqual({
      transactionHash: '0x1234',
      status: 'success',
      blockNumber: '42',
    })
  })

  it('round-trips analyzer-proven bytes through an explicit binary envelope', () => {
    const byteSchema = {
      type: 'object',
      'x-tas-type': 'bytes',
      properties: {
        encoding: { type: 'string', const: 'hex' },
        value: { type: 'string', format: 'hex' },
      },
      required: ['encoding', 'value'],
      additionalProperties: false,
    }
    const decoded = decodeBySchema(byteSchema, { encoding: 'hex', value: '0x000fff' })
    expect(decoded).toBeInstanceOf(Uint8Array)
    expect([...decoded as Uint8Array]).toEqual([0, 15, 255])
    expect(decodeBySchema({
      type: 'object',
      properties: {
        encoding: { type: 'string' },
        value: { type: 'string' },
      },
      required: ['encoding', 'value'],
      additionalProperties: false,
    }, { encoding: 'hex', value: '0x000fff' })).toEqual({ encoding: 'hex', value: '0x000fff' })
  })

  it('decodes canonical bigint formats and preserves source-native hex/address strings', () => {
    expect(decodeBySchema(
      { type: 'string', format: 'uint256' },
      '340282366920938463463374607431768211457',
    )).toBe(340282366920938463463374607431768211457n)
    expect(decodeBySchema({ type: 'string', format: 'int256' }, '-1')).toBe(-1n)
    expect(decodeBySchema({ type: 'string', format: 'hex' }, '0x00aB')).toBe('0x00aB')
    expect(decodeBySchema({ type: 'string', format: 'evm-address' }, '0x0000000000000000000000000000000000000001'))
      .toBe('0x0000000000000000000000000000000000000001')
  })

  it('decodes objects, tuples, unions, and recursive JSON refs by schema', () => {
    const schema = {
      type: 'object',
      properties: {
        amount: { type: 'string', format: 'bigint' },
        pair: {
          type: 'array',
          prefixItems: [{ type: 'string' }, { type: 'string', format: 'uint256' }],
          minItems: 2,
          maxItems: 2,
          items: false,
        },
        maybe: { oneOf: [{ type: 'null' }, { type: 'boolean' }] },
        data: { $ref: '#/$defs/jsonValue' },
      },
      required: ['amount', 'data', 'maybe', 'pair'],
      additionalProperties: false,
      $defs: {
        jsonValue: {
          oneOf: [
            { type: 'null' }, { type: 'boolean' }, { type: 'number' }, { type: 'string' },
            { type: 'array', items: { $ref: '#/$defs/jsonValue' } },
            { type: 'object', additionalProperties: { $ref: '#/$defs/jsonValue' } },
          ],
        },
      },
    } as const
    expect(decodeBySchema(schema, {
      amount: '-9',
      pair: ['ok', '7'],
      maybe: null,
      data: { nested: [true, '0x12', 3] },
    })).toEqual({
      amount: -9n,
      pair: ['ok', 7n],
      maybe: null,
      data: { nested: [true, '0x12', 3] },
    })
  })

  it('accepts overlapping anyOf branches only when decoded values are structurally equivalent', () => {
    const bytes = {
      type: 'object',
      'x-tas-type': 'bytes',
      properties: {
        encoding: { type: 'string', const: 'hex' },
        value: { type: 'string', format: 'hex' },
      },
      required: ['encoding', 'value'],
      additionalProperties: false,
    } as const
    expect(decodeBySchema({ anyOf: [
      {
        type: 'object',
        properties: { amount: { type: 'string', format: 'bigint' } },
        required: ['amount'],
        additionalProperties: false,
      },
      {
        type: 'object',
        properties: { amount: { type: 'string', format: 'bigint' }, note: { type: 'string' } },
        required: ['amount'],
        additionalProperties: false,
      },
    ] }, { amount: '7' })).toEqual({ amount: 7n })

    const decodedBytes = decodeBySchema({ anyOf: [bytes, bytes] }, { encoding: 'hex', value: '0x000fff' })
    expect(decodedBytes).toBeInstanceOf(Uint8Array)
    expect([...(decodedBytes as Uint8Array)]).toEqual([0, 15, 255])

    expect(() => decodeBySchema({ anyOf: [
      { type: 'string' },
      { type: 'string', format: 'bigint' },
    ] }, '7')).toThrowError(/ambiguous/i)
    expect(() => decodeBySchema({ anyOf: [
      bytes,
      {
        type: 'object',
        properties: { encoding: { type: 'string' }, value: { type: 'string' } },
        required: ['encoding', 'value'],
        additionalProperties: false,
      },
    ] }, { encoding: 'hex', value: '0x000fff' })).toThrowError(/ambiguous/i)
    expect(() => decodeBySchema({ anyOf: [
      {
        type: 'object',
        properties: { value: { oneOf: [bytes, { type: 'string', format: 'bigint' }] } },
        required: ['value'],
        additionalProperties: false,
      },
      {
        type: 'object',
        properties: {
          value: { oneOf: [
            {
              type: 'object',
              properties: { encoding: { type: 'string' }, value: { type: 'string' } },
              required: ['encoding', 'value'],
              additionalProperties: false,
            },
            { type: 'string' },
          ] },
        },
        required: ['value'],
        additionalProperties: false,
      },
    ] }, { value: '7' })).toThrowError(/ambiguous/i)
  })

  it.each([
    ['unsafe bigint number', { type: 'string', format: 'uint256' }, Number.MAX_SAFE_INTEGER + 1],
    ['leading zero', { type: 'string', format: 'uint256' }, '01'],
    ['negative zero', { type: 'string', format: 'int256' }, '-0'],
    ['uint overflow', { type: 'string', format: 'uint256' }, (2n ** 256n).toString()],
    ['malformed hex', { type: 'string', format: 'hex' }, '0xz1'],
    ['malformed address', { type: 'string', format: 'evm-address' }, '0x1234'],
  ])('rejects %s', (_name, schema, value) => {
    expect(() => decodeBySchema(schema, value)).toThrowError()
  })

  it('rejects undefined, cycles, accessors, toJSON, and unsupported objects without invoking them', () => {
    expect(() => encodeEvmJson(undefined)).toThrowError()
    const cycle: Record<string, unknown> = {}
    cycle.self = cycle
    expect(() => encodeEvmJson(cycle)).toThrowError()
    let invoked = false
    const accessor = Object.create(null) as Record<string, unknown>
    Object.defineProperty(accessor, 'secret', { enumerable: true, get: () => { invoked = true; return 'no' } })
    expect(() => encodeEvmJson(accessor)).toThrowError()
    expect(invoked).toBe(false)
    expect(() => encodeEvmJson({ toJSON: () => 'no' })).toThrowError()
    expect(() => encodeEvmJson(new Date())).toThrowError()
    expect(() => decodeBySchema({ type: 'object', additionalProperties: true }, accessor)).toThrowError()
    expect(invoked).toBe(false)
  })

  it('applies one shared bounded work and byte budget before allocating encoded output', () => {
    expect(() => encodeEvmJson('x'.repeat(1024 * 1024 + 1))).toThrowError()
    const bytes = new Uint8Array(10_001)
    const largeArray = Array.from({ length: 10_001 }, () => true)
    const originalDescriptors = Object.getOwnPropertyDescriptors
    let targetInspected = false
    const descriptors = vi.spyOn(Object, 'getOwnPropertyDescriptors').mockImplementation((value: object) => {
      if (value === bytes || value === largeArray) targetInspected = true
      return originalDescriptors(value)
    })
    let typedRejected = false
    let arrayRejected = false
    try {
      try { encodeEvmJson(bytes) } catch { typedRejected = true }
      try { encodeEvmJson(largeArray) } catch { arrayRejected = true }
    } finally {
      descriptors.mockRestore()
    }
    expect(typedRejected).toBe(true)
    expect(arrayRejected).toBe(true)
    expect(targetInspected).toBe(false)
  })

  it('charges UTF-8 object keys to encode, schema-clone, and decode budgets', () => {
    const oversizedKey = 'k'.repeat(1024 * 1024 + 1)
    expect(() => encodeEvmJson({ [oversizedKey]: true })).toThrowError()
    expect(() => decodeBySchema({ type: 'object', properties: { [oversizedKey]: { type: 'boolean' } } }, {})).toThrowError()
    expect(() => decodeBySchema({ type: 'object', additionalProperties: true }, { [oversizedKey]: true })).toThrowError()
  })

  it('rejects negative zero and arrays with non-index enumerable properties', () => {
    expect(() => encodeEvmJson(-0)).toThrowError()
    expect(() => decodeBySchema({ type: 'number' }, -0)).toThrowError()
    const array = ['ok'] as string[] & { extra?: string }
    array.extra = 'not-an-item'
    expect(() => encodeEvmJson(array)).toThrowError()
  })

  it('validates typed arrays before reading overridable properties', () => {
    let invoked = false
    const bytes = new Uint8Array([1, 2, 3])
    Object.defineProperty(bytes, 'buffer', {
      configurable: true,
      get: () => { invoked = true; return new ArrayBuffer(0) },
    })
    expect(() => encodeEvmJson(bytes)).toThrowError()
    expect(invoked).toBe(false)

    const foreignPrototype = new Uint8Array([1])
    Object.setPrototypeOf(foreignPrototype, {})
    expect(() => encodeEvmJson(foreignPrototype)).toThrowError()
  })

  it('clones schemas without getters and rejects cycles or unsupported constraints', () => {
    let invoked = false
    const accessorSchema = Object.create(null) as Record<string, unknown>
    Object.defineProperty(accessorSchema, 'type', {
      enumerable: true,
      get: () => { invoked = true; return 'string' },
    })
    expect(() => decodeBySchema(accessorSchema, 'value')).toThrowError()
    expect(invoked).toBe(false)

    const cyclicSchema: Record<string, unknown> = { type: 'string' }
    cyclicSchema.self = cyclicSchema
    expect(() => decodeBySchema(cyclicSchema, 'value')).toThrowError()
    expect(() => decodeBySchema({ type: 'number', multipleOf: 3 }, 9)).toThrowError()
  })

  it('enforces pattern/minLength and never ignores $ref siblings or fatal branch errors', () => {
    expect(() => decodeBySchema({ type: 'string', minLength: 3 }, 'ab')).toThrowError()
    expect(() => decodeBySchema({ type: 'string', pattern: '^0x[0-9a-f]+$' }, 'no')).toThrowError()
    expect(() => decodeBySchema({ type: 'string', pattern: '^(a+)+$' }, 'aaaa')).toThrowError()
    expect(() => decodeBySchema({ type: 'string', format: 'uint256' }, '9'.repeat(100_000))).toThrowError()
    expect(() => decodeBySchema({
      $ref: '#/$defs/text',
      minLength: 3,
      $defs: { text: { type: 'string' } },
    }, 'a')).toThrowError()
    expect(() => decodeBySchema({
      oneOf: [{ type: 'string' }, { $ref: '#/$defs/loop' }],
      $defs: { loop: { $ref: '#/$defs/loop' } },
    }, 'ok')).toThrowError()
  })

  it('rejects malformed schema scalar keywords, ignored union siblings, and incoherent keywords', () => {
    expect(() => decodeBySchema({ type: 7 }, 'value')).toThrowError()
    expect(() => decodeBySchema({ type: 'string', format: 7 }, 'value')).toThrowError()
    expect(() => decodeBySchema({ oneOf: [{ type: 'string' }], minLength: 1 }, 'value')).toThrowError()
    expect(() => decodeBySchema({ anyOf: [{ type: 'string' }], minLength: 1 }, 'value')).toThrowError()
    expect(() => decodeBySchema({ anyOf: Array.from({ length: 257 }, () => ({ type: 'string' })) }, 'value')).toThrowError()
    expect(() => decodeBySchema({ type: 'number', minLength: 1 }, 1)).toThrowError()
    expect(() => decodeBySchema({ type: 'string', required: [] }, 'value')).toThrowError()
    expect(() => decodeBySchema({ type: 'object', minItems: 0 }, {})).toThrowError()
  })

  it('enforces the symmetric 79-character canonical bigint boundary', () => {
    const maximum = BigInt('9'.repeat(79))
    const schema = { type: 'string', format: 'bigint', maxLength: 79 }
    expect(decodeBySchema(schema, encodeEvmJson(maximum))).toBe(maximum)
    expect(() => decodeBySchema({ type: 'string', maxLength: 2 }, 'abc')).toThrowError()
    expect(() => encodeEvmJson(BigInt('1' + '0'.repeat(79)))).toThrowError()
    expect(() => encodeEvmJson(-BigInt('1' + '0'.repeat(78)))).toThrowError()
  })

  it('accepts inert null-prototype schema arrays without using their prototype methods', () => {
    const branches = Object.setPrototypeOf([{ type: 'null' }, { type: 'boolean' }], null) as unknown[]
    expect(decodeBySchema({ oneOf: branches }, true)).toBe(true)

    const enumeration = Object.setPrototypeOf(['fast', 'safe'], null) as unknown[]
    const required = Object.setPrototypeOf(['mode', 'pair'], null) as unknown[]
    const prefixItems = Object.setPrototypeOf([{ type: 'string' }, { type: 'boolean' }], null) as unknown[]
    expect(decodeBySchema({
      type: 'object',
      properties: {
        mode: { enum: enumeration },
        pair: { type: 'array', prefixItems, minItems: 2, maxItems: 2, items: false },
      },
      required,
      additionalProperties: false,
    }, { mode: 'fast', pair: ['ok', true] })).toEqual({ mode: 'fast', pair: ['ok', true] })
  })

  it('does not roll back failed oneOf work from the global decode budget', () => {
    const values = Array.from({ length: 3_000 }, () => true)
    expect(() => decodeBySchema({
      type: 'array',
      items: { oneOf: [{ type: 'boolean' }, { type: 'null' }] },
    }, values)).toThrowError()
  })

  it('does not roll back failed anyOf work from the global decode budget', () => {
    const values = Array.from({ length: 3_000 }, () => true)
    expect(() => decodeBySchema({
      type: 'array',
      items: { anyOf: [{ type: 'boolean' }, { type: 'null' }] },
    }, values)).toThrowError()
  })
})
