import type { RepositorySource } from '../repository/types.js'
import type {
  DaCapabilities,
  DaCredential,
  GitDaPath,
  GitDaReference,
} from './types.js'

export interface DaClientContent {
  readonly bytes: Uint8Array
  readonly mediaType?: string
}

export interface DaClientOptions {
  readonly signal?: AbortSignal
}

/** Provider boundary. Repository selection and credentials are operation-scoped inputs. */
export interface DaClient {
  capabilities(): DaCapabilities | Promise<DaCapabilities>

  get(
    source: RepositorySource,
    ref: GitDaReference,
    credential?: DaCredential,
    options?: DaClientOptions,
  ): Promise<DaClientContent>

  put(
    source: RepositorySource,
    path: GitDaPath,
    bytes: Uint8Array,
    mediaType?: string,
    credential?: DaCredential,
    options?: DaClientOptions,
  ): Promise<GitDaReference>
}
