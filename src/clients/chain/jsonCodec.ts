import { isProxy } from 'node:util/types'

export type EvmJsonValue = null | boolean | number | string | readonly EvmJsonValue[] | {
  readonly [key: string]: EvmJsonValue
}

export type DecodedEvmValue = null | boolean | number | bigint | string | Uint8Array | readonly DecodedEvmValue[] | {
  readonly [key: string]: DecodedEvmValue
}

type InertJson = null | boolean | number | string | InertJson[] | { readonly [key: string]: InertJson }
type InertRecord = Readonly<Record<string, InertJson>>
type Descriptors = Readonly<Record<string, PropertyDescriptor>>

const maximumDepth = 64
const maximumNodes = 10_000
const maximumBytes = 1024 * 1024
const maximumUnionMembers = 256
const arrayIndex = /^(?:0|[1-9][0-9]*)$/
const canonicalInteger = /^(?:0|-?[1-9][0-9]*)$/
const canonicalUnsignedInteger = /^(?:0|[1-9][0-9]*)$/
const hexString = /^0x[0-9a-fA-F]*$/
const evmAddress = /^0x[0-9a-fA-F]{40}$/
const supportedPatterns = new Map<string, RegExp>([
  ['^(?:0|-?[1-9][0-9]*)$', /^(?:0|-?[1-9][0-9]*)$/],
  ['^(?:0|[1-9][0-9]*)$', /^(?:0|[1-9][0-9]*)$/],
  ['^0x[0-9a-f]+$', /^0x[0-9a-f]+$/],
])
const supportedSchemaKeys = new Set([
  '$defs', '$ref', '$schema', 'additionalProperties', 'anyOf', 'const', 'enum', 'format', 'items',
  'maxItems', 'maxLength', 'minItems', 'minLength', 'oneOf', 'pattern', 'prefixItems', 'properties',
  'required', 'type', 'writeOnly',
  'x-tas-type',
])

interface Budget {
  nodes: number
  bytes: number
}

interface ValueState {
  readonly budget: Budget
  readonly active: Set<object>
  readonly references: Map<string, Set<unknown>>
}

class ValueMismatch extends Error {}
class FatalCodecError extends Error {}

function charge(budget: Budget, bytes = 0, nodes = 1): void {
  budget.nodes += nodes
  budget.bytes += bytes
  if (budget.nodes > maximumNodes) throw new FatalCodecError(`EVM JSON work exceeds ${maximumNodes} nodes`)
  if (budget.bytes > maximumBytes) throw new FatalCodecError(`EVM JSON data exceeds ${maximumBytes} bytes`)
}

function stringBytes(value: string): number {
  return Buffer.byteLength(value, 'utf8')
}

function ownDescriptors(value: object, label: string, budget: Budget): Descriptors {
  if (isProxy(value)) throw new FatalCodecError(`${label} must not be a Proxy`)
  if (Object.getOwnPropertySymbols(value).length > 0) throw new FatalCodecError(`${label} must use string keys`)
  const descriptors = Object.getOwnPropertyDescriptors(value) as Descriptors
  for (const key of Object.keys(descriptors)) charge(budget, stringBytes(key), 0)
  return descriptors
}

function plainObjectDescriptors(value: object, label: string, budget: Budget): Descriptors {
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) throw new FatalCodecError(`${label} must be a plain object`)
  const descriptors = ownDescriptors(value, label, budget)
  for (const key of Object.keys(descriptors)) {
    const descriptor = descriptors[key]
    if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) {
      throw new FatalCodecError(`${label}.${key} must be an enumerable data property`)
    }
  }
  return descriptors
}

function arrayDescriptors(
  value: unknown[],
  label: string,
  budget: Budget,
): { readonly descriptors: Descriptors; readonly length: number } {
  if (isProxy(value)) throw new FatalCodecError(`${label} must not be a Proxy`)
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Array.prototype && prototype !== null) throw new FatalCodecError(`${label} has an unsupported array prototype`)
  const lengthDescriptor = Object.getOwnPropertyDescriptor(value, 'length')
  if (lengthDescriptor === undefined || !('value' in lengthDescriptor)
    || typeof lengthDescriptor.value !== 'number' || !Number.isSafeInteger(lengthDescriptor.value)
    || lengthDescriptor.value < 0) throw new FatalCodecError(`${label} has an invalid length`)
  const length = lengthDescriptor.value
  if (budget.nodes + length > maximumNodes) throw new FatalCodecError(`${label} exceeds the work budget`)
  const descriptors = ownDescriptors(value, label, budget)
  let entries = 0
  for (const key of Object.keys(descriptors)) {
    if (key === 'length') continue
    const descriptor = descriptors[key]
    if (!arrayIndex.test(key) || Number(key) >= length
      || descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) {
      throw new FatalCodecError(`${label} must contain only dense enumerable index properties`)
    }
    entries += 1
  }
  if (entries !== length) throw new FatalCodecError(`${label} must not be sparse`)
  return { descriptors, length }
}

const typedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype) as object
const typedArrayBufferGetter = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'buffer')?.get
const typedArrayByteLengthGetter = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'byteLength')?.get
const typedArrayByteOffsetGetter = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'byteOffset')?.get

function encodeBytes(value: Uint8Array, budget: Budget): EvmJsonValue {
  if (isProxy(value) || Object.getPrototypeOf(value) !== Uint8Array.prototype) {
    throw new FatalCodecError('bytes must be a direct built-in Uint8Array')
  }
  if (typedArrayBufferGetter === undefined || typedArrayByteLengthGetter === undefined || typedArrayByteOffsetGetter === undefined) {
    throw new FatalCodecError('built-in Uint8Array accessors are unavailable')
  }
  const byteLength = typedArrayByteLengthGetter.call(value) as unknown
  if (typeof byteLength !== 'number' || !Number.isSafeInteger(byteLength) || byteLength < 0) {
    throw new FatalCodecError('bytes have invalid built-in storage')
  }
  charge(budget, byteLength * 2 + 2 + stringBytes('encodingvaluehex'), byteLength + 3)
  const descriptors = ownDescriptors(value, 'bytes', budget)
  for (const key of Object.keys(descriptors)) {
    const descriptor = descriptors[key]
    if (!arrayIndex.test(key) || descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) {
      throw new FatalCodecError('bytes must not override built-in properties')
    }
  }
  const byteOffset = typedArrayByteOffsetGetter.call(value) as unknown
  const buffer = typedArrayBufferGetter.call(value) as unknown
  if (typeof byteOffset !== 'number' || !(buffer instanceof ArrayBuffer)) throw new FatalCodecError('bytes have invalid built-in storage')
  return { encoding: 'hex', value: `0x${Buffer.from(buffer, byteOffset, byteLength).toString('hex')}` }
}

function encode(value: unknown, state: ValueState, depth: number): EvmJsonValue {
  if (depth > maximumDepth) throw new FatalCodecError(`EVM JSON depth exceeds ${maximumDepth}`)
  if (value === null || typeof value === 'boolean') {
    charge(state.budget)
    return value
  }
  if (typeof value === 'string') {
    charge(state.budget, stringBytes(value))
    return value
  }
  if (typeof value === 'bigint') {
    const encoded = value.toString(10)
    if (encoded.length > 79) throw new FatalCodecError('EVM JSON bigint exceeds 79 canonical characters')
    charge(state.budget, stringBytes(encoded))
    return encoded
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || Object.is(value, -0)
      || (Number.isInteger(value) && !Number.isSafeInteger(value))) {
      throw new FatalCodecError('EVM JSON numbers must be finite, safe, and not negative zero')
    }
    charge(state.budget)
    return value
  }
  if (typeof value !== 'object') throw new FatalCodecError(`unsupported EVM JSON value: ${typeof value}`)
  if (isProxy(value)) throw new FatalCodecError('EVM JSON values must not be Proxies')
  if (value instanceof Uint8Array) return encodeBytes(value, state.budget)
  if (state.active.has(value)) throw new FatalCodecError('EVM JSON graph contains a cycle')
  charge(state.budget)
  state.active.add(value)
  try {
    if (Array.isArray(value)) {
      const { descriptors, length } = arrayDescriptors(value, 'EVM JSON array', state.budget)
      const result: EvmJsonValue[] = []
      for (let index = 0; index < length; index += 1) {
        const descriptor = descriptors[String(index)]
        if (descriptor === undefined || !('value' in descriptor)) throw new FatalCodecError('EVM JSON array is sparse')
        result.push(encode(descriptor.value, state, depth + 1))
      }
      return result
    }
    const descriptors = plainObjectDescriptors(value, 'EVM JSON object', state.budget)
    const keys = Object.keys(descriptors).sort()
    if (state.budget.nodes + keys.length > maximumNodes) throw new FatalCodecError('EVM JSON object exceeds the work budget')
    const result: Record<string, EvmJsonValue> = Object.create(null) as Record<string, EvmJsonValue>
    for (const key of keys) {
      const descriptor = descriptors[key]
      if (descriptor === undefined || !('value' in descriptor)) throw new FatalCodecError(`unresolved EVM JSON property ${key}`)
      result[key] = encode(descriptor.value, state, depth + 1)
    }
    return result
  } finally {
    state.active.delete(value)
  }
}

export function encodeEvmJson(value: unknown): EvmJsonValue {
  return encode(value, { budget: { nodes: 0, bytes: 0 }, active: new Set(), references: new Map() }, 0)
}

function cloneSchema(value: unknown, budget: Budget, active = new Set<object>(), depth = 0): InertJson {
  if (depth > maximumDepth) throw new FatalCodecError(`schema depth exceeds ${maximumDepth}`)
  if (value === null || typeof value === 'boolean') {
    charge(budget)
    return value
  }
  if (typeof value === 'string') {
    charge(budget, stringBytes(value))
    return value
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || Object.is(value, -0)) throw new FatalCodecError('schema number is invalid')
    charge(budget)
    return value
  }
  if (typeof value !== 'object' || isProxy(value)) throw new FatalCodecError('schema must be plain JSON')
  if (active.has(value)) throw new FatalCodecError('schema must not contain cycles')
  charge(budget)
  active.add(value)
  try {
    if (Array.isArray(value)) {
      const { descriptors, length } = arrayDescriptors(value, 'schema array', budget)
      const result: InertJson[] = []
      for (let index = 0; index < length; index += 1) {
        const descriptor = descriptors[String(index)]
        if (descriptor === undefined || !('value' in descriptor)) throw new FatalCodecError('schema array is sparse')
        result.push(cloneSchema(descriptor.value, budget, active, depth + 1))
      }
      return result
    }
    const descriptors = plainObjectDescriptors(value, 'schema object', budget)
    const keys = Object.keys(descriptors).sort()
    if (budget.nodes + keys.length > maximumNodes) throw new FatalCodecError('schema object exceeds the work budget')
    const result: Record<string, InertJson> = Object.create(null) as Record<string, InertJson>
    for (const key of keys) {
      const descriptor = descriptors[key]
      if (descriptor === undefined || !('value' in descriptor)) throw new FatalCodecError(`unresolved schema property ${key}`)
      result[key] = cloneSchema(descriptor.value, budget, active, depth + 1)
    }
    return result
  } finally {
    active.delete(value)
  }
}

function asRecord(value: InertJson | undefined, label: string): InertRecord {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new FatalCodecError(`${label} must be an object`)
  return value
}

function asArray(value: InertJson | undefined, label: string): InertJson[] {
  if (!Array.isArray(value)) throw new FatalCodecError(`${label} must be an array`)
  return value
}

function own(schema: InertRecord, key: string): InertJson | undefined {
  return Object.prototype.hasOwnProperty.call(schema, key) ? schema[key] : undefined
}

function validateScalarConstraints(schema: InertRecord): void {
  const constant = own(schema, 'const')
  const enumeration = own(schema, 'enum')
  if (constant !== undefined && enumeration !== undefined) throw new FatalCodecError('schema cannot combine const and enum')
  for (const [keyword, value] of [['const', constant], ['enum', enumeration]] as const) {
    if (value === undefined) continue
    const values = keyword === 'enum' ? asArray(value, 'schema enum') : [value]
    if (values.length === 0 || values.length > maximumUnionMembers) {
      throw new FatalCodecError(`schema ${keyword} has an unsupported number of values`)
    }
    for (let index = 0; index < values.length; index += 1) {
      const candidate = values[index]
      if (candidate !== null && typeof candidate === 'object') throw new FatalCodecError(`${keyword} supports scalar values only`)
    }
  }
}

function validateBytesMarker(schema: InertRecord, properties: InertRecord, required: readonly string[]): void {
  if (own(schema, 'x-tas-type') !== 'bytes') throw new FatalCodecError('unsupported x-tas-type marker')
  if (own(schema, 'type') !== 'object' || own(schema, 'additionalProperties') !== false) {
    throw new FatalCodecError('bytes schema must be a closed object')
  }
  if (Object.keys(properties).toSorted().join('\0') !== 'encoding\0value'
    || [...required].toSorted().join('\0') !== 'encoding\0value') {
    throw new FatalCodecError('bytes schema must contain exactly encoding and value')
  }
  const encoding = asRecord(properties.encoding, 'bytes encoding schema')
  const value = asRecord(properties.value, 'bytes value schema')
  const outerKeys = Object.keys(schema).filter((key) => key !== '$schema' && key !== '$defs').toSorted()
  if (outerKeys.join('\0') !== 'additionalProperties\0properties\0required\0type\0x-tas-type'
    || Object.keys(encoding).toSorted().join('\0') !== 'const\0type'
    || Object.keys(value).toSorted().join('\0') !== 'format\0type'
    || own(encoding, 'type') !== 'string' || own(encoding, 'const') !== 'hex'
    || own(value, 'type') !== 'string' || own(value, 'format') !== 'hex') {
    throw new FatalCodecError('bytes schema has an invalid binary envelope')
  }
}

function validateSchema(schema: InertRecord, root: InertRecord, active = new Set<InertRecord>()): void {
  if (active.has(schema)) throw new FatalCodecError('schema structure is recursive')
  active.add(schema)
  try {
    for (const key of Object.keys(schema)) {
      if (!supportedSchemaKeys.has(key)) throw new FatalCodecError(`unsupported schema keyword ${key}`)
    }
    const reference = own(schema, '$ref')
    if (reference !== undefined) {
      if (typeof reference !== 'string' || !reference.startsWith('#/$defs/')) throw new FatalCodecError('only local $defs references are supported')
      const siblings = Object.keys(schema).filter((key) => key !== '$ref' && key !== '$defs' && key !== '$schema')
      if (siblings.length > 0) throw new FatalCodecError('$ref siblings are not supported')
    }
    const schemaVersion = own(schema, '$schema')
    if (schemaVersion !== undefined && schemaVersion !== 'https://json-schema.org/draft/2020-12/schema') {
      throw new FatalCodecError('unsupported JSON Schema version')
    }
    const type = own(schema, 'type')
    if (type !== undefined && (typeof type !== 'string'
      || !['null', 'boolean', 'number', 'string', 'array', 'object'].includes(type))) {
      throw new FatalCodecError('unsupported schema type')
    }
    const format = own(schema, 'format')
    if (format !== undefined && (typeof format !== 'string'
      || !['bigint', 'uint256', 'int256', 'hex', 'evm-address'].includes(format))) {
      throw new FatalCodecError('unsupported schema format')
    }
    const pattern = own(schema, 'pattern')
    if (pattern !== undefined) {
      if (typeof pattern !== 'string') throw new FatalCodecError('schema pattern must be a string')
      if (!supportedPatterns.has(pattern)) throw new FatalCodecError('schema pattern is not in the supported deterministic set')
    }
    for (const keyword of ['minLength', 'maxLength'] as const) {
      const length = own(schema, keyword)
      if (length !== undefined && (typeof length !== 'number' || !Number.isSafeInteger(length) || length < 0)) {
        throw new FatalCodecError(`schema ${keyword} is invalid`)
      }
    }
    const writeOnly = own(schema, 'writeOnly')
    if (writeOnly !== undefined && typeof writeOnly !== 'boolean') throw new FatalCodecError('schema writeOnly must be boolean')
    for (const keyword of ['minItems', 'maxItems'] as const) {
      const value = own(schema, keyword)
      if (value !== undefined && (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0)) {
        throw new FatalCodecError(`schema ${keyword} is invalid`)
      }
    }
    validateScalarConstraints(schema)
    const required = own(schema, 'required')
    let requiredNames: string[] = []
    if (required !== undefined) {
      const entries = asArray(required, 'schema required')
      const names = new Set<string>()
      for (let index = 0; index < entries.length; index += 1) {
        const name = entries[index]
        if (typeof name !== 'string' || names.has(name)) throw new FatalCodecError('schema required must contain unique strings')
        names.add(name)
      }
      requiredNames = [...names]
    }
    const definitions = own(schema, '$defs')
    if (definitions !== undefined) {
      const record = asRecord(definitions, 'schema $defs')
      for (const key of Object.keys(record)) validateSchema(asRecord(record[key], `schema definition ${key}`), root, active)
    }
    const properties = own(schema, 'properties')
    if (properties !== undefined) {
      const record = asRecord(properties, 'schema properties')
      for (const key of Object.keys(record)) validateSchema(asRecord(record[key], `schema property ${key}`), root, active)
    }
    const oneOf = own(schema, 'oneOf')
    const anyOf = own(schema, 'anyOf')
    const unionKeyword = oneOf !== undefined ? 'oneOf' : anyOf !== undefined ? 'anyOf' : undefined
    if (unionKeyword !== undefined) {
      const siblings = Object.keys(schema).filter((key) => key !== unionKeyword && key !== '$defs' && key !== '$schema')
      if (siblings.length > 0) throw new FatalCodecError(`${unionKeyword} siblings are not supported`)
      const branches = asArray(own(schema, unionKeyword), `schema ${unionKeyword}`)
      if (branches.length === 0 || branches.length > maximumUnionMembers) {
        throw new FatalCodecError(`schema ${unionKeyword} must contain 1-${maximumUnionMembers} branches`)
      }
      for (let index = 0; index < branches.length; index += 1) validateSchema(asRecord(branches[index], 'schema branch'), root, active)
      return
    }
    const prefixItems = own(schema, 'prefixItems')
    if (prefixItems !== undefined) {
      const entries = asArray(prefixItems, 'schema prefixItems')
      for (let index = 0; index < entries.length; index += 1) validateSchema(asRecord(entries[index], 'schema tuple item'), root, active)
    }
    for (const keyword of ['items', 'additionalProperties'] as const) {
      const value = own(schema, keyword)
      if (value !== undefined && typeof value !== 'boolean') validateSchema(asRecord(value, `schema ${keyword}`), root, active)
      if (keyword === 'items' && value === true) throw new FatalCodecError('schema items=true is unsupported')
    }

    if (reference !== undefined) return
    if (type === undefined) {
      if (own(schema, 'const') === undefined && own(schema, 'enum') === undefined) {
        throw new FatalCodecError('schema must define type, oneOf, anyOf, $ref, const, or enum')
      }
      return
    }
    const minLength = own(schema, 'minLength')
    const maxLength = own(schema, 'maxLength')
    const stringKeywords = format !== undefined || pattern !== undefined
      || minLength !== undefined || maxLength !== undefined || writeOnly !== undefined
    if (stringKeywords && type !== 'string') throw new FatalCodecError('string keyword requires type=string')
    if (typeof minLength === 'number' && typeof maxLength === 'number' && minLength > maxLength) {
      throw new FatalCodecError('schema minLength exceeds maxLength')
    }
    const arrayKeywords = ['items', 'prefixItems', 'minItems', 'maxItems'].some((key) => own(schema, key) !== undefined)
    if (arrayKeywords && type !== 'array') throw new FatalCodecError('array keyword requires type=array')
    const objectKeywords = ['properties', 'required', 'additionalProperties', 'x-tas-type'].some((key) => own(schema, key) !== undefined)
    if (objectKeywords && type !== 'object') throw new FatalCodecError('object keyword requires type=object')
    const minimum = own(schema, 'minItems')
    const maximum = own(schema, 'maxItems')
    if (typeof minimum === 'number' && typeof maximum === 'number' && minimum > maximum) {
      throw new FatalCodecError('schema minItems exceeds maxItems')
    }
    if (type === 'object') {
      const propertyRecord = properties === undefined
        ? Object.create(null) as InertRecord
        : asRecord(properties, 'schema properties')
      if (requiredNames.some((name) => !Object.hasOwn(propertyRecord, name))) {
        throw new FatalCodecError('schema required names must exist in properties')
      }
      if (own(schema, 'x-tas-type') !== undefined) validateBytesMarker(schema, propertyRecord, requiredNames)
    }
  } finally {
    active.delete(schema)
  }
}

function resolveReference(reference: string, root: InertRecord): InertRecord {
  const name = reference.slice('#/$defs/'.length)
  if (name.length === 0 || name.includes('/') || name === '__proto__') throw new FatalCodecError('invalid local schema reference')
  const definitions = asRecord(own(root, '$defs'), 'schema $defs')
  if (!Object.prototype.hasOwnProperty.call(definitions, name)) throw new FatalCodecError(`unresolved schema reference ${reference}`)
  return asRecord(definitions[name], `schema definition ${name}`)
}

function mismatch(message: string): never {
  throw new ValueMismatch(message)
}

function decodeInteger(format: string, value: unknown): bigint {
  if (typeof value !== 'string') return mismatch(`${format} must be a canonical decimal string`)
  const pattern = format === 'uint256' ? canonicalUnsignedInteger : canonicalInteger
  if (!pattern.test(value)) return mismatch(`${format} must be a canonical decimal string`)
  const maximumDigits = format === 'bigint' ? 79 : 78
  if (value.length > maximumDigits) return mismatch(`${format} exceeds the supported decimal width`)
  const decoded = BigInt(value)
  if (format === 'uint256' && (decoded < 0n || decoded >= 2n ** 256n)) return mismatch('uint256 is out of range')
  if (format === 'int256' && (decoded < -(2n ** 255n) || decoded >= 2n ** 255n)) return mismatch('int256 is out of range')
  return decoded
}

function dataProperty(value: object, key: string, label: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key)
  if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) {
    throw new FatalCodecError(`${label}.${key} must be an enumerable data property`)
  }
  return descriptor.value
}

function decodeBytesEnvelope(value: unknown, state: ValueState): Uint8Array {
  if (typeof value !== 'object' || value === null || Array.isArray(value) || isProxy(value)) {
    return mismatch('bytes value must be a binary envelope')
  }
  const descriptors = plainObjectDescriptors(value, 'bytes envelope', state.budget)
  const keys = Object.keys(descriptors).toSorted()
  if (keys.join('\0') !== 'encoding\0value') return mismatch('bytes envelope has unexpected properties')
  const encoding = dataProperty(value, 'encoding', 'bytes envelope')
  const encoded = dataProperty(value, 'value', 'bytes envelope')
  if (encoding !== 'hex' || typeof encoded !== 'string'
    || !/^0x(?:[0-9a-fA-F]{2})*$/.test(encoded)) return mismatch('bytes envelope must contain even-length hex')
  charge(state.budget, stringBytes(encoding) + stringBytes(encoded), (encoded.length - 2) / 2)
  return Uint8Array.from(Buffer.from(encoded.slice(2), 'hex'))
}

function decodedValuesEquivalent(
  left: DecodedEvmValue,
  right: DecodedEvmValue,
  budget: Budget,
  depth: number,
): boolean {
  if (depth > maximumDepth) throw new FatalCodecError(`decoded comparison depth exceeds ${maximumDepth}`)
  charge(budget)
  if (left === null || right === null || typeof left !== 'object' || typeof right !== 'object') {
    return Object.is(left, right)
  }
  if (left instanceof Uint8Array || right instanceof Uint8Array) {
    if (!(left instanceof Uint8Array) || !(right instanceof Uint8Array)
      || Object.getPrototypeOf(left) !== Uint8Array.prototype
      || Object.getPrototypeOf(right) !== Uint8Array.prototype
      || typedArrayByteLengthGetter === undefined
      || typedArrayByteOffsetGetter === undefined
      || typedArrayBufferGetter === undefined) return false
    const leftLength = typedArrayByteLengthGetter.call(left) as number
    const rightLength = typedArrayByteLengthGetter.call(right) as number
    if (leftLength !== rightLength) return false
    charge(budget, 0, leftLength)
    const leftBuffer = typedArrayBufferGetter.call(left) as ArrayBuffer
    const rightBuffer = typedArrayBufferGetter.call(right) as ArrayBuffer
    const leftOffset = typedArrayByteOffsetGetter.call(left) as number
    const rightOffset = typedArrayByteOffsetGetter.call(right) as number
    return Buffer.from(leftBuffer, leftOffset, leftLength)
      .equals(Buffer.from(rightBuffer, rightOffset, rightLength))
  }
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right)) return false
    const leftArray = arrayDescriptors(left as DecodedEvmValue[], 'decoded comparison array', budget)
    const rightArray = arrayDescriptors(right as DecodedEvmValue[], 'decoded comparison array', budget)
    if (leftArray.length !== rightArray.length) return false
    for (let index = 0; index < leftArray.length; index += 1) {
      const leftValue = leftArray.descriptors[String(index)]
      const rightValue = rightArray.descriptors[String(index)]
      if (leftValue === undefined || rightValue === undefined || !('value' in leftValue) || !('value' in rightValue)
        || !decodedValuesEquivalent(
          leftValue.value as DecodedEvmValue,
          rightValue.value as DecodedEvmValue,
          budget,
          depth + 1,
        )) return false
    }
    return true
  }
  const leftDescriptors = plainObjectDescriptors(left, 'decoded comparison object', budget)
  const rightDescriptors = plainObjectDescriptors(right, 'decoded comparison object', budget)
  const leftKeys = Object.keys(leftDescriptors).toSorted()
  const rightKeys = Object.keys(rightDescriptors).toSorted()
  if (leftKeys.length !== rightKeys.length || leftKeys.some((key, index) => key !== rightKeys[index])) return false
  for (const key of leftKeys) {
    const leftValue = leftDescriptors[key]
    const rightValue = rightDescriptors[key]
    if (leftValue === undefined || rightValue === undefined || !('value' in leftValue) || !('value' in rightValue)
      || !decodedValuesEquivalent(
        leftValue.value as DecodedEvmValue,
        rightValue.value as DecodedEvmValue,
        budget,
        depth + 1,
      )) return false
  }
  return true
}

function decode(schema: InertRecord, value: unknown, root: InertRecord, state: ValueState, depth: number): DecodedEvmValue {
  if (depth > maximumDepth) throw new FatalCodecError(`decoded EVM JSON depth exceeds ${maximumDepth}`)
  charge(state.budget, typeof value === 'string' ? stringBytes(value) : 0)
  const reference = own(schema, '$ref')
  if (typeof reference === 'string') {
    const values = state.references.get(reference) ?? new Set<unknown>()
    if (values.has(value)) throw new FatalCodecError(`recursive schema reference ${reference}`)
    values.add(value)
    state.references.set(reference, values)
    try {
      return decode(resolveReference(reference, root), value, root, state, depth + 1)
    } finally {
      values.delete(value)
      if (values.size === 0) state.references.delete(reference)
    }
  }

  const constant = own(schema, 'const')
  if (constant !== undefined && value !== constant) return mismatch('value does not match schema const')
  const enumeration = own(schema, 'enum')
  if (enumeration !== undefined) {
    const entries = asArray(enumeration, 'schema enum')
    let found = false
    for (let index = 0; index < entries.length; index += 1) if (entries[index] === value) found = true
    if (!found) return mismatch('value does not match schema enum')
  }

  const oneOf = own(schema, 'oneOf')
  if (oneOf !== undefined) {
    const branches = asArray(oneOf, 'schema oneOf')
    if (branches.length > maximumUnionMembers) throw new FatalCodecError('schema oneOf exceeds the branch budget')
    charge(state.budget, 0, branches.length)
    let matched: DecodedEvmValue | undefined
    let matches = 0
    for (let index = 0; index < branches.length; index += 1) {
      try {
        const decoded = decode(asRecord(branches[index], 'schema branch'), value, root, state, depth + 1)
        matches += 1
        if (matches > 1) throw new FatalCodecError('value matches more than one schema branch')
        matched = decoded
      } catch (error) {
        if (!(error instanceof ValueMismatch)) throw error
      }
    }
    if (matches !== 1 || matched === undefined) return mismatch('value must match exactly one schema branch')
    return matched
  }

  const anyOf = own(schema, 'anyOf')
  if (anyOf !== undefined) {
    const branches = asArray(anyOf, 'schema anyOf')
    if (branches.length > maximumUnionMembers) throw new FatalCodecError('schema anyOf exceeds the branch budget')
    charge(state.budget, 0, branches.length)
    let matched: DecodedEvmValue | undefined
    let matches = 0
    for (let index = 0; index < branches.length; index += 1) {
      try {
        const decoded = decode(asRecord(branches[index], 'schema branch'), value, root, state, depth + 1)
        if (matches > 0 && matched !== undefined
          && !decodedValuesEquivalent(matched, decoded, state.budget, depth + 1)) {
          throw new FatalCodecError('ambiguous anyOf branches decode the value differently')
        }
        matched = decoded
        matches += 1
      } catch (error) {
        if (!(error instanceof ValueMismatch)) throw error
      }
    }
    if (matches === 0 || matched === undefined) return mismatch('value must match at least one schema branch')
    return matched
  }

  const type = own(schema, 'type')
  if (type === undefined && (constant !== undefined || enumeration !== undefined)) {
    if (value === null || typeof value === 'boolean' || typeof value === 'string'
      || (typeof value === 'number' && Number.isFinite(value) && !Object.is(value, -0))) return value
    return mismatch('const/enum value is not a supported scalar')
  }
  if (type === 'null') {
    if (value !== null) return mismatch('value must be null')
    return null
  }
  if (type === 'boolean') {
    if (typeof value !== 'boolean') return mismatch('value must be boolean')
    return value
  }
  if (type === 'number') {
    if (typeof value !== 'number' || !Number.isFinite(value) || Object.is(value, -0)
      || (Number.isInteger(value) && !Number.isSafeInteger(value))) return mismatch('value must be a finite safe number')
    return value
  }
  if (type === 'string') {
    const format = own(schema, 'format')
    let result: string | bigint
    if (format === 'bigint' || format === 'uint256' || format === 'int256') result = decodeInteger(format, value)
    else {
      if (typeof value !== 'string') return mismatch('value must be string')
      if (format === 'hex' && !hexString.test(value)) return mismatch('value must be 0x-prefixed hex')
      if (format === 'evm-address' && !evmAddress.test(value)) return mismatch('value must be a 20-byte EVM address')
      result = value
    }
    if (typeof value !== 'string') return mismatch('value must be string')
    const minLength = own(schema, 'minLength')
    if (typeof minLength === 'number' && value.length < minLength) return mismatch('value is shorter than minLength')
    const maxLength = own(schema, 'maxLength')
    if (typeof maxLength === 'number' && value.length > maxLength) return mismatch('value is longer than maxLength')
    const pattern = own(schema, 'pattern')
    if (typeof pattern === 'string' && !(supportedPatterns.get(pattern)?.test(value) ?? false)) {
      return mismatch('value does not match schema pattern')
    }
    return result
  }
  if (type === 'array') {
    if (!Array.isArray(value) || isProxy(value)) return mismatch('value must be an array')
    if (state.active.has(value)) throw new FatalCodecError('decoded value contains a cycle')
    const { descriptors, length } = arrayDescriptors(value, 'decoded array', state.budget)
    const minimum = own(schema, 'minItems')
    const maximum = own(schema, 'maxItems')
    if (typeof minimum === 'number' && length < minimum) return mismatch('array is shorter than minItems')
    if (typeof maximum === 'number' && length > maximum) return mismatch('array is longer than maxItems')
    state.active.add(value)
    try {
      const prefixItems = own(schema, 'prefixItems')
      const prefix = prefixItems === undefined ? undefined : asArray(prefixItems, 'schema prefixItems')
      const result: DecodedEvmValue[] = []
      for (let index = 0; index < length; index += 1) {
        const itemSchema = prefix !== undefined && index < prefix.length ? prefix[index] : own(schema, 'items')
        if (itemSchema === false || itemSchema === undefined) return mismatch(`array item ${index} is not allowed`)
        result.push(decode(asRecord(itemSchema, 'schema item'), dataProperty(value, String(index), 'decoded array'), root, state, depth + 1))
      }
      return result
    } finally { state.active.delete(value) }
  }
  if (type === 'object') {
    if (own(schema, 'x-tas-type') === 'bytes') return decodeBytesEnvelope(value, state)
    if (typeof value !== 'object' || value === null || Array.isArray(value) || isProxy(value)) return mismatch('value must be an object')
    if (state.active.has(value)) throw new FatalCodecError('decoded value contains a cycle')
    const descriptors = plainObjectDescriptors(value, 'decoded object', state.budget)
    state.active.add(value)
    try {
      const propertiesValue = own(schema, 'properties')
      const properties = propertiesValue === undefined ? Object.create(null) as InertRecord : asRecord(propertiesValue, 'schema properties')
      const requiredValue = own(schema, 'required')
      if (requiredValue !== undefined) {
        const required = asArray(requiredValue, 'schema required')
        for (let index = 0; index < required.length; index += 1) {
          const key = required[index]
          if (typeof key !== 'string' || !Object.prototype.hasOwnProperty.call(descriptors, key)) return mismatch(`missing required property ${String(key)}`)
        }
      }
      const additional = own(schema, 'additionalProperties')
      const result: Record<string, DecodedEvmValue> = Object.create(null) as Record<string, DecodedEvmValue>
      for (const key of Object.keys(descriptors).sort()) {
        const raw = dataProperty(value, key, 'decoded object')
        if (Object.prototype.hasOwnProperty.call(properties, key)) {
          result[key] = decode(asRecord(properties[key], `schema property ${key}`), raw, root, state, depth + 1)
        } else if (additional === false || additional === undefined) return mismatch(`additional property ${key} is not allowed`)
        else if (additional === true) result[key] = decodeJson(raw, state, depth + 1)
        else result[key] = decode(asRecord(additional, 'schema additionalProperties'), raw, root, state, depth + 1)
      }
      return result
    } finally { state.active.delete(value) }
  }
  throw new FatalCodecError(`unsupported schema type ${String(type)}`)
}

function decodeJson(value: unknown, state: ValueState, depth: number): DecodedEvmValue {
  return encode(value, state, depth)
}

export function decodeBySchema(schemaValue: unknown, value: unknown): DecodedEvmValue {
  const schemaBudget = { nodes: 0, bytes: 0 }
  const root = asRecord(cloneSchema(schemaValue, schemaBudget), 'root schema')
  validateSchema(root, root)
  return decode(root, value, root, { budget: { nodes: 0, bytes: 0 }, active: new Set(), references: new Map() }, 0)
}
