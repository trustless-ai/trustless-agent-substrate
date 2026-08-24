import { Buffer } from 'node:buffer'

import { z } from 'zod'

import type { DaClient, DaClientOptions } from '../../core/da/client.js'
import type { GitDaPath, GitDaReference } from '../../core/da/types.js'
import { TasError } from '../../core/errors.js'
import type { RepositoryCredential, RepositorySource } from '../../core/repository/types.js'
import type { GitHubRequest } from '../repository/githubRequest.js'

const apiHeaders = { 'x-github-api-version': '2026-03-10' } as const
const fullCommit = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/
const maxInlineBytes = 1_048_576
const maxPathCharacters = 4_096
const maxBase64Characters = Math.ceil(maxInlineBytes / 3) * 4
const maxBase64TransportCharacters = maxBase64Characters + Math.ceil(maxBase64Characters / 60) * 2

const repositorySchema = z.object({
  default_branch: z.string().min(1).max(1_024),
}).passthrough()
const gitReferenceSchema = z.object({
  object: z.object({ sha: z.string().regex(fullCommit) }).passthrough(),
}).passthrough()
const gitCommitSchema = z.object({
  tree: z.object({ sha: z.string().regex(fullCommit) }).passthrough(),
}).passthrough()
const gitObjectSchema = z.object({ sha: z.string().regex(fullCommit) }).passthrough()
const fileSchema = z.object({
  type: z.literal('file'),
  encoding: z.literal('base64'),
  content: z.string().max(maxBase64TransportCharacters),
  size: z.number().int().min(0).max(maxInlineBytes),
  path: z.string().min(1).max(maxPathCharacters),
}).passthrough()

function ownData(value: unknown, key: string): unknown {
  if (value === null || typeof value !== 'object') return undefined
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    return descriptor && 'value' in descriptor ? descriptor.value : undefined
  } catch {
    return undefined
  }
}

function responseHeaders(error: unknown): Readonly<Record<string, unknown>> {
  const response = ownData(error, 'response')
  const headers = ownData(response, 'headers')
  return headers !== null && typeof headers === 'object' && !Array.isArray(headers)
    ? headers as Readonly<Record<string, unknown>>
    : {}
}

function fail(code: 'DA_REFERENCE_INVALID' | 'DA_PATH_INVALID' | 'DA_FETCH_FAILED' | 'DA_WRITE_FAILED' | 'DA_UNAVAILABLE' | 'DA_CONTENT_TOO_LARGE'): never {
  const messages = {
    DA_REFERENCE_INVALID: 'The DA reference is invalid.',
    DA_PATH_INVALID: 'The Git DA path is invalid.',
    DA_FETCH_FAILED: 'The DA content could not be read.',
    DA_WRITE_FAILED: 'The DA content could not be written.',
    DA_UNAVAILABLE: 'The configured DA backend is unavailable.',
    DA_CONTENT_TOO_LARGE: 'The DA content exceeds the inline size limit.',
  } as const
  throw new TasError(code, messages[code])
}

function mapRequestError(error: unknown, operation: 'read' | 'write', refUpdateStarted: boolean): never {
  const status = ownData(error, 'status')
  if (status === 401) throw new TasError('CREDENTIAL_REQUIRED', 'A valid operation credential is required.')
  const headers = responseHeaders(error)
  if (
    status === 429
    || (status === 403 && (
      ownData(headers, 'x-ratelimit-remaining') === '0'
      || ownData(headers, 'retry-after') !== undefined
    ))
  ) return fail('DA_UNAVAILABLE')
  if (status === 403 && operation === 'write') {
    throw new TasError('AUTHORIZATION_DENIED', 'The credential is not authorized for this operation.')
  }
  if (operation === 'read') return fail('DA_FETCH_FAILED')
  if (refUpdateStarted && (status === 409 || status === 422)) {
    throw new TasError('RESOLUTION_CONFLICT', 'The selected resolution changed during the operation.')
  }
  if (refUpdateStarted && status !== 409 && status !== 422) {
    throw new TasError(
      'OPERATION_OUTCOME_UNKNOWN',
      'The external operation outcome is unknown.',
    )
  }
  return fail('DA_WRITE_FAILED')
}

function commonParameters(source: RepositorySource): Record<string, unknown> {
  return { owner: source.owner, repo: source.repository }
}

function requestParameters(
  source: RepositorySource,
  values: Readonly<Record<string, unknown>> = {},
): Record<string, unknown> {
  return { ...commonParameters(source), ...values, headers: apiHeaders }
}

function isCanonicalDataPath(path: string): boolean {
  if (path.length < 6 || path.length > maxPathCharacters || !path.startsWith('data/')) return false
  if (path.endsWith('/') || path.includes('\\') || /[\u0000-\u001f\u007f]/.test(path)) return false
  const parts = path.split('/')
  return parts[0] === 'data'
    && parts.slice(1).every((part) => part.length > 0 && part !== '.' && part !== '..')
}

function assertPath(path: string): asserts path is GitDaPath {
  if (!isCanonicalDataPath(path)) return fail('DA_PATH_INVALID')
}

function assertReference(ref: GitDaReference): void {
  if (ref.type !== 'git' || !fullCommit.test(ref.commit)) return fail('DA_REFERENCE_INVALID')
  if (!isCanonicalDataPath(ref.path)) return fail('DA_REFERENCE_INVALID')
}

function assertSource(source: RepositorySource): void {
  if (source.provider !== 'github') return fail('DA_UNAVAILABLE')
}

function isCanonicalGitRefName(value: string): boolean {
  const components = value.split('/')
  return value.length > 0
    && value.length <= 1_024
    && value !== '@'
    && !value.startsWith('/')
    && !value.endsWith('/')
    && !value.endsWith('.')
    && !value.includes('..')
    && !value.includes('//')
    && !value.includes('@{')
    && !/[\u0000-\u0020\u007f~^:?*\[\\]/.test(value)
    && components.every((component) => !component.startsWith('.') && !component.endsWith('.lock'))
}

function decodeProviderFile(value: unknown, expectedPath: string): Uint8Array {
  const declaredSize = ownData(value, 'size')
  const encoded = ownData(value, 'content')
  if (
    (typeof declaredSize === 'number' && declaredSize > maxInlineBytes)
    || (typeof encoded === 'string' && encoded.length > maxBase64TransportCharacters)
  ) return fail('DA_CONTENT_TOO_LARGE')
  const parsed = fileSchema.safeParse(value)
  if (!parsed.success || parsed.data.path !== expectedPath) return fail('DA_FETCH_FAILED')
  const normalized = parsed.data.content.replace(/\r?\n/g, '')
  if (
    normalized.length > maxBase64Characters
    || normalized.length % 4 !== 0
    || /[^A-Za-z0-9+/=]/.test(normalized)
  ) return fail('DA_FETCH_FAILED')
  let bytes: Buffer
  try {
    bytes = Buffer.from(normalized, 'base64')
  } catch {
    return fail('DA_FETCH_FAILED')
  }
  if (
    bytes.toString('base64') !== normalized
    || bytes.byteLength !== parsed.data.size
    || bytes.byteLength > maxInlineBytes
  ) return fail('DA_FETCH_FAILED')
  return Uint8Array.from(bytes)
}

/** Creates the production GitHub-backed implementation of the Git DA Client boundary. */
export function createGitDaClient(request: GitHubRequest): DaClient {
  async function call<T>(
    route: string,
    parameters: Readonly<Record<string, unknown>>,
    credential: RepositoryCredential | undefined,
    operation: 'read' | 'write',
    refUpdateStarted = false,
    options?: DaClientOptions,
  ): Promise<{ data: T; headers: Readonly<Record<string, string | undefined>> }> {
    try {
      options?.signal?.throwIfAborted()
      const requestParameters = options?.signal === undefined
        ? parameters
        : { ...parameters, request: { signal: options.signal } }
      return await request.request<T>(route, requestParameters, credential)
    } catch (error) {
      if (options?.signal?.aborted) {
        if (refUpdateStarted) {
          throw new TasError('OPERATION_OUTCOME_UNKNOWN', 'The external operation outcome is unknown.')
        }
        throw error
      }
      return mapRequestError(error, operation, refUpdateStarted)
    }
  }

  async function get(
    source: RepositorySource,
    ref: GitDaReference,
    credential?: RepositoryCredential,
    options?: DaClientOptions,
  ): Promise<{ readonly bytes: Uint8Array }> {
    assertSource(source)
    assertReference(ref)
    const response = await call<unknown>(
      'GET /repos/{owner}/{repo}/contents/{path}',
      requestParameters(source, { path: ref.path, ref: ref.commit }),
      credential,
      'read',
      false,
      options,
    )
    return { bytes: decodeProviderFile(response.data, ref.path) }
  }

  async function put(
    source: RepositorySource,
    path: string,
    bytes: Uint8Array,
    _mediaType: string | undefined,
    credential?: RepositoryCredential,
    options?: DaClientOptions,
  ): Promise<GitDaReference> {
    assertSource(source)
    assertPath(path)
    if (bytes.byteLength > maxInlineBytes) return fail('DA_CONTENT_TOO_LARGE')
    const content = Buffer.from(bytes).toString('base64')

    const repository = repositorySchema.safeParse((await call<unknown>(
      'GET /repos/{owner}/{repo}', requestParameters(source), credential, 'write', false, options,
    )).data)
    if (!repository.success || !isCanonicalGitRefName(repository.data.default_branch)) return fail('DA_WRITE_FAILED')
    const branch = repository.data.default_branch

    const reference = gitReferenceSchema.safeParse((await call<unknown>(
      'GET /repos/{owner}/{repo}/git/ref/{ref}',
      requestParameters(source, { ref: `heads/${branch}` }), credential, 'write', false, options,
    )).data)
    if (!reference.success) return fail('DA_WRITE_FAILED')
    const observedHead = reference.data.object.sha

    const baseCommit = gitCommitSchema.safeParse((await call<unknown>(
      'GET /repos/{owner}/{repo}/git/commits/{commit_sha}',
      requestParameters(source, { commit_sha: observedHead }), credential, 'write', false, options,
    )).data)
    if (!baseCommit.success) return fail('DA_WRITE_FAILED')

    const createdBlob = gitObjectSchema.safeParse((await call<unknown>(
      'POST /repos/{owner}/{repo}/git/blobs',
      requestParameters(source, { content, encoding: 'base64' }), credential, 'write', false, options,
    )).data)
    if (!createdBlob.success) return fail('DA_WRITE_FAILED')

    const createdTree = gitObjectSchema.safeParse((await call<unknown>(
      'POST /repos/{owner}/{repo}/git/trees',
      requestParameters(source, {
        base_tree: baseCommit.data.tree.sha,
        tree: [{ path, mode: '100644', type: 'blob', sha: createdBlob.data.sha }],
      }),
      credential,
      'write',
      false,
      options,
    )).data)
    if (!createdTree.success) return fail('DA_WRITE_FAILED')

    const createdCommit = gitObjectSchema.safeParse((await call<unknown>(
      'POST /repos/{owner}/{repo}/git/commits',
      requestParameters(source, {
        message: `TAS DA: write ${path}`,
        tree: createdTree.data.sha,
        parents: [observedHead],
      }),
      credential,
      'write',
      false,
      options,
    )).data)
    if (!createdCommit.success) return fail('DA_WRITE_FAILED')

    const updatedReference = gitReferenceSchema.safeParse((await call<unknown>(
      'PATCH /repos/{owner}/{repo}/git/refs/{ref}',
      requestParameters(source, {
        ref: `heads/${branch}`,
        sha: createdCommit.data.sha,
        force: false,
      }),
      credential,
      'write',
      true,
      options,
    )).data)
    if (!updatedReference.success || updatedReference.data.object.sha !== createdCommit.data.sha) {
      throw new TasError('OPERATION_OUTCOME_UNKNOWN', 'The external operation outcome is unknown.')
    }
    return { type: 'git', commit: createdCommit.data.sha, path }
  }

  return {
    capabilities: () => ({
      backend: 'git',
      reference_types: ['git'],
      read: true,
      write: true,
      content_encodings: ['utf8', 'base64'],
      max_inline_bytes: maxInlineBytes,
    }),
    get,
    put,
  }
}
