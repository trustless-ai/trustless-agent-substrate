import { Buffer } from 'node:buffer'

import { TasError, type TasErrorCode } from '../errors.js'
import type { RepositoryResolver } from '../repository/resolver.js'
import type { DaClient, DaClientContent } from './client.js'
import { parseGitDaReference, requireGitDaPath } from './path.js'
import {
  DA_MAX_INLINE_BYTES,
  type DaCapabilities,
  type DaContent,
  type DaGetInput,
  type DaGetResult,
  type DaPutInput,
  type DaPutResult,
  type DaRetrievedContent,
  type GitDaReference,
} from './types.js'

export interface DaService {
  capabilities(): Promise<DaCapabilities>
  get(input: DaGetInput): Promise<DaGetResult>
  put(input: DaPutInput): Promise<DaPutResult>
}

export interface DaServiceOptions {
  readonly maxInlineBytes?: number
  /** One total deadline covering Repository resolution and every Client request. */
  readonly operationTimeoutMs?: number
}

const defaultOperationTimeoutMs = 30_000
const maxOperationTimeoutMs = 300_000
const maxMediaTypeCharacters = 1_024
const typedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype) as object
const typedArrayByteLength = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'byteLength')?.get

function invalidArgument(): never {
  throw new TasError('INVALID_ARGUMENT', 'The request arguments are invalid.')
}

function contentTooLarge(): never {
  throw new TasError('DA_CONTENT_TOO_LARGE', 'The DA content exceeds the inline size limit.')
}

function fetchFailed(): never {
  throw new TasError('DA_FETCH_FAILED', 'The requested DA content could not be read.')
}

function writeFailed(): never {
  throw new TasError('DA_WRITE_FAILED', 'The DA content could not be written.')
}

function outcomeUnknown(): never {
  throw new TasError('OPERATION_OUTCOME_UNKNOWN', 'The external operation outcome is unknown.')
}

function pathInvalid(): never {
  throw new TasError('DA_PATH_INVALID', 'The DA destination path is invalid.')
}

function requireLimit(value: number | undefined): number {
  const limit = value ?? DA_MAX_INLINE_BYTES
  return Number.isSafeInteger(limit) && limit > 0 && limit <= DA_MAX_INLINE_BYTES
    ? limit
    : invalidArgument()
}

function requireOperationTimeout(value: number | undefined): number {
  const timeout = value ?? defaultOperationTimeoutMs
  return Number.isSafeInteger(timeout) && timeout >= 1 && timeout <= maxOperationTimeoutMs
    ? timeout
    : invalidArgument()
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException('The operation was aborted.', 'AbortError')
}

async function runBounded<T>(
  callerSignal: AbortSignal | undefined,
  timeoutMs: number,
  writeMayHaveStarted: () => boolean,
  operation: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  if (callerSignal?.aborted) throw abortReason(callerSignal)
  const controller = new AbortController()
  let timedOut = false
  const onCallerAbort = () => controller.abort(abortReason(callerSignal!))
  callerSignal?.addEventListener('abort', onCallerAbort, { once: true })
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort(new DOMException('The DA operation deadline was reached.', 'TimeoutError'))
  }, timeoutMs)
  timer.unref()

  let onAbort: (() => void) | undefined
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(abortReason(controller.signal))
    controller.signal.addEventListener('abort', onAbort, { once: true })
  })
  try {
    return await Promise.race([operation(controller.signal), aborted])
  } catch (error) {
    if (!controller.signal.aborted) throw error
    if (writeMayHaveStarted()) return outcomeUnknown()
    if (callerSignal?.aborted && !timedOut) throw abortReason(callerSignal)
    throw new TasError('DA_UNAVAILABLE', 'The configured DA backend is unavailable.')
  } finally {
    clearTimeout(timer)
    callerSignal?.removeEventListener('abort', onCallerAbort)
    if (onAbort) controller.signal.removeEventListener('abort', onAbort)
  }
}

function requireContent(content: DaContent, maxInlineBytes: number): {
  readonly bytes: Uint8Array
  readonly mediaType?: string
} {
  if (content === null || typeof content !== 'object' || Array.isArray(content)) return invalidArgument()
  const { encoding, value, media_type: mediaType } = content
  if (typeof value !== 'string') return invalidArgument()
  if (
    mediaType !== undefined
    && (typeof mediaType !== 'string' || mediaType.length > maxMediaTypeCharacters || !mediaType.isWellFormed())
  ) return invalidArgument()

  if (encoding === 'utf8') {
    if (value.length > maxInlineBytes) return contentTooLarge()
    if (!value.isWellFormed()) return invalidArgument()
    if (Buffer.byteLength(value, 'utf8') > maxInlineBytes) return contentTooLarge()
    return { bytes: new TextEncoder().encode(value), mediaType }
  }
  if (encoding !== 'base64') return invalidArgument()
  const maxEncodedCharacters = Math.ceil(maxInlineBytes / 3) * 4
  if (value.length > maxEncodedCharacters) return contentTooLarge()
  if (value.length % 4 !== 0 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    return invalidArgument()
  }
  const bytes = new Uint8Array(Buffer.from(value, 'base64'))
  if (Buffer.from(bytes).toString('base64') !== value) return invalidArgument()
  return { bytes, mediaType }
}

const missing = Symbol('missing')

function ownDataProperty(value: unknown, key: string): unknown | typeof missing {
  if (value === null || typeof value !== 'object') return missing
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    return descriptor && 'value' in descriptor ? descriptor.value : missing
  } catch {
    return missing
  }
}

function isUint8Array(value: unknown): value is Uint8Array {
  try {
    return value instanceof Uint8Array
  } catch {
    return false
  }
}

function projectClientContent(content: DaClientContent, maxInlineBytes: number): {
  readonly content: DaRetrievedContent
  readonly size: number
} {
  const bytesValue = ownDataProperty(content, 'bytes')
  const mediaTypeValue = ownDataProperty(content, 'mediaType')
  if (
    bytesValue === missing
    || !isUint8Array(bytesValue)
  ) return fetchFailed()
  if (mediaTypeValue !== missing && mediaTypeValue !== undefined && typeof mediaTypeValue !== 'string') {
    return fetchFailed()
  }
  if (
    typeof mediaTypeValue === 'string'
    && (mediaTypeValue.length > maxMediaTypeCharacters || !mediaTypeValue.isWellFormed())
  ) return fetchFailed()
  let size: number
  let bytes: Uint8Array
  try {
    if (typedArrayByteLength === undefined) return fetchFailed()
    size = Reflect.apply(typedArrayByteLength, bytesValue, []) as number
    if (size > maxInlineBytes) return contentTooLarge()
    bytes = new Uint8Array(size)
    Uint8Array.prototype.set.call(bytes, bytesValue)
  } catch (error) {
    if (error instanceof TasError && error.code === 'DA_CONTENT_TOO_LARGE') throw error
    return fetchFailed()
  }
  if (bytes.byteLength !== size || bytes.byteLength > maxInlineBytes) return contentTooLarge()
  const mediaType = mediaTypeValue === missing ? undefined : mediaTypeValue
  const envelope: DaRetrievedContent = mediaType === undefined
    ? { encoding: 'base64', value: Buffer.from(bytes).toString('base64') }
    : { encoding: 'base64', value: Buffer.from(bytes).toString('base64'), media_type: mediaType }
  return { content: envelope, size: bytes.byteLength }
}

const providerErrorMessages: Partial<Readonly<Record<TasErrorCode, string>>> = {
  CREDENTIAL_REQUIRED: 'A valid operation credential is required.',
  AUTHORIZATION_DENIED: 'The credential is not authorized for this operation.',
  DA_REFERENCE_INVALID: 'The DA reference is invalid.',
  DA_PATH_INVALID: 'The DA destination path is invalid.',
  DA_UNAVAILABLE: 'The configured DA backend is unavailable.',
  DA_FETCH_FAILED: 'The requested DA content could not be read.',
  DA_WRITE_FAILED: 'The DA content could not be written.',
  DA_CONTENT_TOO_LARGE: 'The DA content exceeds the inline size limit.',
  RESOLUTION_CONFLICT: 'The selected resolution changed during the operation.',
  OPERATION_OUTCOME_UNKNOWN: 'The external operation outcome is unknown.',
}

function preservedProviderError(error: unknown): TasError | undefined {
  if (!(error instanceof TasError)) return undefined
  const message = providerErrorMessages[error.code]
  return message === undefined ? undefined : new TasError(error.code, message)
}

async function clientGet(
  operation: () => Promise<DaClientContent>,
  signal: AbortSignal,
): Promise<DaClientContent> {
  try {
    return await operation()
  } catch (error) {
    if (signal.aborted) throw error
    const preserved = preservedProviderError(error)
    if (preserved) throw preserved
    return fetchFailed()
  }
}

async function clientPut(
  operation: () => Promise<GitDaReference>,
  signal: AbortSignal,
): Promise<GitDaReference> {
  try {
    return await operation()
  } catch (error) {
    if (signal.aborted) throw error
    const preserved = preservedProviderError(error)
    if (preserved) throw preserved
    return outcomeUnknown()
  }
}

export function createDaService(
  repositoryResolver: RepositoryResolver,
  client: DaClient,
  options: DaServiceOptions = {},
): DaService {
  const maxInlineBytes = requireLimit(options.maxInlineBytes)
  const operationTimeoutMs = requireOperationTimeout(options.operationTimeoutMs)

  return {
    async capabilities(): Promise<DaCapabilities> {
      return {
        backend: 'git',
        reference_types: ['git'],
        read: true,
        write: true,
        content_encodings: ['utf8', 'base64'],
        max_inline_bytes: maxInlineBytes,
      }
    },

    async get(input: DaGetInput): Promise<DaGetResult> {
      const ref = parseGitDaReference(input.ref)
      const selector = input.selector ?? { kind: 'latest' as const }
      const callerSignal = input.signal
      let credential = input.credential
      try {
        return await runBounded(callerSignal, operationTimeoutMs, () => false, async (signal) => {
          const source = await repositoryResolver.resolve(selector, { signal })
          signal.throwIfAborted()
          const projected = projectClientContent(
            await clientGet(() => client.get(source, ref, credential, { signal }), signal),
            maxInlineBytes,
          )
          return {
            source,
            ref: { ...ref },
            content: projected.content,
            size_bytes: projected.size,
          }
        })
      } finally {
        credential = undefined
      }
    },

    async put(input: DaPutInput): Promise<DaPutResult> {
      if (input.destination === undefined) return pathInvalid()
      const path = requireGitDaPath(input.destination.path)
      const decoded = requireContent(input.content, maxInlineBytes)
      if (decoded.bytes.byteLength > maxInlineBytes) return contentTooLarge()
      const selector = input.selector ?? { kind: 'latest' as const }
      const callerSignal = input.signal
      let credential = input.credential
      let writeStarted = false
      try {
        return await runBounded(callerSignal, operationTimeoutMs, () => writeStarted, async (signal) => {
          const source = await repositoryResolver.resolve(selector, { signal })
          signal.throwIfAborted()
          writeStarted = true
          const returned = await clientPut(
            () => client.put(source, path, decoded.bytes.slice(), decoded.mediaType, credential, { signal }),
            signal,
          )
          let ref: GitDaReference
          try {
            ref = parseGitDaReference(returned)
          } catch {
            return outcomeUnknown()
          }
          if (ref.path !== path) return outcomeUnknown()
          return { source, ref, size_bytes: decoded.bytes.byteLength }
        })
      } finally {
        credential = undefined
      }
    },
  }
}
