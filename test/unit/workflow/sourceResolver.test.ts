import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import type { RepositoryContentClient, RepositoryFile, RepositoryReadOptions } from '../../../src/core/repository/client.js'
import type { RepositoryCredential, RepositorySource } from '../../../src/core/repository/types.js'
import { createWorkflowSourceResolver } from '../../../src/core/workflow/sourceResolver.js'
import type { ChainSelector } from '../../../src/core/profile/types.js'
import { TasError } from '../../../src/core/errors.js'

const fixtureRoot = fileURLToPath(new URL('../../fixtures/workflow/repository/', import.meta.url))
const repositoryUrl = 'https://github.com/trustless-ai/demo-tawg'
const charterCommit = 'a'.repeat(40)
const workflowCommit = 'b'.repeat(40)
const blockHash = `0x${'c'.repeat(64)}` as const
const workflowAddress = '0x4000000000000000000000000000000000000004'

function sourceData(overrides: Readonly<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    repository: repositoryUrl,
    commit: workflowCommit,
    sourcePath: 'contracts/Workflow.sol',
    metadataPath: 'contracts/Workflow.metadata.json',
    ...overrides,
  }
}

function resolvedProfile(source: unknown = sourceData()) {
  return {
    data: {
      version: '7',
      governance: '0x2000000000000000000000000000000000000002',
      charter: { repository: repositoryUrl, commit: charterCommit, path: 'charter/' },
      agents: { identity_registry: '0x3000000000000000000000000000000000000003', agent_ids: [] },
      data: {},
      workflow: { address: workflowAddress, data: { source } },
    },
    resolution: { chain: { block_number: '42', block_hash: blockHash }, profile: { version: '7' } },
  }
}

class ProfilePort {
  readonly binding = { chainId: '31337', tawgAddress: '0x1000000000000000000000000000000000000001' as const }
  readonly selectors: ChainSelector[] = []
  readonly options: Array<RepositoryReadOptions | undefined> = []
  result: ReturnType<typeof resolvedProfile> = resolvedProfile()

  async get(selector: ChainSelector, options?: RepositoryReadOptions) {
    this.selectors.push(selector)
    this.options.push(options)
    return this.result
  }
}

interface ReadCall {
  readonly source: RepositorySource
  readonly commit: string
  readonly path: string
  readonly credential?: RepositoryCredential
  readonly options?: RepositoryReadOptions
}

class FixtureContentClient implements Pick<RepositoryContentClient, 'readFile'> {
  readonly calls: ReadCall[] = []
  readonly overrides = new Map<string, RepositoryFile | Error>()

  async readFile(
    source: RepositorySource,
    commit: string,
    path: string,
    credential?: RepositoryCredential,
    options?: RepositoryReadOptions,
  ): Promise<RepositoryFile> {
    this.calls.push({ source, commit, path, credential, options })
    const override = this.overrides.get(path)
    if (override instanceof Error) throw override
    if (override !== undefined) return override
    return { path, commit, bytes: new Uint8Array(readFileSync(resolve(fixtureRoot, path))) }
  }
}

function harness() {
  const profile = new ProfilePort()
  const content = new FixtureContentClient()
  const resolver = createWorkflowSourceResolver({ profileResolver: profile, contentClient: content })
  return { content, profile, resolver }
}

function expectCode(code: string) {
  return (error: unknown): boolean => error instanceof TasError && error.code === code
}

describe('Workflow source resolver', () => {
  it('discovers an immutable Profile-selected descriptor without repository reads and propagates cancellation', async () => {
    const app = harness()
    const selector = { kind: 'safe' } as const
    const controller = new AbortController()

    const result = await app.resolver.discover(selector, { signal: controller.signal })

    expect(app.profile.selectors).toEqual([selector])
    expect(app.profile.options).toEqual([{ signal: controller.signal }])
    expect(app.content.calls).toEqual([])
    expect(result).toEqual({
      chainId: '31337',
      blockSelector: { kind: 'block_hash', blockHash },
      profile: { blockNumber: '42', blockHash, version: '7' },
      workflowAddress,
      repository: {
        provider: 'github',
        locator: repositoryUrl,
        owner: 'trustless-ai',
        repository: 'demo-tawg',
        profile: { blockNumber: '42', blockHash, version: '7' },
        charter: { commit: charterCommit, path: 'charter/' },
      },
      commit: workflowCommit,
      sourcePath: 'contracts/Workflow.sol',
      metadataPath: 'contracts/Workflow.metadata.json',
    })
    expect(Object.isFrozen(result)).toBe(true)
    expect(Object.isFrozen(result.blockSelector)).toBe(true)
    expect(Object.isFrozen(result.profile)).toBe(true)
    expect(Object.isFrozen(result.repository)).toBe(true)
    expect(Object.isFrozen(result.repository.profile)).toBe(true)
    expect(Object.isFrozen(result.repository.charter)).toBe(true)
  })

  it('materializes an issued descriptor without a second Profile read', async () => {
    const app = harness()
    const controller = new AbortController()
    const options = { signal: controller.signal }
    const credential = { type: 'inline', secret: 'private-repository-token' } as const

    const descriptor = await app.resolver.discover({ kind: 'safe' }, options)
    const result = await app.resolver.materialize(descriptor, credential, options)

    expect(app.profile.selectors).toEqual([{ kind: 'safe' }])
    expect(app.profile.options).toEqual([options])
    expect(app.content.calls.map(({ path }) => path)).toEqual([
      'contracts/Workflow.metadata.json',
      'contracts/Workflow.sol',
      'vendor/Dependency.sol',
    ])
    expect(app.content.calls.every((call) => call.credential === credential)).toBe(true)
    expect(app.content.calls.every((call) => call.options === options)).toBe(true)
    expect(result.commit).toBe(descriptor.commit)
    expect(result.source.path).toBe(descriptor.sourcePath)
  })

  it('rejects foreign and copied descriptors before repository reads', async () => {
    const issuer = harness()
    const foreign = harness()
    const descriptor = await issuer.resolver.discover({ kind: 'latest' })

    await expect(foreign.resolver.materialize(descriptor)).rejects.toSatisfy(
      expectCode('WORKFLOW_METADATA_INVALID'),
    )
    await expect(issuer.resolver.materialize({ ...descriptor })).rejects.toSatisfy(
      expectCode('WORKFLOW_METADATA_INVALID'),
    )

    expect(foreign.content.calls).toEqual([])
    expect(issuer.content.calls).toEqual([])
  })

  it('pins one Profile read and resolves exact metadata-named bytes from the Workflow commit', async () => {
    const app = harness()
    const selector = { kind: 'safe' } as const
    const credential = { type: 'inline', secret: 'private-repository-token' } as const

    const result = await app.resolver.resolve(selector, credential)

    expect(app.profile.selectors).toEqual([selector])
    expect(app.profile.options).toEqual([undefined])
    expect(result).toMatchObject({
      chainId: '31337',
      blockSelector: { kind: 'block_hash', blockHash },
      profile: { blockNumber: '42', blockHash, version: '7' },
      workflowAddress,
      repository: {
        provider: 'github',
        locator: repositoryUrl,
        owner: 'trustless-ai',
        repository: 'demo-tawg',
        charter: { commit: charterCommit, path: 'charter/' },
      },
      commit: workflowCommit,
      sourcePath: 'contracts/Workflow.sol',
      metadataPath: 'contracts/Workflow.metadata.json',
      contractName: 'Workflow',
      compiler: { version: '0.8.30+commit.73712a01' },
      settings: {
        compilationTarget: { 'contracts/Workflow.sol': 'Workflow' },
        evmVersion: 'cancun',
        metadata: { bytecodeHash: 'ipfs' },
        optimizer: { enabled: true, runs: 200 },
      },
      source: {
        path: 'contracts/Workflow.sol',
        text: 'pragma solidity 0.8.30;\nimport "../vendor/Dependency.sol";\ncontract Workflow is Dependency {}\n',
        keccak256: '0xfa1df5c62f654a6402fe6f9155a22bd805703d1e29fb8b9df9686df9b51f0d5b',
      },
      sourceUnits: {
        'vendor/Dependency.sol': {
          path: 'vendor/Dependency.sol',
          text: 'pragma solidity 0.8.30;\nabstract contract Dependency {}\n',
          keccak256: '0xe7b25a81829042973d3834a9f6e25b0ace5fcc299e6c9043a6640cda9b35e03f',
        },
      },
    })
    expect(result.source.bytes).toEqual(new Uint8Array(readFileSync(resolve(fixtureRoot, 'contracts/Workflow.sol'))))
    expect(result.metadataFile.bytes).toEqual(new Uint8Array(readFileSync(resolve(fixtureRoot, 'contracts/Workflow.metadata.json'))))
    expect(app.content.calls.map(({ commit, path }) => ({ commit, path }))).toEqual([
      { commit: workflowCommit, path: 'contracts/Workflow.metadata.json' },
      { commit: workflowCommit, path: 'contracts/Workflow.sol' },
      { commit: workflowCommit, path: 'vendor/Dependency.sol' },
    ])
    expect(app.content.calls.every((call) => call.credential === credential)).toBe(true)
    expect(JSON.stringify(result)).not.toContain(credential.secret)
    expect(Object.isFrozen(result)).toBe(true)
    expect(Object.isFrozen(result.repository)).toBe(true)
    expect(Object.isFrozen(result.metadata)).toBe(true)
    expect(Object.isFrozen(result.sourceUnits)).toBe(true)
    const exposedSourceBytes = result.source.bytes
    exposedSourceBytes[0] = 0
    expect(result.source.bytes[0]).toBe(readFileSync(resolve(fixtureRoot, 'contracts/Workflow.sol'))[0])
    const exposedMetadataBytes = result.metadataFile.bytes
    exposedMetadataBytes[0] = 0
    expect(result.metadataFile.bytes[0]).toBe('{'.charCodeAt(0))
  })

  it('rejects repository, commit, and path authority violations before repository reads', async () => {
    for (const source of [
      sourceData({ repository: 'https://github.com/trustless-ai/other' }),
      sourceData({ repository: `${repositoryUrl}/` }),
      sourceData({ commit: 'B'.repeat(40) }),
      sourceData({ commit: 'b'.repeat(39) }),
      sourceData({ sourcePath: '../Workflow.sol' }),
      sourceData({ sourcePath: '/contracts/Workflow.sol' }),
      sourceData({ sourcePath: 'contracts\\Workflow.sol' }),
      sourceData({ sourcePath: 'contracts//Workflow.sol' }),
      sourceData({ sourcePath: 'contracts/./Workflow.sol' }),
      sourceData({ metadataPath: 'contracts/../Workflow.metadata.json' }),
      sourceData({ metadataPath: 'contracts/Workflow.metadata.json\0suffix' }),
    ]) {
      const app = harness()
      app.profile.result = resolvedProfile(source)

      await expect(app.resolver.resolve({ kind: 'latest' })).rejects.toSatisfy(expectCode('WORKFLOW_METADATA_INVALID'))
      expect(app.content.calls).toEqual([])
    }
  })

  it('rejects malformed metadata, missing source units, and provider mismatches', async () => {
    const invalidMetadata = Buffer.from('{"compiler":{}}', 'utf8')
    const cases: Array<(app: ReturnType<typeof harness>) => void> = [
      (app) => app.content.overrides.set('contracts/Workflow.metadata.json', {
        path: 'contracts/Workflow.metadata.json', commit: workflowCommit, bytes: invalidMetadata,
      }),
      (app) => app.content.overrides.set('vendor/Dependency.sol', new Error('missing')),
      (app) => app.content.overrides.set('contracts/Workflow.sol', {
        path: 'different.sol', commit: workflowCommit, bytes: new Uint8Array(),
      }),
      (app) => app.content.overrides.set('contracts/Workflow.sol', {
        path: 'contracts/Workflow.sol', commit: 'd'.repeat(40), bytes: new Uint8Array(),
      }),
    ]

    for (const configure of cases) {
      const app = harness()
      configure(app)
      await expect(app.resolver.resolve({ kind: 'block_hash', blockHash })).rejects.toSatisfy(
        expectCode(app.content.overrides.get('vendor/Dependency.sol') instanceof Error
          ? 'WORKFLOW_SOURCE_UNAVAILABLE'
          : 'WORKFLOW_METADATA_INVALID'),
      )
    }
  })

  it('preserves a retrieved source digest mismatch as verifier input instead of a tool error', async () => {
    const app = harness()
    app.content.overrides.set('contracts/Workflow.sol', {
      path: 'contracts/Workflow.sol', commit: workflowCommit, bytes: Buffer.from('contract Changed {}\n'),
    })

    const result = await app.resolver.resolve({ kind: 'block_hash', blockHash })

    expect(result.source.keccak256).not.toBe(result.source.expectedKeccak256)
    expect(result.source.expectedKeccak256).toBe(
      '0xfa1df5c62f654a6402fe6f9155a22bd805703d1e29fb8b9df9686df9b51f0d5b',
    )
  })

  it('propagates caller cancellation to Profile and Repository reads and stops the source loop', async () => {
    const app = harness()
    const controller = new AbortController()
    const originalRead = app.content.readFile.bind(app.content)
    app.content.readFile = async (...arguments_) => {
      const file = await originalRead(...arguments_)
      if (arguments_[2] === 'contracts/Workflow.sol') controller.abort()
      return file
    }

    await expect(app.resolver.resolve(
      { kind: 'latest' },
      undefined,
      { signal: controller.signal },
    )).rejects.toMatchObject({ name: 'AbortError' })
    expect(app.profile.options).toEqual([{ signal: controller.signal }])
    expect(app.content.calls.map(({ path }) => path)).toEqual([
      'contracts/Workflow.metadata.json',
      'contracts/Workflow.sol',
    ])
    expect(app.content.calls.every(({ options }) => options?.signal === controller.signal)).toBe(true)
  })

  it('preserves a Solidity UTF-8 BOM in text while hashing the exact source bytes', async () => {
    const app = harness()
    const original = readFileSync(resolve(fixtureRoot, 'contracts/Workflow.sol'))
    const bytes = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), original])
    const metadata = readFileSync(resolve(fixtureRoot, 'contracts/Workflow.metadata.json'), 'utf8')
      .replace(
        '0xfa1df5c62f654a6402fe6f9155a22bd805703d1e29fb8b9df9686df9b51f0d5b',
        '0x2ea5f077c547ca738e5f8cdd1e8a4bd550f980dc94fe987ffeef4d9f2ce1c0f4',
      )
    app.content.overrides.set('contracts/Workflow.metadata.json', {
      path: 'contracts/Workflow.metadata.json', commit: workflowCommit, bytes: Buffer.from(metadata, 'utf8'),
    })
    app.content.overrides.set('contracts/Workflow.sol', {
      path: 'contracts/Workflow.sol', commit: workflowCommit, bytes,
    })

    const result = await app.resolver.resolve({ kind: 'latest' })

    expect(result.source.bytes).toEqual(new Uint8Array(bytes))
    expect(result.source.text.startsWith('\uFEFFpragma solidity')).toBe(true)
    expect(result.source.keccak256).toBe('0x2ea5f077c547ca738e5f8cdd1e8a4bd550f980dc94fe987ffeef4d9f2ce1c0f4')
  })

  it('returns a typed metadata error for a null compilation target', async () => {
    const app = harness()
    const metadata = JSON.parse(readFileSync(resolve(fixtureRoot, 'contracts/Workflow.metadata.json'), 'utf8')) as {
      settings: { compilationTarget: unknown }
    }
    metadata.settings.compilationTarget = null
    app.content.overrides.set('contracts/Workflow.metadata.json', {
      path: 'contracts/Workflow.metadata.json',
      commit: workflowCommit,
      bytes: Buffer.from(JSON.stringify(metadata), 'utf8'),
    })

    await expect(app.resolver.resolve({ kind: 'latest' })).rejects.toSatisfy(expectCode('WORKFLOW_METADATA_INVALID'))
  })

  it('requires compiler output and a retained CBOR metadata commitment', async () => {
    const checked = JSON.parse(readFileSync(resolve(fixtureRoot, 'contracts/Workflow.metadata.json'), 'utf8')) as {
      output?: unknown
      settings: { metadata: { appendCBOR?: boolean } }
    }
    const withoutOutput = structuredClone(checked)
    delete withoutOutput.output
    const withoutCbor = structuredClone(checked)
    withoutCbor.settings.metadata.appendCBOR = false

    for (const metadata of [withoutOutput, withoutCbor]) {
      const app = harness()
      app.content.overrides.set('contracts/Workflow.metadata.json', {
        path: 'contracts/Workflow.metadata.json',
        commit: workflowCommit,
        bytes: Buffer.from(JSON.stringify(metadata), 'utf8'),
      })

      await expect(app.resolver.resolve({ kind: 'latest' })).rejects.toSatisfy(expectCode('WORKFLOW_METADATA_INVALID'))
    }
  })

  it('rejects a compiler source closure larger than the fixed four MiB total budget', async () => {
    const app = harness()
    const bytes = Buffer.alloc(1_048_576, 0x61)
    const digest = '0xf5f3e54ad3d703f8e9edfd7ce79341b1d9286a692fa6c13ff13ee6ea94dbf97d'
    const paths = [
      'contracts/Workflow.sol',
      'vendor/First.sol',
      'vendor/Second.sol',
      'vendor/Third.sol',
    ]
    const metadata = JSON.parse(readFileSync(resolve(fixtureRoot, 'contracts/Workflow.metadata.json'), 'utf8')) as {
      sources: Record<string, { keccak256: string }>
    }
    metadata.sources = Object.fromEntries(paths.map((path) => [path, { keccak256: digest }]))
    app.content.overrides.set('contracts/Workflow.metadata.json', {
      path: 'contracts/Workflow.metadata.json',
      commit: workflowCommit,
      bytes: Buffer.from(JSON.stringify(metadata), 'utf8'),
    })
    for (const path of paths) {
      app.content.overrides.set(path, { path, commit: workflowCommit, bytes })
    }

    await expect(app.resolver.resolve({ kind: 'latest' })).rejects.toSatisfy(expectCode('WORKFLOW_METADATA_INVALID'))
  })
})
