import { randomUUID } from 'node:crypto'

import { CallToolResultSchema } from '@modelcontextprotocol/core'
import type { z } from 'zod'

import { TasError, type TasErrorCode } from '../core/errors.js'
import type { CanonicalDecimal, EvmAddress } from '../local/config/types.js'

/** The MCP SDK's native tool result type, inferred from its public schema. */
export type CallToolResult = z.infer<typeof CallToolResultSchema>

export interface ChainResolutionContext {
  readonly block_number: CanonicalDecimal
  readonly block_hash: string
}

export interface ProfileResolutionContext {
  readonly version: string
}

export interface RepositoryResolutionContext {
  readonly url: string
  readonly commit: string
}

export type DaResolutionContext =
  | { readonly type: 'git'; readonly commit: string; readonly path: string }
  | { readonly type: 'ipfs'; readonly cid: string }

/** Immutable public references used or produced by one operation. */
export interface ResolutionContext {
  readonly profile?: ProfileResolutionContext
  readonly chain?: ChainResolutionContext
  readonly repository?: RepositoryResolutionContext
  readonly da?: DaResolutionContext
}

export type TasPublicInstance =
  | { readonly phase: 'identity_setup'; readonly chain_id: CanonicalDecimal; readonly identity_registry_address: EvmAddress }
  | { readonly phase: 'tawg_setup'; readonly chain_id: CanonicalDecimal; readonly tawg_address: EvmAddress }
  | { readonly phase: 'member'; readonly chain_id: CanonicalDecimal; readonly tawg_address: EvmAddress; readonly agent_id: CanonicalDecimal }

export type TasPublicContext =
  | { readonly instance: Extract<TasPublicInstance, { readonly phase: 'identity_setup' }>; readonly request_id: string }
  | { readonly instance: Extract<TasPublicInstance, { readonly phase: 'tawg_setup' }>; readonly request_id: string; readonly resolved?: ResolutionContext }
  | { readonly instance: Extract<TasPublicInstance, { readonly phase: 'member' }>; readonly request_id: string; readonly resolved?: ResolutionContext }

export type PublicJsonPrimitive = boolean | null | number | string
export type PublicJsonValue = PublicJsonPrimitive | readonly PublicJsonValue[] | PublicJsonObject
export interface PublicJsonObject {
  readonly [key: string]: PublicJsonValue
}

type ErrorCategory = 'configuration' | 'conflict' | 'unavailable' | 'integrity' | 'internal'
type RecoveryAction = 'retry' | 'change_request' | 'reconcile' | 'user_action' | 'abort'

interface PublicToolError {
  readonly code: TasErrorCode | 'INTERNAL_ERROR'
  readonly category: ErrorCategory
  readonly message: string
  readonly retryable: boolean
  readonly recovery: { readonly action: RecoveryAction }
}

interface ErrorBehavior {
  readonly category: ErrorCategory
  readonly message: string
  readonly retryable: boolean
  readonly action: RecoveryAction
}

const invariantMessage = 'TAS public result invariant violated.'
const maxProjectionDepth = 64
const maxProjectionNodes = 10_000
const maxProjectionEntries = 10_000
const absent = Symbol('absent')

const errorBehaviors: Readonly<Record<TasErrorCode, ErrorBehavior>> = {
  CONFIG_FILE_NOT_FOUND: { category: 'configuration', message: 'TAS configuration file was not found.', retryable: false, action: 'change_request' },
  CONFIG_PARSE_FAILED: { category: 'configuration', message: 'TAS configuration could not be read.', retryable: false, action: 'change_request' },
  CONFIG_VERSION_UNSUPPORTED: { category: 'configuration', message: 'TAS configuration version is unsupported.', retryable: false, action: 'change_request' },
  CONFIG_FIELD_INVALID: { category: 'configuration', message: 'Invalid configuration field', retryable: false, action: 'change_request' },
  CONFIG_CONFLICT: { category: 'configuration', message: 'TAS configuration contains a conflict.', retryable: false, action: 'change_request' },
  CONFIG_ENV_REQUIRED: { category: 'configuration', message: 'Required TAS configuration environment is unavailable.', retryable: false, action: 'change_request' },
  CONFIG_REFERENCE_INVALID: { category: 'configuration', message: 'TAS configuration reference is invalid.', retryable: false, action: 'change_request' },
  CONFIG_CLIENT_UNSUPPORTED: { category: 'configuration', message: 'Configured TAS client is unsupported.', retryable: false, action: 'change_request' },
  INSTANCE_ALREADY_RUNNING: { category: 'conflict', message: 'Member TAS instance is already running.', retryable: false, action: 'user_action' },
  INSTANCE_LOCK_FAILED: { category: 'unavailable', message: 'Member TAS instance lock is unavailable.', retryable: true, action: 'retry' },
  TAS_SKILL_BUNDLE_INVALID: { category: 'integrity', message: 'The bundled TAS Skill is invalid.', retryable: false, action: 'abort' },
  PROFILE_INCONSISTENT: { category: 'integrity', message: 'The selected TAWG Profile state is inconsistent.', retryable: false, action: 'abort' },
  REPOSITORY_LOCATOR_UNSUPPORTED: { category: 'integrity', message: 'The Profile-selected Repository locator is unsupported.', retryable: false, action: 'abort' },
  REPOSITORY_CURSOR_INVALID: { category: 'configuration', message: 'The Repository cursor is invalid.', retryable: false, action: 'change_request' },
  REPOSITORY_CURSOR_CONTEXT_MISMATCH: { category: 'conflict', message: 'The Repository cursor does not match the current request context.', retryable: false, action: 'change_request' },
  REPOSITORY_NOT_FOUND: { category: 'unavailable', message: 'The Profile-selected Repository was not found.', retryable: false, action: 'user_action' },
  REPOSITORY_FETCH_FAILED: { category: 'unavailable', message: 'The Profile-selected Repository could not be read.', retryable: true, action: 'retry' },
  REPOSITORY_RATE_LIMITED: { category: 'unavailable', message: 'The Repository provider rate limit was reached.', retryable: true, action: 'retry' },
  DA_REFERENCE_INVALID: { category: 'configuration', message: 'The DA reference is invalid.', retryable: false, action: 'change_request' },
  DA_PATH_INVALID: { category: 'configuration', message: 'The DA destination path is invalid.', retryable: false, action: 'change_request' },
  DA_UNAVAILABLE: { category: 'unavailable', message: 'The configured DA backend is unavailable.', retryable: true, action: 'retry' },
  DA_FETCH_FAILED: { category: 'unavailable', message: 'The requested DA content could not be read.', retryable: true, action: 'retry' },
  DA_WRITE_FAILED: { category: 'unavailable', message: 'The DA content could not be written.', retryable: false, action: 'reconcile' },
  DA_CONTENT_TOO_LARGE: { category: 'configuration', message: 'The DA content exceeds the inline size limit.', retryable: false, action: 'change_request' },
  SKILL_NOT_FOUND: { category: 'unavailable', message: 'The requested Skill was not found.', retryable: false, action: 'user_action' },
  SKILL_INVALID: { category: 'integrity', message: 'The requested Skill content is invalid.', retryable: false, action: 'abort' },
  SKILL_ROLE_INVALID: { category: 'configuration', message: 'The Role Skill identifier is invalid.', retryable: false, action: 'change_request' },
  SKILL_MEMBER_CONTEXT_REQUIRED: { category: 'configuration', message: 'A valid TAWG member context is required to load this Skill.', retryable: false, action: 'user_action' },
  SKILL_FETCH_FAILED: { category: 'unavailable', message: 'The requested Skill could not be read.', retryable: true, action: 'retry' },
  SKILL_CONTENT_TOO_LARGE: { category: 'integrity', message: 'The requested Skill exceeds the content size limit.', retryable: false, action: 'abort' },
  FINALITY_UNSUPPORTED: { category: 'unavailable', message: 'The requested chain finality is unsupported.', retryable: false, action: 'change_request' },
  HISTORICAL_STATE_UNAVAILABLE: { category: 'unavailable', message: 'The requested historical chain state is unavailable.', retryable: false, action: 'change_request' },
  RESOLUTION_CONFLICT: { category: 'conflict', message: 'The selected resolution changed during the operation.', retryable: true, action: 'retry' },
  EXTERNAL_UNAVAILABLE: { category: 'unavailable', message: 'The chain service is unavailable.', retryable: true, action: 'retry' },
  INVALID_ARGUMENT: { category: 'configuration', message: 'The request arguments are invalid.', retryable: false, action: 'change_request' },
  CREDENTIAL_REQUIRED: { category: 'configuration', message: 'A valid operation credential is required.', retryable: false, action: 'user_action' },
  AUTHORIZATION_DENIED: { category: 'conflict', message: 'The credential is not authorized for this operation.', retryable: false, action: 'user_action' },
  WALLET_MISMATCH: { category: 'conflict', message: 'The credential does not match the configured Agent wallet.', retryable: false, action: 'user_action' },
  MANIFEST_BINDING_UNSUPPORTED: { category: 'integrity', message: 'The requested generated binding is unavailable.', retryable: false, action: 'abort' },
  WORKFLOW_SOURCE_UNAVAILABLE: { category: 'unavailable', message: 'The Profile-selected Workflow source could not be read.', retryable: true, action: 'retry' },
  WORKFLOW_METADATA_INVALID: { category: 'integrity', message: 'The Workflow compiler metadata or source closure is invalid.', retryable: false, action: 'abort' },
  WORKFLOW_COMPILER_UNAVAILABLE: { category: 'configuration', message: 'The exact Workflow compiler is unavailable in this TAS release.', retryable: false, action: 'user_action' },
  WORKFLOW_COMPILER_BUSY: { category: 'unavailable', message: 'The Workflow compiler is busy with another verification.', retryable: true, action: 'retry' },
  WORKFLOW_COMPILE_FAILED: { category: 'integrity', message: 'The Workflow source could not be reproduced by its exact compiler.', retryable: false, action: 'abort' },
  WORKFLOW_DEPLOYMENT_UNSUPPORTED: { category: 'integrity', message: 'The Workflow deployment form is unsupported by TAS v0.1.', retryable: false, action: 'abort' },
  WORKFLOW_SOURCE_VERIFICATION_REQUIRED: { category: 'conflict', message: 'The current Workflow source must be verified before this operation.', retryable: false, action: 'reconcile' },
  OPERATION_OUTCOME_UNKNOWN: { category: 'unavailable', message: 'The external operation outcome is unknown.', retryable: false, action: 'reconcile' },
}

function invariant(): never {
  throw new Error(invariantMessage)
}

function ownDataProperty(value: object, key: string): unknown {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (!descriptor || !('value' in descriptor)) return invariant()
    return descriptor.value
  } catch {
    return invariant()
  }
}

function optionalOwnDataProperty(value: object, key: string): unknown | typeof absent {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (!descriptor) return absent
    if (!('value' in descriptor)) return invariant()
    return descriptor.value
  } catch { return invariant() }
}

function plainPrototype(value: object): object | null {
  try {
    return Object.getPrototypeOf(value)
  } catch {
    return invariant()
  }
}

function definePublicProperty(target: object, key: string, value: PublicJsonValue): void {
  Object.defineProperty(target, key, { configurable: true, enumerable: true, value, writable: true })
}

function clonePublicJson(value: unknown, ancestors: WeakSet<object>, depth: number, budget: { nodes: number; entries: number }): PublicJsonValue {
  if (depth > maxProjectionDepth || ++budget.nodes > maxProjectionNodes) return invariant()
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return value
  if (typeof value === 'number') return Number.isFinite(value) ? value : invariant()
  if (typeof value !== 'object') return invariant()
  if (ancestors.has(value)) return invariant()

  let prototype: object | null
  let isArray: boolean
  try {
    prototype = plainPrototype(value)
    isArray = Array.isArray(value)
  } catch { return invariant() }
  if (isArray ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null) return invariant()

  ancestors.add(value)
  try {
    if (isArray) {
      const declaredLength = ownDataProperty(value, 'length')
      if (typeof declaredLength !== 'number' || !Number.isSafeInteger(declaredLength) || declaredLength < 0) return invariant()

      const output: PublicJsonValue[] = []
      let count = 0
      for (const key in value) {
        const descriptor = Object.getOwnPropertyDescriptor(value, key)
        if (!descriptor) continue
        if (!descriptor.enumerable || !('value' in descriptor) || !/^(?:0|[1-9][0-9]*)$/.test(key)) return invariant()
        const index = Number(key)
        if (!Number.isSafeInteger(index) || index >= declaredLength || ++budget.entries > maxProjectionEntries) return invariant()
        count += 1
        output[index] = clonePublicJson(descriptor.value, ancestors, depth + 1, budget)
      }
      if (count !== declaredLength) return invariant()
      return output
    }

    const output: Record<string, PublicJsonValue> = Object.create(null) as Record<string, PublicJsonValue>
    for (const key in value) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      if (!descriptor) continue
      if (!descriptor.enumerable || !('value' in descriptor) || ++budget.entries > maxProjectionEntries) return invariant()
      definePublicProperty(output, key, clonePublicJson(descriptor.value, ancestors, depth + 1, budget))
    }
    return output
  } catch {
    return invariant()
  } finally {
    ancestors.delete(value)
  }
}

function clonePublicJsonValue(data: PublicJsonValue): PublicJsonValue {
  return clonePublicJson(data, new WeakSet(), 0, { nodes: 0, entries: 0 })
}

function publicString(value: object, key: string): string {
  const candidate = ownDataProperty(value, key)
  return typeof candidate === 'string' ? candidate : invariant()
}

function isCanonicalGitHubRepositoryUrl(url: string): boolean {
  try {
    const parsed = new URL(url)
    const parts = parsed.pathname.split('/').filter(Boolean)
    if (parsed.protocol !== 'https:' || parsed.hostname !== 'github.com' || parsed.port || parsed.username || parsed.password || parsed.search || parsed.hash || parts.length !== 2) return false
    const [owner, repository] = parts
    if (!/^[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*$/.test(owner) || owner.length > 39 || !/^[A-Za-z0-9._-]{1,100}$/.test(repository) || repository === '.' || repository === '..' || repository.toLowerCase().endsWith('.git')) return false
    return url === `https://github.com/${owner}/${repository}`
  } catch { return false }
}

function projectResolutionContext(resolution: ResolutionContext | undefined): ResolutionContext | undefined {
  if (!resolution) return undefined

  try {
    const projected: {
      profile?: ProfileResolutionContext
      chain?: ChainResolutionContext
      repository?: RepositoryResolutionContext
      da?: DaResolutionContext
    } = {}
    const profile = optionalOwnDataProperty(resolution, 'profile')
    const chain = optionalOwnDataProperty(resolution, 'chain')
    const repository = optionalOwnDataProperty(resolution, 'repository')
    const da = optionalOwnDataProperty(resolution, 'da')
    if (profile !== absent) {
      if (profile === null || typeof profile !== 'object') return invariant()
      projected.profile = { version: publicString(profile, 'version') }
    }
    if (chain !== absent) {
      if (chain === null || typeof chain !== 'object') return invariant()
      projected.chain = {
        block_number: publicString(chain, 'block_number'), block_hash: publicString(chain, 'block_hash'),
      }
    }
    if (repository !== absent) {
      if (repository === null || typeof repository !== 'object') return invariant()
      const url = publicString(repository, 'url')
      if (!isCanonicalGitHubRepositoryUrl(url)) return invariant()
      projected.repository = { url, commit: publicString(repository, 'commit') }
    }
    if (da !== absent) {
      if (da === null || typeof da !== 'object') return invariant()
      const type = publicString(da, 'type')
      projected.da = type === 'git'
        ? { type, commit: publicString(da, 'commit'), path: publicString(da, 'path') }
        : type === 'ipfs'
          ? { type, cid: publicString(da, 'cid') }
          : invariant()
    }
    return Object.keys(projected).length === 0 ? undefined : projected
  } catch {
    return invariant()
  }
}

function createContext(instance: TasPublicInstance, resolution: ResolutionContext | undefined): TasPublicContext {
  const detachedResolution = projectResolutionContext(resolution)
  const request_id = randomUUID()
  const phase = publicString(instance, 'phase')
  const chain_id = publicString(instance, 'chain_id')
  if (phase === 'identity_setup') {
    return {
      instance: { phase, chain_id, identity_registry_address: publicString(instance, 'identity_registry_address') as EvmAddress },
      request_id,
    }
  }

  if (phase === 'tawg_setup') {
    return {
      instance: { phase, chain_id, tawg_address: publicString(instance, 'tawg_address') as EvmAddress },
      request_id,
      ...(detachedResolution ? { resolved: detachedResolution } : {}),
    }
  }

  if (phase !== 'member') return invariant()
  return {
    instance: { phase, chain_id, tawg_address: publicString(instance, 'tawg_address') as EvmAddress, agent_id: publicString(instance, 'agent_id') },
    request_id,
    ...(detachedResolution ? { resolved: detachedResolution } : {}),
  }
}

function projectTasError(error: unknown): PublicToolError {
  let isTasError = false
  try { isTasError = error instanceof TasError } catch { return projectTasError(undefined) }
  if (!isTasError) {
    return {
      code: 'INTERNAL_ERROR',
      category: 'internal',
      message: 'The tool could not be completed.',
      retryable: false,
      recovery: { action: 'abort' },
    }
  }

  let capturedCode: unknown
  try { capturedCode = ownDataProperty(error as TasError, 'code') } catch { return projectTasError(undefined) }
  if (typeof capturedCode !== 'string' || !Object.hasOwn(errorBehaviors, capturedCode)) return projectTasError(undefined)
  const code = capturedCode as TasErrorCode
  const behavior = errorBehaviors[code]
  return {
    code,
    category: behavior.category,
    message: behavior.message,
    retryable: behavior.retryable,
    recovery: { action: behavior.action },
  }
}

/**
 * Builds native MCP results for one TAS instance. Inputs contain only public
 * context and immutable resolution metadata; resolved configuration is excluded.
 */
export function createTasResultBuilder(
  instance: TasPublicInstance,
  resolution?: ResolutionContext,
): {
  success(data: PublicJsonValue): CallToolResult
  toolError(error: unknown): CallToolResult
} {
  const publicResolution = projectResolutionContext(resolution)
  const publicInstance = createContext(instance, undefined).instance
  return {
    success(data: PublicJsonValue): CallToolResult {
      return {
        content: [{ type: 'text', text: 'Tool completed.' }],
        structuredContent: { context: createContext(publicInstance, publicResolution), data: clonePublicJsonValue(data) },
      }
    },
    toolError(error: unknown): CallToolResult {
      const publicError = projectTasError(error)
      return {
        content: [{ type: 'text', text: publicError.message }],
        isError: true,
        structuredContent: { context: createContext(publicInstance, publicResolution), error: publicError },
      }
    },
  }
}
