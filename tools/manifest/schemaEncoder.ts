import {
  ElementFlags,
  SignatureKind,
  SymbolFlags,
  TypeFlags,
  type Checker,
  type Symbol as TypeScriptSymbol,
  type Type,
  type TupleType,
  type UnionType,
} from 'typescript/unstable/sync'
import {
  type ViemActionProjectionContext,
  type ViemProjection,
} from './analyzeViem.js'

export type JsonSchema = { readonly [key: string]: ViemProjection }

export interface ActionSchemaProjection {
  readonly [key: string]: ViemProjection
  readonly input_schema: JsonSchema
  readonly output_schema: JsonSchema
}

export interface EncodeTypeSchemaOptions {
  readonly position: 'input' | 'output'
}

interface EncoderState {
  readonly checker: Checker
  readonly active: Set<number>
  readonly analyzerValidated: boolean
  nodes: number
  usesJsonValue: boolean
}

const schemaVersion = 'https://json-schema.org/draft/2020-12/schema'
const maximumNodes = 10_000
const maximumUnionMembers = 256
const runtimeTypeName = /^(?:Account|ArrayBuffer|Buffer|Client|DataView|Date|EIP1193RequestFn|LocalAccount|Map|OpaqueClient|PrivateKeyAccount|Promise|ReadableStream|RegExp|Set|Transport|Uint8Array|WeakMap|WeakSet|WebSocket|WritableStream)$/
const bigintPattern = '^(?:0|-?[1-9][0-9]*)$'
const maximumBigintLength = 79

type ScalarLiteral = null | boolean | number | string | bigint

function jsonValueDefinition(): JsonSchema {
  return {
    oneOf: [
      { type: 'null' },
      { type: 'boolean' },
      { type: 'number' },
      { type: 'string' },
      { type: 'array', items: { $ref: '#/$defs/jsonValue' } },
      { type: 'object', additionalProperties: { $ref: '#/$defs/jsonValue' } },
    ],
  }
}

function symbolName(type: Type): string | undefined {
  return type.getAliasSymbol()?.name ?? type.getSymbol()?.name
}

function typeLabel(type: Type, checker: Checker): string {
  return checker.typeToString(type)
}

function resolvePropertyType(property: TypeScriptSymbol, checker: Checker): Type | undefined {
  const declaration = property.declarations[0]?.resolve()
  return declaration === undefined
    ? checker.getTypeOfSymbol(property)
    : checker.getTypeOfSymbolAtLocation(property, declaration)
}

function fail(type: Type, checker: Checker, reason: string): never {
  throw new Error(`cannot encode ${typeLabel(type, checker)}: ${reason}`)
}

function charge(state: EncoderState): void {
  state.nodes += 1
  if (state.nodes > maximumNodes) throw new Error(`schema type graph exceeds ${maximumNodes} nodes`)
}

function chargeUnion(state: EncoderState, members: number): void {
  if (members > maximumUnionMembers) throw new Error(`schema union exceeds ${maximumUnionMembers} members`)
  state.nodes += members
  if (state.nodes > maximumNodes) throw new Error(`schema type graph exceeds ${maximumNodes} nodes`)
}

function binarySchema(): JsonSchema {
  return {
    type: 'object',
    'x-tas-type': 'bytes',
    properties: {
      encoding: { type: 'string', const: 'hex' },
      value: { type: 'string', format: 'hex' },
    },
    required: ['encoding', 'value'],
    additionalProperties: false,
  }
}

function isUndefined(type: Type): boolean {
  return (type.flags & TypeFlags.Undefined) !== 0
}

function literal(type: Type, checker: Checker): ScalarLiteral | undefined {
  if ((type.flags & TypeFlags.Null) !== 0) return null
  if (type.isStringLiteralType()) return type.value
  if (type.isNumberLiteralType()) return type.value
  if (type.isBigIntLiteralType()) return type.value
  if (type.isBooleanLiteralType()) return checker.typeToString(type) === 'true'
  return undefined
}

function bigintSchema(): JsonSchema {
  return { type: 'string', format: 'bigint', pattern: bigintPattern, maxLength: maximumBigintLength }
}

function canonicalBigintLiteral(value: bigint): string {
  const encoded = value.toString(10)
  if (encoded.length > maximumBigintLength) {
    throw new Error(`bigint literal exceeds ${maximumBigintLength} canonical characters`)
  }
  return encoded
}

function literalSchema(value: ScalarLiteral): JsonSchema {
  if (value === null) return { type: 'null' }
  if (typeof value === 'bigint') return { ...bigintSchema(), const: canonicalBigintLiteral(value) }
  return { type: typeof value, const: value }
}

function recursiveJsonSchema(state: EncoderState): JsonSchema {
  state.usesJsonValue = true
  return { $ref: '#/$defs/jsonValue' }
}

function arrayArguments(type: Type, checker: Checker): readonly Type[] {
  return type.isTypeReference() ? checker.getTypeArguments(type) : []
}

function discriminantName(parts: readonly Type[], checker: Checker): string | undefined {
  if (parts.length < 2) return undefined
  const firstProperties = checker.getPropertiesOfType(parts[0] as Type)
  for (const property of firstProperties) {
    const values = new Set<string>()
    let valid = true
    for (const part of parts) {
      const candidate = checker.getPropertyOfType(part, property.name)
      const candidateType = candidate === undefined ? undefined : checker.getTypeOfSymbol(candidate)
      const candidateLiteral = candidateType === undefined ? undefined : literal(candidateType, checker)
      if (candidateLiteral === undefined || candidateLiteral === null) {
        valid = false
        break
      }
      values.add(`${typeof candidateLiteral}:${String(candidateLiteral)}`)
    }
    if (valid && values.size === parts.length) return property.name
  }
  return undefined
}

function tupleFlags(type: TupleType): readonly ElementFlags[] {
  let current = type
  const seen = new Set<number>()
  for (let depth = 0; depth < 8 && !seen.has(current.id); depth += 1) {
    seen.add(current.id)
    if (current.elementFlags !== undefined) return current.elementFlags
    if (current.fixedLength === 0) return []
    const target = current.getTarget() as TupleType
    if (target.id === current.id) break
    current = target
  }
  throw new Error('tuple element metadata is unavailable')
}

function tupleRange(type: TupleType): { readonly minimum: number; readonly maximum: number } {
  let minimum = 0
  let maximum = 0
  for (const flags of tupleFlags(type)) {
    if ((flags & ElementFlags.Required) !== 0) minimum += 1
    if ((flags & (ElementFlags.Rest | ElementFlags.Variadic)) !== 0) maximum = Number.POSITIVE_INFINITY
    else if (maximum !== Number.POSITIVE_INFINITY) maximum += 1
  }
  return { minimum, maximum }
}

function disjointTupleUnion(parts: readonly Type[], checker: Checker): boolean {
  if (!parts.every((part) => checker.isTupleType(part))) return false
  const ranges = parts.map((part) => tupleRange(part as TupleType))
  return ranges.every((left, index) => ranges.every((right, otherIndex) =>
    index === otherIndex || left.maximum < right.minimum || right.maximum < left.minimum))
}

function schemaType(schema: JsonSchema): string | undefined {
  if (typeof schema.type === 'string') return schema.type
  const branches = Array.isArray(schema.oneOf) ? schema.oneOf : undefined
  if (branches === undefined || branches.length === 0) return undefined
  const types = branches.map((branch) => projectionRecord(branch) === undefined
    ? undefined
    : schemaType(branch as JsonSchema))
  return types[0] !== undefined && types.every((type) => type === types[0]) ? types[0] : undefined
}

function stringArray(value: ViemProjection | undefined): readonly string[] | undefined {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string')
    ? value as readonly string[]
    : undefined
}

function objectSchemasAreDisjoint(left: JsonSchema, right: JsonSchema): boolean {
  if (left.additionalProperties !== false || right.additionalProperties !== false) return false
  const leftProperties = projectionRecord(left.properties)
  const rightProperties = projectionRecord(right.properties)
  if (leftProperties === undefined || rightProperties === undefined) return false
  const leftRequired = stringArray(left.required) ?? []
  const rightRequired = stringArray(right.required) ?? []
  return leftRequired.some((name) => !Object.hasOwn(rightProperties, name))
    || rightRequired.some((name) => !Object.hasOwn(leftProperties, name))
    || leftRequired.some((name) => rightRequired.includes(name)
      && Object.hasOwn(leftProperties, name)
      && Object.hasOwn(rightProperties, name)
      && schemasAreDisjoint(leftProperties[name] as JsonSchema, rightProperties[name] as JsonSchema))
}

function schemasAreDisjoint(left: JsonSchema, right: JsonSchema): boolean {
  const leftBranches = Array.isArray(left.oneOf) ? left.oneOf : undefined
  if (leftBranches !== undefined) return leftBranches.every((branch) => {
    const record = projectionRecord(branch)
    return record !== undefined && schemasAreDisjoint(record as JsonSchema, right)
  })
  const rightBranches = Array.isArray(right.oneOf) ? right.oneOf : undefined
  if (rightBranches !== undefined) return rightBranches.every((branch) => {
    const record = projectionRecord(branch)
    return record !== undefined && schemasAreDisjoint(left, record as JsonSchema)
  })
  const leftType = schemaType(left)
  const rightType = schemaType(right)
  if (leftType !== undefined && rightType !== undefined && leftType !== rightType) return true
  if (left.const !== undefined && right.const !== undefined && left.const !== right.const) return true
  return leftType === 'object' && rightType === 'object' && objectSchemasAreDisjoint(left, right)
}

function scalarDecodeKind(schema: JsonSchema): string | undefined {
  const union = Array.isArray(schema.oneOf)
    ? schema.oneOf
    : Array.isArray(schema.anyOf) ? schema.anyOf : undefined
  if (union !== undefined) {
    const kinds = union.map((branch) => {
      const record = projectionRecord(branch)
      return record === undefined ? undefined : scalarDecodeKind(record as JsonSchema)
    })
    return kinds[0] !== undefined && kinds.every((kind) => kind === kinds[0]) ? kinds[0] : undefined
  }
  const type = typeof schema.type === 'string' ? schema.type : undefined
  if (type === 'null' || type === 'boolean' || type === 'number') return type
  if (type !== 'string') return undefined
  const format = schema.format
  return format === 'bigint' || format === 'uint256' || format === 'int256'
    ? 'bigint'
    : 'string'
}

function overlappingSchemasDecodeEquivalently(left: JsonSchema, right: JsonSchema): boolean {
  if (schemasAreDisjoint(left, right) || JSON.stringify(left) === JSON.stringify(right)) return true
  const leftKind = scalarDecodeKind(left)
  const rightKind = scalarDecodeKind(right)
  if (leftKind !== undefined || rightKind !== undefined) return leftKind !== undefined && leftKind === rightKind
  if (schemaType(left) !== 'object' || schemaType(right) !== 'object'
    || left.additionalProperties !== false || right.additionalProperties !== false) return false
  if (left['x-tas-type'] !== right['x-tas-type']) return false
  const leftProperties = projectionRecord(left.properties)
  const rightProperties = projectionRecord(right.properties)
  if (leftProperties === undefined || rightProperties === undefined) return false
  for (const name of Object.keys(leftProperties)) {
    if (!Object.hasOwn(rightProperties, name)) continue
    const leftProperty = projectionRecord(leftProperties[name]) as JsonSchema | undefined
    const rightProperty = projectionRecord(rightProperties[name]) as JsonSchema | undefined
    if (leftProperty === undefined || rightProperty === undefined
      || !overlappingSchemasDecodeEquivalently(leftProperty, rightProperty)) return false
  }
  return true
}

function closedObjectSchemaSubset(left: JsonSchema, right: JsonSchema): boolean {
  if (schemaType(left) !== 'object' || schemaType(right) !== 'object'
    || left.additionalProperties !== false || right.additionalProperties !== false) return false
  const leftProperties = projectionRecord(left.properties)
  const rightProperties = projectionRecord(right.properties)
  if (leftProperties === undefined || rightProperties === undefined) return false
  if (!Object.entries(leftProperties).every(([name, schema]) =>
    Object.hasOwn(rightProperties, name) && JSON.stringify(schema) === JSON.stringify(rightProperties[name]))) return false
  const leftRequired = stringArray(left.required) ?? []
  const rightRequired = stringArray(right.required) ?? []
  return rightRequired.every((name) => leftRequired.includes(name))
}

function normalizeHomogeneousArrayUnion(schemas: readonly JsonSchema[]): readonly JsonSchema[] | undefined {
  if (!schemas.every((schema) => schemaType(schema) === 'array'
    && schema.prefixItems === undefined
    && (schema.minItems === undefined || schema.minItems === 0)
    && (schema.maxItems === undefined || (typeof schema.maxItems === 'number' && schema.maxItems >= 1))
    && typeof schema.items === 'object'
    && schema.items !== null
    && !Array.isArray(schema.items))) return undefined
  const items = schemas.map((schema) => schema.items as JsonSchema)
  const itemsDisjoint = items.every((left, index) => items.every((right, otherIndex) =>
    index === otherIndex || schemasAreDisjoint(left, right)))
  if (!itemsDisjoint) return undefined
  return schemas.map((schema, index) => index === 0
    ? schema
    : { ...schema, minItems: Math.max(typeof schema.minItems === 'number' ? schema.minItems : 0, 1) })
}

function projectionRecord(value: ViemProjection | undefined): Readonly<Record<string, ViemProjection>> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  return value as Readonly<Record<string, ViemProjection>>
}

function normalizeClosedObjectUnion(schemas: readonly JsonSchema[]): readonly JsonSchema[] | undefined {
  if (schemas.length < 2 || !schemas.every((schema) => schemaType(schema) === 'object'
    && schema.additionalProperties === false
    && projectionRecord(schema.properties) !== undefined)) return undefined
  const records = schemas.map((schema) => projectionRecord(schema.properties) as Readonly<Record<string, ViemProjection>>)
  const common = Object.keys(records[0] as Readonly<Record<string, ViemProjection>>).filter((name) =>
    records.every((record) => Object.hasOwn(record, name)
      && JSON.stringify(record[name]) === JSON.stringify(records[0]?.[name])))
  const commonSet = new Set(common)
  const commonRequired = (stringArray(schemas[0]?.required) ?? []).filter((name) => commonSet.has(name)).toSorted()
  if (!schemas.every((schema) => (stringArray(schema.required) ?? [])
    .filter((name) => commonSet.has(name)).toSorted().join('\0') === commonRequired.join('\0'))) return undefined
  const firstRecord = records[0] as Readonly<Record<string, ViemProjection>>
  const firstRequired = stringArray(schemas[0]?.required) ?? []
  if (Object.keys(firstRecord).some((name) => !commonSet.has(name) && firstRequired.includes(name))) return undefined

  const normalized: JsonSchema[] = []
  for (let index = 0; index < schemas.length; index += 1) {
    const schema = schemas[index] as JsonSchema
    const record = records[index] as Readonly<Record<string, ViemProjection>>
    const unique = Object.keys(record).filter((name) => !commonSet.has(name))
    if (index > 0 && unique.length !== 1) return undefined
    if (index > 0 && records.slice(0, index).some((prior) => Object.hasOwn(prior, unique[0] as string))) return undefined
    if (index > 0 && (stringArray(schema.required) ?? []).includes(unique[0] as string)) return undefined
    normalized.push(index === 0
      ? schema
      : { ...schema, required: [...new Set([...(stringArray(schema.required) ?? []), unique[0] as string])].toSorted() })
  }
  return normalized
}

function normalizeOverlappingObjectRequirements(schemas: readonly JsonSchema[]): readonly JsonSchema[] | undefined {
  if (schemas.length !== 2 || !schemas.every((schema) => schemaType(schema) === 'object'
    && schema.additionalProperties === false
    && projectionRecord(schema.properties) !== undefined)) return undefined
  const left = schemas[0] as JsonSchema
  const right = schemas[1] as JsonSchema
  const leftProperties = projectionRecord(left.properties) as Readonly<Record<string, ViemProjection>>
  const rightProperties = projectionRecord(right.properties) as Readonly<Record<string, ViemProjection>>
  if (JSON.stringify(leftProperties) !== JSON.stringify(rightProperties)) return undefined
  const leftRequired = stringArray(left.required) ?? []
  const rightRequired = stringArray(right.required) ?? []
  const leftOnly = leftRequired.filter((name) => !rightRequired.includes(name))
  const rightOnly = rightRequired.filter((name) => !leftRequired.includes(name))
  if (leftOnly.length !== 1 || rightOnly.length === 0) return undefined
  const narrowedRight: Record<string, ViemProjection> = Object.create(null) as Record<string, ViemProjection>
  for (const [name, schema] of Object.entries(rightProperties)) {
    if (name !== leftOnly[0]) narrowedRight[name] = schema
  }
  return [left, { ...right, properties: narrowedRight }]
}

function normalizeScalarUnion(schemas: readonly JsonSchema[]): JsonSchema | undefined {
  for (const schema of schemas) {
    if (schema.format !== 'bigint') continue
    const values = schema.const !== undefined
      ? [schema.const]
      : Array.isArray(schema.enum) ? schema.enum : []
    if (values.some((value) => typeof value !== 'string'
      || !new RegExp(bigintPattern).test(value)
      || value.length > maximumBigintLength)) {
      throw new Error(`bigint literal union exceeds ${maximumBigintLength} canonical characters`)
    }
  }
  const type = schemaType(schemas[0] as JsonSchema)
  if (type === undefined || type === 'array' || type === 'object'
    || !schemas.every((schema) => schemaType(schema) === type)) return undefined
  const bases = schemas.map(({ const: _constant, enum: _enumeration, ...base }) => JSON.stringify(base))
  if (!bases.every((base) => base === bases[0])) return undefined
  if (schemas.some((schema) => schema.const === undefined && schema.enum === undefined)) {
    const { const: _constant, enum: _enumeration, ...base } = schemas[0] as JsonSchema
    return base
  }
  const values = schemas.flatMap((schema) => schema.const !== undefined
    ? [schema.const]
    : [...(schema.enum as readonly ViemProjection[])])
  const unique = values.filter((value, index) => values.findIndex((candidate) => candidate === value) === index)
    .sort((left, right) => String(left).localeCompare(String(right)))
  const { const: _constant, enum: _enumeration, ...base } = schemas[0] as JsonSchema
  return { ...base, enum: unique }
}

function overlapComponents(schemas: readonly JsonSchema[]): readonly (readonly JsonSchema[])[] {
  const remaining = new Set(schemas.map((_schema, index) => index))
  const components: JsonSchema[][] = []
  while (remaining.size > 0) {
    const first = remaining.values().next().value as number
    remaining.delete(first)
    const indexes = [first]
    for (let cursor = 0; cursor < indexes.length; cursor += 1) {
      const current = schemas[indexes[cursor] as number] as JsonSchema
      for (const candidate of [...remaining]) {
        if (!schemasAreDisjoint(current, schemas[candidate] as JsonSchema)) {
          remaining.delete(candidate)
          indexes.push(candidate)
        }
      }
    }
    components.push(indexes.toSorted((left, right) => left - right).map((index) => schemas[index] as JsonSchema))
  }
  return components
}

function normalizeOverlappingGroup(schemas: readonly JsonSchema[]): JsonSchema | undefined {
  const scalar = normalizeScalarUnion(schemas)
  if (scalar !== undefined) return scalar
  const arrays = normalizeHomogeneousArrayUnion(schemas)
  if (arrays !== undefined) return { oneOf: arrays }
  const objects = normalizeClosedObjectUnion(schemas)
  if (objects !== undefined) return { oneOf: objects }
  const requirements = normalizeOverlappingObjectRequirements(schemas)
  if (requirements !== undefined) return { oneOf: requirements }
  return undefined
}

function encodeUnion(type: UnionType, state: EncoderState, position: 'input' | 'output'): JsonSchema {
  const sourceParts = type.getTypes()
  chargeUnion(state, sourceParts.length)
  const parts = sourceParts.filter((part) => !isUndefined(part))
  if (parts.length === 0) return fail(type, state.checker, 'union contains only undefined')
  if (parts.length === 1) return encode(parts[0] as Type, state, position)

  const literalValues = parts.map((part) => literal(part, state.checker))
  if (literalValues.every((value) => value !== undefined)) {
    const values = literalValues as ScalarLiteral[]
    const kinds = new Set(values.map((value) => value === null ? 'null' : typeof value))
    if (kinds.size === 1 && values[0] !== null) {
      const sorted = values.map((value) => typeof value === 'bigint' ? canonicalBigintLiteral(value) : value)
        .sort((left, right) => String(left).localeCompare(String(right)))
      if (typeof values[0] === 'bigint') return { ...bigintSchema(), enum: sorted }
      return { type: typeof values[0], enum: sorted }
    }
    const schemas = values.map(literalSchema)
      .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)))
    if (!schemas.every((left, index) => schemas.every((right, otherIndex) =>
      index === otherIndex || schemasAreDisjoint(left, right)))) {
      return fail(type, state.checker, 'literal union overlaps after JSON encoding')
    }
    return { oneOf: schemas }
  }

  const nonNull = parts.filter((part) => (part.flags & TypeFlags.Null) === 0)
  if (nonNull.length === 1 && nonNull.length !== parts.length) {
    return { oneOf: [{ type: 'null' }, encode(nonNull[0] as Type, state, position)] }
  }

  if (disjointTupleUnion(parts, state.checker)) {
    return { oneOf: parts.map((part) => encode(part, state, position)) }
  }

  const discriminant = discriminantName(parts, state.checker)
  if (discriminant !== undefined) {
    const branches = parts.map((part) => ({
      type: part,
      value: literal(state.checker.getTypeOfSymbol(
        state.checker.getPropertyOfType(part, discriminant) as NonNullable<ReturnType<Checker['getPropertyOfType']>>,
      ) as Type, state.checker),
    })).sort((left, right) => String(left.value).localeCompare(String(right.value)))
    return { oneOf: branches.map(({ type: branch }) => encode(branch, state, position)) }
  }

  return combineEncodedUnion(type, state, parts.map((part) => encode(part, state, position)))
}

function combineEncodedUnion(type: Type, state: EncoderState, encoded: readonly JsonSchema[]): JsonSchema {
  if (encoded.length === 0) return fail(type, state.checker, 'union has no encodable branches')
  const deduplicated = encoded.filter((schema, index) => encoded.findIndex((candidate) =>
    JSON.stringify(candidate) === JSON.stringify(schema)) === index)
  const uniqueEncoded = deduplicated.filter((schema, index) => !deduplicated.some((candidate, otherIndex) =>
    index !== otherIndex
    && closedObjectSchemaSubset(schema, candidate)
    && !closedObjectSchemaSubset(candidate, schema)))
  if (uniqueEncoded.length === 1) return uniqueEncoded[0] as JsonSchema
  const normalizedScalar = normalizeScalarUnion(uniqueEncoded)
  if (normalizedScalar !== undefined) return normalizedScalar
  const pairwiseDisjoint = uniqueEncoded.every((left, index) => uniqueEncoded.every((right, otherIndex) =>
    index === otherIndex || schemasAreDisjoint(left, right)))
  if (pairwiseDisjoint) return { oneOf: uniqueEncoded }
  const normalizedArrays = normalizeHomogeneousArrayUnion(uniqueEncoded)
  if (normalizedArrays !== undefined) return { oneOf: normalizedArrays }
  const normalizedObjects = normalizeClosedObjectUnion(uniqueEncoded)
  if (normalizedObjects !== undefined) return { oneOf: normalizedObjects }
  const normalizedRequirements = normalizeOverlappingObjectRequirements(uniqueEncoded)
  if (normalizedRequirements !== undefined) return { oneOf: normalizedRequirements }
  const components = overlapComponents(uniqueEncoded)
  if (components.length > 1) {
    const normalized = components.map((component) => component.length === 1
      ? component[0] as JsonSchema
      : normalizeOverlappingGroup(component))
    if (normalized.every((schema) => schema !== undefined)) return { oneOf: normalized as JsonSchema[] }
  }
  const equivalentOverlap = uniqueEncoded.every((left, index) => uniqueEncoded.every((right, otherIndex) =>
    index === otherIndex || overlappingSchemasDecodeEquivalently(left, right)))
  if (equivalentOverlap) return { anyOf: uniqueEncoded }
  return fail(type, state.checker, 'union branches overlap with different decoded representations at the JSON boundary')
}

function encodeObject(type: Type, state: EncoderState, position: 'input' | 'output'): JsonSchema {
  const checker = state.checker
  const name = symbolName(type)
  if (state.analyzerValidated && (name === 'ByteArray' || name === 'Uint8Array')) {
    return binarySchema()
  }
  if (name !== undefined && runtimeTypeName.test(name)) return fail(type, checker, `runtime type ${name} is not JSON`)
  if (checker.getSignaturesOfType(type, SignatureKind.Call).length > 0) return fail(type, checker, 'callable values are not JSON')
  if ((type.getSymbol()?.flags ?? 0) & SymbolFlags.Class) return fail(type, checker, 'class instances are not JSON')

  if (checker.isTupleType(type)) {
    const elements = arrayArguments(type, checker)
    const tuple = type as TupleType
    const elementFlags = tupleFlags(tuple)
    const prefixItems: JsonSchema[] = []
    let items: JsonSchema | false = false
    for (let index = 0; index < elements.length; index += 1) {
      const element = elements[index]
      const flags = elementFlags[index]
      if (element === undefined || flags === undefined) return fail(type, checker, 'tuple element type is unresolved')
      if ((flags & (ElementFlags.Rest | ElementFlags.Variadic)) !== 0) items = encode(element, state, position)
      else prefixItems.push(encode(element, state, position))
    }
    const range = tupleRange(tuple)
    return {
      type: 'array',
      prefixItems,
      minItems: range.minimum,
      ...(Number.isFinite(range.maximum) ? { maxItems: range.maximum } : {}),
      items,
    }
  }
  if (checker.isArrayLikeType(type)) {
    const elements = arrayArguments(type, checker)
    if (elements.length !== 1 || elements[0] === undefined) return fail(type, checker, 'array element type is unresolved')
    return { type: 'array', items: encode(elements[0], state, position) }
  }

  if (state.active.has(type.id)) return fail(type, checker, 'ordinary recursive types are unbounded')
  state.active.add(type.id)
  try {
    const properties = checker.getPropertiesOfType(type).toSorted((left, right) => left.name.localeCompare(right.name))
    const indexes = checker.getIndexInfosOfType(type)
    if (properties.length === 0 && indexes.length === 1 && indexes[0] !== undefined) {
      if ((indexes[0].keyType.flags & TypeFlags.String) === 0) return fail(type, checker, 'only string-key records are supported')
      return { type: 'object', additionalProperties: encode(indexes[0].valueType, state, position) }
    }
    if (indexes.length > 0) return fail(type, checker, 'mixed or non-string index signatures are unsupported')
    if (properties.length === 0) return fail(type, checker, 'object has no finite JSON properties')

    const encodedProperties: Record<string, ViemProjection> = Object.create(null) as Record<string, ViemProjection>
    const required: string[] = []
    for (const property of properties) {
      const propertyType = checker.getTypeOfSymbol(property)
      if (propertyType === undefined) return fail(type, checker, `property ${property.name} is unresolved`)
      if ((property.flags & SymbolFlags.Optional) !== 0) {
        const possible = propertyType.isUnionType()
          ? propertyType.getTypes().filter((part) => !isUndefined(part) && (part.flags & TypeFlags.Never) === 0)
          : ((propertyType.flags & (TypeFlags.Undefined | TypeFlags.Never)) !== 0 ? [] : [propertyType])
        if (possible.length === 0) continue
      }
      encodedProperties[property.name] = encode(propertyType, state, position)
      if ((property.flags & SymbolFlags.Optional) === 0) required.push(property.name)
    }
    return {
      type: 'object',
      properties: encodedProperties,
      required,
      additionalProperties: false,
    }
  } finally {
    state.active.delete(type.id)
  }
}

function encode(type: Type, state: EncoderState, position: 'input' | 'output'): JsonSchema {
  charge(state)
  if ((type.flags & (TypeFlags.Any | TypeFlags.Unknown | TypeFlags.ESSymbol | TypeFlags.Void | TypeFlags.Never)) !== 0
    || type.isErrorType()) return fail(type, state.checker, 'type is not a finite JSON boundary')
  if (type.isUnionType()) return encodeUnion(type, state, position)
  if (type.isIntersectionType()) {
    if (state.checker.isTypeAssignableTo(type, state.checker.getStringType())) {
      const rendered = typeLabel(type, state.checker)
      return /0x/.test(rendered)
        ? { type: 'string', format: 'hex' }
        : { type: 'string' }
    }
    if (state.checker.isTypeAssignableTo(type, state.checker.getBooleanType())) return { type: 'boolean' }
    if (state.checker.isTypeAssignableTo(type, state.checker.getNumberType())) return { type: 'number' }
    if (state.checker.isTypeAssignableTo(type, state.checker.getBigIntType())) {
      return bigintSchema()
    }
    return encodeObject(type, state, position)
  }
  if (type.isTypeParameter()) {
    const constraint = state.checker.getBaseConstraintOfType(type)
    return constraint === undefined ? fail(type, state.checker, 'type parameter is unbounded') : encode(constraint, state, position)
  }
  if ((type.flags & (TypeFlags.Substitution | TypeFlags.IndexedAccess | TypeFlags.Conditional)) !== 0) {
    const resolved = state.checker.getBaseConstraintOfType(type) ?? state.checker.getApparentType(type)
    if (resolved !== undefined && resolved.id !== type.id) return encode(resolved, state, position)
  }
  const value = literal(type, state.checker)
  if (value !== undefined || (type.flags & TypeFlags.Null) !== 0) return literalSchema(value ?? null)
  if ((type.flags & TypeFlags.String) !== 0) return { type: 'string' }
  if ((type.flags & TypeFlags.Boolean) !== 0) return { type: 'boolean' }
  if ((type.flags & TypeFlags.Number) !== 0) return { type: 'number' }
  if ((type.flags & TypeFlags.BigInt) !== 0 || (type.flags & TypeFlags.BigIntLiteral) !== 0) {
    return bigintSchema()
  }
  if ((type.flags & TypeFlags.TemplateLiteral) !== 0 || state.checker.isTypeAssignableTo(type, state.checker.getStringType())) {
    const name = symbolName(type)
    const rendered = typeLabel(type, state.checker)
    if (name === 'Address' || rendered === 'Address') return { type: 'string', format: 'evm-address' }
    if (name === 'Hex' || rendered === 'Hex' || /0x/.test(rendered)) return { type: 'string', format: 'hex' }
    return { type: 'string' }
  }
  return encodeObject(type, state, position)
}

function finalize(schema: JsonSchema, state: EncoderState): JsonSchema {
  return {
    $schema: schemaVersion,
    ...schema,
    ...(state.usesJsonValue ? { $defs: { jsonValue: jsonValueDefinition() } } : {}),
  }
}

export function encodeTypeSchema(type: Type, checker: Checker, options: EncodeTypeSchemaOptions): JsonSchema {
  const state: EncoderState = { checker, active: new Set(), analyzerValidated: false, nodes: 0, usesJsonValue: false }
  return finalize(encode(type, state, options.position), state)
}

function inputBranchSchema(
  type: Type,
  context: ViemActionProjectionContext,
  state: EncoderState,
): JsonSchema {
  const properties: Record<string, ViemProjection> = Object.create(null) as Record<string, ViemProjection>
  const required: string[] = []
  const omitted = new Set(context.boundary.omittedInputProperties)
  const addresses = new Set(context.boundary.addressInputProperties)
  const dynamic = new Set(context.boundary.dynamicJsonInputProperties)
  for (const property of context.checker.getPropertiesOfType(type)
    .toSorted((left, right) => left.name.localeCompare(right.name))) {
    if (omitted.has(property.name)) continue
    const propertyType = resolvePropertyType(property, context.checker)
    if (propertyType === undefined) throw new Error(`input property ${property.name} is unresolved`)
    const possible = propertyType.isUnionType()
      ? propertyType.getTypes().filter((part) => (part.flags & (TypeFlags.Never | TypeFlags.Undefined)) === 0)
      : ((propertyType.flags & (TypeFlags.Never | TypeFlags.Undefined)) === 0 ? [propertyType] : [])
    if (possible.length === 0) {
      if ((property.flags & SymbolFlags.Optional) === 0) {
        throw new Error(`input property ${property.name} is required but has no JSON-representable value`)
      }
      continue
    }
    if (addresses.has(property.name)) properties[property.name] = { type: 'string', format: 'evm-address' }
    else if (dynamic.has(property.name)) {
      state.usesJsonValue = true
      properties[property.name] = { type: 'array', items: recursiveJsonSchema(state) }
    } else {
      try {
        properties[property.name] = encode(propertyType, state, 'input')
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error)
        throw new Error(`input branch ${context.checker.typeToString(type)} property ${property.name}: ${detail}`)
      }
    }
    if ((property.flags & SymbolFlags.Optional) === 0) required.push(property.name)
  }
  if (context.sourceProfile === 'viem-wallet') {
    properties.credential = {
      type: 'object',
      properties: {
        type: { const: 'inline' },
        secret: { type: 'string', minLength: 1, writeOnly: true },
      },
      required: ['secret', 'type'],
      additionalProperties: false,
    }
  }
  return { type: 'object', properties, required, additionalProperties: false }
}

function inputSchema(context: ViemActionProjectionContext): JsonSchema {
  const state: EncoderState = { checker: context.checker, active: new Set(), analyzerValidated: true, nodes: 0, usesJsonValue: false }
  if ((context.inputType.flags & TypeFlags.Void) !== 0) {
    return finalize({ type: 'object', properties: {}, required: [], additionalProperties: false }, state)
  }
  const branches = context.inputType.isUnionType()
    ? context.inputType.getTypes().filter((type) => (type.flags & (TypeFlags.Null | TypeFlags.Undefined)) === 0)
    : [context.inputType]
  if (context.sourceProfile === 'viem-wallet'
    && branches.some((branch) => context.checker.getPropertyOfType(branch, 'credential') !== undefined)) {
    throw new Error('Wallet source input credential conflicts with the TAS common credential')
  }
  chargeUnion(state, branches.length)
  const schemas = branches.map((branch) => inputBranchSchema(branch, context, state))
  return finalize(schemas.length === 1
    ? schemas[0] as JsonSchema
    : combineEncodedUnion(context.inputType, state, schemas), state)
}

function outputSchema(context: ViemActionProjectionContext): JsonSchema {
  const state: EncoderState = { checker: context.checker, active: new Set(), analyzerValidated: true, nodes: 0, usesJsonValue: false }
  if (context.boundary.dynamicJsonOutput) return finalize(recursiveJsonSchema(state), state)
  const promise = symbolName(context.outputType) === 'Promise' && context.outputType.isTypeReference()
    ? context.checker.getTypeArguments(context.outputType)[0]
    : undefined
  return finalize(encode(promise ?? context.outputType, state, 'output'), state)
}

export function projectViemActionSchemas(context: ViemActionProjectionContext): ActionSchemaProjection {
  try {
    return {
      input_schema: inputSchema(context),
      output_schema: outputSchema(context),
    }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    throw new Error(`cannot project ${context.sourceProfile}:${context.sourceName}: ${detail}`)
  }
}
