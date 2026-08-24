import { request as octokitRequest } from '@octokit/request'

import type { RepositoryCredential } from '../../core/repository/types.js'

const maxGitHubResponseBytes = 2_097_152

export interface GitHubRequest {
  request<T>(
    route: string,
    parameters: Readonly<Record<string, unknown>>,
    credential?: RepositoryCredential,
  ): Promise<{ data: T; headers: Readonly<Record<string, string | undefined>> }>
}

interface OctokitRequestLike {
  <T>(
    route: string,
    parameters?: Readonly<Record<string, unknown>>,
  ): Promise<{ data: T; headers: Readonly<Record<string, string | undefined>> }>
  defaults(defaults: Readonly<Record<string, unknown>>): OctokitRequestLike
}

const requestDefaults = {
  headers: {
    accept: 'application/vnd.github+json',
    'user-agent': '@trustless-ai/tas/0.1',
    'x-github-api-version': '2026-03-10',
  },
} as const

function responseTooLarge(): Error {
  return new Error('GitHub response exceeded the TAS byte limit.')
}

function createBoundedFetch(fetchImplementation: typeof fetch): typeof fetch {
  return async (input, init) => {
    const response = await fetchImplementation(input, init)
    const declaredLength = response.headers.get('content-length')
    if (declaredLength !== null) {
      if (!/^(?:0|[1-9]\d*)$/.test(declaredLength)) throw responseTooLarge()
      const declaredBytes = Number(declaredLength)
      if (!Number.isSafeInteger(declaredBytes) || declaredBytes > maxGitHubResponseBytes) {
        await response.body?.cancel().catch(() => undefined)
        throw responseTooLarge()
      }
    }
    if (response.body === null) return response

    const reader = response.body.getReader()
    const chunks: Uint8Array[] = []
    let totalBytes = 0
    while (true) {
      const chunk = await reader.read()
      if (chunk.done) break
      totalBytes += chunk.value.byteLength
      if (totalBytes > maxGitHubResponseBytes) {
        await reader.cancel().catch(() => undefined)
        throw responseTooLarge()
      }
      chunks.push(chunk.value)
    }

    const body = new Uint8Array(totalBytes)
    let offset = 0
    for (const chunk of chunks) {
      body.set(chunk, offset)
      offset += chunk.byteLength
    }
    return new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    })
  }
}

export function createGitHubRequest(
  baseRequest: OctokitRequestLike = octokitRequest as unknown as OctokitRequestLike,
  fetchImplementation: typeof fetch = globalThis.fetch,
): GitHubRequest {
  const unauthenticated = baseRequest.defaults({
    ...requestDefaults,
    request: { fetch: createBoundedFetch(fetchImplementation) },
  })
  return {
    async request<T>(
      route: string,
      parameters: Readonly<Record<string, unknown>>,
      credential?: RepositoryCredential,
    ) {
      const existingHeaders = parameters.headers
      const headers = existingHeaders !== null && typeof existingHeaders === 'object' && !Array.isArray(existingHeaders)
        ? existingHeaders as Readonly<Record<string, unknown>>
        : {}
      const callParameters = credential === undefined
        ? parameters
        : { ...parameters, headers: { ...headers, authorization: `Bearer ${credential.secret}` } }
      const response = await unauthenticated<T>(route, callParameters)
      return { data: response.data, headers: response.headers }
    },
  }
}
