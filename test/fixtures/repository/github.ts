import type { GitHubRequest } from '../../../src/clients/repository/githubRequest.js'
import type { RepositoryCredential } from '../../../src/core/repository/types.js'

export interface RecordedGitHubCall {
  readonly route: string
  readonly parameters: Readonly<Record<string, unknown>>
  readonly authenticated: boolean
}

type QueuedResult =
  | { readonly kind: 'response'; readonly data: unknown; readonly headers: Readonly<Record<string, string | undefined>> }
  | { readonly kind: 'error'; readonly error: unknown }

export class RecordingGitHubRequest implements GitHubRequest {
  readonly calls: RecordedGitHubCall[] = []
  readonly #queue: QueuedResult[] = []

  enqueue(data: unknown, headers: Readonly<Record<string, string | undefined>> = {}): void {
    this.#queue.push({ kind: 'response', data, headers })
  }

  enqueueError(error: unknown): void {
    this.#queue.push({ kind: 'error', error })
  }

  async request<T>(
    route: string,
    parameters: Readonly<Record<string, unknown>>,
    credential?: RepositoryCredential,
  ): Promise<{ data: T; headers: Readonly<Record<string, string | undefined>> }> {
    this.calls.push({ route, parameters, authenticated: credential !== undefined })
    const queued = this.#queue.shift()
    if (!queued) throw new Error('Unexpected GitHub request')
    if (queued.kind === 'error') throw queued.error
    return { data: queued.data as T, headers: queued.headers }
  }

  assertDone(): void {
    if (this.#queue.length !== 0) throw new Error(`${this.#queue.length} GitHub response(s) were not consumed`)
  }
}
