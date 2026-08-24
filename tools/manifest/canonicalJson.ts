import canonicalize from 'canonicalize'

import { clonePlainJson, type PlainJsonPrimitive, type PlainJsonValue } from '../../src/core/json/plainJson.js'

type SerializeFrame =
  | { readonly kind: 'value'; readonly value: PlainJsonValue }
  | { readonly kind: 'text'; readonly value: string }

const invalidJsonMessage = 'canonicalJson requires a plain JSON tree.'
const MAX_CANONICAL_JSON_OUTPUT_BYTES = 1_048_576

export interface CanonicalJsonOptions {
  readonly maxExpandedNodes?: number
}

function invalidJson(): never {
  throw new TypeError(invalidJsonMessage)
}

function ownKeys(value: object): readonly PropertyKey[] {
  try {
    return Reflect.ownKeys(value)
  } catch {
    return invalidJson()
  }
}

function ownDataDescriptor(value: object, key: PropertyKey): PropertyDescriptor {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (descriptor === undefined || !('value' in descriptor)) return invalidJson()
    return descriptor
  } catch {
    return invalidJson()
  }
}

function createStack<T>(): { readonly size: () => number; readonly push: (value: T) => void; readonly pop: () => T } {
  const values = Object.create(null) as Record<string, T>
  let size = 0
  return {
    size: () => size,
    push: (value) => {
      Object.defineProperty(values, String(size), {
        value,
        enumerable: true,
        configurable: true,
        writable: true,
      })
      size += 1
    },
    pop: () => {
      size -= 1
      const key = String(size)
      const descriptor = Object.getOwnPropertyDescriptor(values, key)
      if (descriptor === undefined || !('value' in descriptor)) return invalidJson()
      delete values[key]
      return descriptor.value
    },
  }
}

function sortedObjectKeys(value: object): readonly string[] {
  const reflected = ownKeys(value)
  const source = new Array<string>(reflected.length)
  const target = new Array<string>(reflected.length)
  Object.setPrototypeOf(source, null)
  Object.setPrototypeOf(target, null)
  for (let index = 0; index < reflected.length; index += 1) {
    const key = reflected[index]
    if (typeof key !== 'string') invalidJson()
    Object.defineProperty(source, String(index), { value: key, enumerable: true, configurable: true, writable: true })
  }

  let input = source
  let output = target
  for (let width = 1; width < reflected.length; width *= 2) {
    for (let start = 0; start < reflected.length; start += width * 2) {
      const middle = Math.min(start + width, reflected.length)
      const end = Math.min(start + width * 2, reflected.length)
      let left = start
      let right = middle
      for (let destination = start; destination < end; destination += 1) {
        const takeLeft = right >= end || (left < middle && (input[left] as string) < (input[right] as string))
        const key = takeLeft ? input[left++] : input[right++]
        Object.defineProperty(output, String(destination), { value: key, enumerable: true, configurable: true, writable: true })
      }
    }
    const previousInput = input
    input = output
    output = previousInput
  }
  return input
}

function canonicalPrimitive(value: PlainJsonPrimitive): string {
  try {
    const result = canonicalize(value)
    if (result === undefined) invalidJson()
    return result
  } catch {
    return invalidJson()
  }
}

function serializePlainJson(root: PlainJsonValue): string {
  const frames = createStack<SerializeFrame>()
  frames.push({ kind: 'value', value: root })
  let output = ''
  let outputBytes = 0
  const append = (value: string): void => {
    const bytes = Buffer.byteLength(value, 'utf8')
    if (bytes > MAX_CANONICAL_JSON_OUTPUT_BYTES - outputBytes) invalidJson()
    outputBytes += bytes
    output += value
  }

  while (frames.size() > 0) {
    const frame = frames.pop()
    if (frame.kind === 'text') {
      append(frame.value)
      continue
    }
    const value = frame.value
    if (value === null || typeof value !== 'object') {
      if (typeof value === 'string' && Buffer.byteLength(value, 'utf8') + 2 > MAX_CANONICAL_JSON_OUTPUT_BYTES - outputBytes) {
        invalidJson()
      }
      append(canonicalPrimitive(value))
      continue
    }
    if (Array.isArray(value)) {
      const length = ownDataDescriptor(value, 'length').value as number
      frames.push({ kind: 'text', value: ']' })
      for (let index = length - 1; index >= 0; index -= 1) {
        frames.push({ kind: 'value', value: ownDataDescriptor(value, String(index)).value as PlainJsonValue })
        if (index > 0) frames.push({ kind: 'text', value: ',' })
      }
      frames.push({ kind: 'text', value: '[' })
      continue
    }

    const keys = sortedObjectKeys(value)
    frames.push({ kind: 'text', value: '}' })
    for (let index = keys.length - 1; index >= 0; index -= 1) {
      const key = keys[index] as string
      frames.push({ kind: 'value', value: ownDataDescriptor(value, key).value as PlainJsonValue })
      frames.push({ kind: 'text', value: ':' })
      frames.push({ kind: 'value', value: key })
      if (index > 0) frames.push({ kind: 'text', value: ',' })
    }
    frames.push({ kind: 'text', value: '{' })
  }

  return output
}

export function canonicalJson(value: unknown, options: CanonicalJsonOptions = {}): string {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(options, 'maxExpandedNodes')
    if (descriptor !== undefined && !('value' in descriptor)) invalidJson()
    const maxExpandedNodes = descriptor?.value as unknown
    if (maxExpandedNodes !== undefined
      && (typeof maxExpandedNodes !== 'number' || !Number.isSafeInteger(maxExpandedNodes) || maxExpandedNodes < 1)) {
      invalidJson()
    }
    return serializePlainJson(clonePlainJson(value, maxExpandedNodes === undefined
      ? {}
      : { maxExpandedNodes }))
  } catch {
    return invalidJson()
  }
}
