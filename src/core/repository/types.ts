export interface RepositorySource {
  readonly provider: 'github'
  readonly locator: `https://github.com/${string}/${string}`
  readonly owner: string
  readonly repository: string
  readonly profile: {
    readonly blockNumber: string
    readonly blockHash: `0x${string}`
    readonly version: string
  }
  readonly charter: {
    readonly commit: string
    readonly path: 'charter/'
  }
}

export interface RepositoryCredential {
  readonly type: 'inline'
  readonly secret: string
}

export interface RepositoryIssue {
  readonly id: string
  readonly number: string
  readonly title: string
  readonly state: 'open' | 'closed'
  readonly author: string | null
  readonly createdAt: string
  readonly updatedAt: string
  readonly url: string
}

export type RepositoryPullRequest = RepositoryIssue

export interface RepositoryCommit {
  readonly commit: string
  readonly message: string
  readonly authorName: string | null
  readonly authorLogin: string | null
  readonly committedAt: string
  readonly url: string
}

export interface ActivityWindow {
  readonly since: string
  readonly observedAt: string
  readonly limit: number
  readonly providerPage: number
  readonly providerOffset: number
}

export interface RepositoryPage<T> {
  readonly items: readonly T[]
  readonly nextPosition?: {
    readonly providerPage: number
    readonly providerOffset: number
  }
}
