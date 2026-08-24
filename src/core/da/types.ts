import type { ChainSelector } from '../profile/types.js'
import type { RepositoryCredential, RepositorySource } from '../repository/types.js'

export const DA_MAX_INLINE_BYTES = 1_048_576

export type DaCredential = RepositoryCredential

export type FullGitCommit = string
export type GitDaPath = `data/${string}`

export interface GitDaReference {
  readonly type: 'git'
  readonly commit: FullGitCommit
  readonly path: GitDaPath
}

export interface IpfsDaReference {
  readonly type: 'ipfs'
  readonly cid: string
}

export type DaReference = GitDaReference | IpfsDaReference
export type DaContentEncoding = 'utf8' | 'base64'

export interface DaContent {
  readonly encoding: DaContentEncoding
  readonly value: string
  readonly media_type?: string
}

/** Reads are projected as base64 so arbitrary immutable bytes remain lossless. */
export interface DaRetrievedContent {
  readonly encoding: 'base64'
  readonly value: string
  readonly media_type?: string
}

export interface DaCapabilities {
  readonly backend: 'git'
  readonly reference_types: readonly ['git']
  readonly read: true
  readonly write: true
  readonly content_encodings: readonly ['utf8', 'base64']
  readonly max_inline_bytes: number
}

export interface DaGetInput {
  readonly ref: DaReference
  readonly selector?: ChainSelector
  readonly credential?: DaCredential
  /** Internal operation cancellation; it is not part of the MCP input schema. */
  readonly signal?: AbortSignal
}

export interface DaGetResult {
  /** Internal resolution material; the MCP data projection omits this field. */
  readonly source: RepositorySource
  readonly ref: GitDaReference
  readonly content: DaRetrievedContent
  readonly size_bytes: number
}

export interface GitDaDestination {
  readonly path: string
}

export interface DaPutInput {
  readonly content: DaContent
  readonly destination?: GitDaDestination
  readonly selector?: ChainSelector
  readonly credential?: DaCredential
  /** Internal operation cancellation; it is not part of the MCP input schema. */
  readonly signal?: AbortSignal
}

export interface DaPutResult {
  /** Internal resolution material; the MCP data projection omits this field. */
  readonly source: RepositorySource
  readonly ref: GitDaReference
  readonly size_bytes: number
}
