import type {
  ActivityWindow,
  RepositoryCommit,
  RepositoryCredential,
  RepositoryIssue,
  RepositoryPage,
  RepositoryPullRequest,
  RepositorySource,
} from './types.js'

export interface RepositoryActivityClient {
  listIssues(
    source: RepositorySource,
    window: ActivityWindow,
    credential?: RepositoryCredential,
  ): Promise<RepositoryPage<RepositoryIssue>>

  listPullRequests(
    source: RepositorySource,
    window: ActivityWindow,
    credential?: RepositoryCredential,
  ): Promise<RepositoryPage<RepositoryPullRequest>>

  listCommits(
    source: RepositorySource,
    window: ActivityWindow,
    credential?: RepositoryCredential,
  ): Promise<RepositoryPage<RepositoryCommit>>
}

export interface RepositoryFile {
  readonly path: string
  readonly commit: string
  readonly bytes: Uint8Array
}

export interface RepositoryReadOptions {
  readonly signal?: AbortSignal
}

export interface RepositoryContentClient {
  resolveDefaultHead(
    source: RepositorySource,
    credential?: RepositoryCredential,
  ): Promise<string>

  readFile(
    source: RepositorySource,
    commit: string,
    path: string,
    credential?: RepositoryCredential,
    options?: RepositoryReadOptions,
  ): Promise<RepositoryFile>
}

export type RepositoryClient = RepositoryActivityClient & RepositoryContentClient
