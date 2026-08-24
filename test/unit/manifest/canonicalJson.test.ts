import { describe, expect, it } from 'vitest'
import canonicalize from 'canonicalize'

import { canonicalJson } from '../../../tools/manifest/canonicalJson.js'

describe('canonicalJson', () => {
  it('emits RFC 8785 canonical JSON without formatting or a trailing newline', () => {
    const value = { z: 3, a: { '€': 'Euro Sign', '\r': 'CR', '1': 'one' }, n: 0.000001 }

    const result = canonicalJson(value)

    expect(result).toBe('{"a":{"\\r":"CR","1":"one","€":"Euro Sign"},"n":0.000001,"z":3}')
    expect(result.endsWith('\n')).toBe(false)
  })

  it('accepts null-prototype records and repeated non-cyclic aliases', () => {
    const shared = Object.assign(Object.create(null) as Record<string, unknown>, { value: true })
    const root = Object.assign(Object.create(null) as Record<string, unknown>, { second: shared, first: shared })

    expect(canonicalJson(root)).toBe('{"first":{"value":true},"second":{"value":true}}')
  })

  it.each([
    { b: [true, null, 'text'], a: { z: -0, n: 1e+30 } },
    ['€', { '\r': 'CR', '1': 'one' }, 333333333.33333329],
    { nested: [{ y: 2, x: 1 }, []], number: 0.000000000000000000000000001 },
  ])('matches the RFC 8785 library for a validated nested JSON tree', (value) => {
    expect(canonicalJson(value)).toBe(canonicalize(value))
  })

  it('rejects a lone Unicode surrogate required to fail under RFC 8785', () => {
    expect(() => canonicalJson('\ud800')).toThrow(TypeError)
    expect(() => canonicalJson({ value: '\udfff' })).toThrow(TypeError)
  })

  it.each([
    undefined,
    () => undefined,
    Symbol('not-json'),
    1n,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
    new Date(0),
    new Map(),
    Object.create({ inherited: true }),
  ])('rejects a non-JSON root or non-plain object: %s', (value) => {
    expect(() => canonicalJson(value)).toThrow(TypeError)
  })

  it.each([
    { bad: undefined },
    { bad: () => undefined },
    { bad: Symbol('not-json') },
    { bad: 1n },
    { bad: Number.NaN },
    { bad: Number.POSITIVE_INFINITY },
    { bad: new Date(0) },
  ])('rejects a nested non-JSON value: %o', (value) => {
    expect(() => canonicalJson(value)).toThrow(TypeError)
  })

  it('rejects cycles but allows repeated aliases', () => {
    const cyclic: { self?: unknown } = {}
    cyclic.self = cyclic
    const child: { parent?: unknown } = {}
    const parent = { child }
    child.parent = parent
    const repeatedChild = {}

    expect(() => canonicalJson(cyclic)).toThrow(TypeError)
    expect(() => canonicalJson(parent)).toThrow(TypeError)
    expect(canonicalJson({ a: repeatedChild, b: repeatedChild })).toBe('{"a":{},"b":{}}')
  })

  it('rejects accessors without evaluating them', () => {
    let calls = 0
    const value = {}
    Object.defineProperty(value, 'secret', {
      enumerable: true,
      get() {
        calls += 1
        return 'must-not-run'
      },
    })

    expect(() => canonicalJson(value)).toThrow(TypeError)
    expect(calls).toBe(0)
  })

  it('rejects symbol keys, non-enumerable fields, sparse arrays, and array extensions', () => {
    const withSymbol = { safe: true, [Symbol('hidden')]: true }
    const withHidden = { safe: true }
    Object.defineProperty(withHidden, 'hidden', { value: true })
    const sparse = Array.from({ length: 2 })
    sparse[1] = 'present'
    const extended = ['value'] as string[] & { extra?: string }
    extended.extra = 'not-json-array-shape'

    for (const value of [withSymbol, withHidden, sparse, extended]) {
      expect(() => canonicalJson(value)).toThrow(TypeError)
    }
  })

  it('fails closed when proxy introspection throws', () => {
    const value = new Proxy({}, {
      getPrototypeOf() {
        throw new Error('secret proxy error')
      },
    })

    expect(() => canonicalJson(value)).toThrow(TypeError)
  })

  it.each([
    ['toJSON', [1, 2], '[1,2]'],
    ['map', [1, 2], '[1,2]'],
    ['join', [1, 2], '[1,2]'],
    ['sort', { z: 1, a: 2 }, '{"a":2,"z":1}'],
  ] as const)('does not read a polluted Array.prototype.%s getter', (property, value, expected) => {
    const previous = Object.getOwnPropertyDescriptor(Array.prototype, property)
    let calls = 0
    let result: string | undefined
    let failure: unknown
    Object.defineProperty(Array.prototype, property, {
      configurable: true,
      get() {
        calls += 1
        throw new Error('polluted array prototype getter')
      },
    })
    try {
      result = canonicalJson(value)
    } catch (error) {
      failure = error
    } finally {
      if (previous === undefined) delete (Array.prototype as unknown as Record<string, unknown>)[property]
      else Object.defineProperty(Array.prototype, property, previous)
    }

    expect(failure).toBeUndefined()
    expect(calls).toBe(0)
    expect(result).toBe(expected)
  })

  it('does not invoke a polluted Array prototype index setter while cloning', () => {
    const previous = Object.getOwnPropertyDescriptor(Array.prototype, '0')
    const value = ['safe']
    let calls = 0
    let result: string | undefined
    let failure: unknown
    Object.defineProperty(Array.prototype, '0', {
      configurable: true,
      set() {
        calls += 1
      },
    })
    try {
      result = canonicalJson(value)
    } catch (error) {
      failure = error
    } finally {
      if (previous === undefined) delete (Array.prototype as unknown as Record<string, unknown>)['0']
      else Object.defineProperty(Array.prototype, '0', previous)
    }

    expect(failure).toBeUndefined()
    expect(calls).toBe(0)
    expect(result).toBe('["safe"]')
  })

  it('fails closed on a small shared DAG before exponential expansion', () => {
    let value: unknown = { leaf: true }
    for (let depth = 0; depth < 14; depth += 1) value = { left: value, right: value }

    expect(() => canonicalJson(value)).toThrow(TypeError)
  })

  it('allows build tooling to select a reviewed larger expansion budget', () => {
    const artifact = Object.fromEntries(Array.from({ length: 12_000 }, (_, index) => [`field_${index}`, index]))

    expect(() => canonicalJson(artifact)).toThrow(TypeError)
    expect(JSON.parse(canonicalJson(artifact, { maxExpandedNodes: 100_000 }))).toEqual(artifact)
  })

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    'rejects an invalid explicit expansion budget: %s',
    (maxExpandedNodes) => {
      expect(() => canonicalJson({}, { maxExpandedNodes })).toThrow(TypeError)
    },
  )

  it('rejects null as an explicit expansion budget instead of treating it as the default', () => {
    expect(() => canonicalJson({}, { maxExpandedNodes: null as never })).toThrow(TypeError)
  })

  it('enforces the one MiB canonical output byte budget before append', () => {
    const exact = 'x'.repeat(1_048_576 - 2)
    const oversized = `${exact}x`

    expect(Buffer.byteLength(canonicalJson(exact), 'utf8')).toBe(1_048_576)
    expect(() => canonicalJson(oversized)).toThrow(TypeError)
  })
})
