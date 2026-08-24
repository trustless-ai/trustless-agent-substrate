import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it, vi } from 'vitest'
import { keccak256 } from 'viem'

import {
  createSolcCompiler,
  type SolidityCompilation,
  type SolidityCompiler,
  type SolidityStandardJsonInput,
} from '../../../src/clients/workflow/solcCompiler.js'
import { TasError } from '../../../src/core/errors.js'
import type { ResolvedWorkflowSource } from '../../../src/core/workflow/sourceResolver.js'
import {
  createWorkflowSourceVerifier,
  type WorkflowCodeReader,
} from '../../../src/core/workflow/sourceVerifier.js'

const fixtureRoot = fileURLToPath(new URL('../../fixtures/workflow/runtime/', import.meta.url))
const directRuntime = readFileSync(resolve(fixtureRoot, 'direct.hex'), 'utf8').trim() as `0x${string}`
const proxyRuntime = readFileSync(resolve(fixtureRoot, 'proxy.hex'), 'utf8').trim() as `0x${string}`
const metadataMismatchRuntime = readFileSync(resolve(fixtureRoot, 'metadata-mismatch.hex'), 'utf8').trim() as `0x${string}`
const bzzr1Runtime = readFileSync(resolve(fixtureRoot, 'bzzr1.hex'), 'utf8').trim() as `0x${string}`
const metadataText = '{"compiler":"fixture"}'
const blockHash = `0x${'ab'.repeat(32)}` as const
const workflowAddress = '0x1000000000000000000000000000000000000001'

function resolved(overrides: Partial<ResolvedWorkflowSource> = {}): ResolvedWorkflowSource {
  const sourceBytes = new TextEncoder().encode('pragma solidity 0.8.30; contract Workflow {}')
  const metadataBytes = new TextEncoder().encode(`${metadataText}\n`)
  return {
    chainId: '31337',
    blockSelector: { kind: 'block_hash', blockHash },
    profile: { blockNumber: '42', blockHash, version: '7' },
    workflowAddress,
    repository: {
      provider: 'github',
      locator: 'https://github.com/example/tawg',
      owner: 'example',
      repository: 'tawg',
      profile: { blockNumber: '42', blockHash, version: '7' },
      charter: { commit: 'a'.repeat(40), path: 'charter/' },
    },
    commit: 'b'.repeat(40),
    sourcePath: 'contracts/Workflow.sol',
    metadataPath: 'contracts/Workflow.metadata.json',
    contractName: 'Workflow',
    compiler: { version: '0.8.30+commit.73712a01' },
    metadata: {
      compiler: { version: '0.8.30+commit.73712a01' },
      language: 'Solidity',
      output: {},
      settings: {},
      sources: {},
      version: 1,
    },
    settings: {
      compilationTarget: { 'contracts/Workflow.sol': 'Workflow' },
      evmVersion: 'cancun',
      metadata: { bytecodeHash: 'ipfs' },
      optimizer: { enabled: true, runs: 200 },
    },
    metadataFile: {
      bytes: metadataBytes,
      text: `${metadataText}\n`,
      sha256: 'metadata-sha256',
    },
    source: {
      path: 'contracts/Workflow.sol',
      bytes: sourceBytes,
      text: new TextDecoder().decode(sourceBytes),
      keccak256: `0x${'12'.repeat(32)}`,
      expectedKeccak256: `0x${'12'.repeat(32)}`,
    },
    sourceUnits: {
      'contracts/Workflow.sol': {
        path: 'contracts/Workflow.sol',
        bytes: sourceBytes,
        text: new TextDecoder().decode(sourceBytes),
        keccak256: `0x${'12'.repeat(32)}`,
        expectedKeccak256: `0x${'12'.repeat(32)}`,
      },
    },
    ...overrides,
  } as ResolvedWorkflowSource
}

function compilation(runtime: string, overrides: Record<string, unknown> = {}) {
  return {
    compilerVersion: '0.8.30+commit.73712a01',
    output: {
      contracts: {
        'contracts/Workflow.sol': {
          Workflow: {
            metadata: metadataText,
            evm: {
              deployedBytecode: {
                object: runtime.startsWith('0x') ? runtime.slice(2) : runtime,
                immutableReferences: {},
                linkReferences: {},
                ...overrides,
              },
            },
          },
        },
      },
    },
  }
}

function harness(
  runtime = directRuntime,
  compiled = compilation(directRuntime),
) {
  const readCode = vi.fn(async () => runtime as `0x${string}` | undefined)
  const codeReader: WorkflowCodeReader = { readCode }
  const compile = vi.fn(async (_input: SolidityStandardJsonInput, _version: string) => compiled)
  const compiler: SolidityCompiler = { compile }
  const verifier = createWorkflowSourceVerifier({ codeReader, compiler })
  return { verifier, readCode, compile }
}

function expectTasCode(operation: Promise<unknown>, code: string): Promise<void> {
  return expect(operation).rejects.toSatisfy(
    (error: unknown) => error instanceof TasError && error.code === code,
  )
}

describe('Workflow source verifier', () => {
  it('identifies canonical deployed runtime without invoking the compiler', async () => {
    const app = harness()

    const identity = await app.verifier.identifyDeployment({
      chainId: '31337',
      workflowAddress,
      blockHash,
    })

    expect(identity.deployedCodeHash).toMatch(/^0x[0-9a-f]{64}$/)
    expect(Object.isFrozen(identity)).toBe(true)
    expect(app.compile).not.toHaveBeenCalled()
    expect(app.readCode).toHaveBeenCalledOnce()
  })

  it('binds every immutable Workflow material component into the fingerprint but not Profile movement', async () => {
    const app = harness()
    const baselineSource = resolved()
    const baseline = await app.verifier.identify(baselineSource)
    const extraBytes = new TextEncoder().encode('library Extra {}')
    const extraUnit = {
      path: 'contracts/Extra.sol',
      bytes: extraBytes,
      text: 'library Extra {}',
      keccak256: `0x${'34'.repeat(32)}` as const,
      expectedKeccak256: `0x${'34'.repeat(32)}` as const,
    }
    const mutations: readonly ResolvedWorkflowSource[] = [
      resolved({ chainId: '1' }),
      resolved({ workflowAddress: '0x2000000000000000000000000000000000000002' }),
      resolved({ repository: { ...baselineSource.repository, locator: 'https://github.com/example/other', repository: 'other' } }),
      resolved({ commit: 'c'.repeat(40) }),
      resolved({ sourcePath: 'contracts/Other.sol' }),
      resolved({ metadataPath: 'contracts/Other.metadata.json' }),
      resolved({ sourceUnits: { ...baselineSource.sourceUnits, [extraUnit.path]: extraUnit } }),
      resolved({ metadataFile: { ...baselineSource.metadataFile, sha256: 'changed-metadata-sha256' } }),
      resolved({ compiler: { version: '0.8.29+commit.ab55807c' } }),
      resolved({ settings: { ...baselineSource.settings, optimizer: { enabled: true, runs: 999 } } }),
    ]

    for (const mutation of mutations) {
      await expect(app.verifier.identify(mutation)).resolves.not.toMatchObject({ fingerprint: baseline.fingerprint })
    }
    const movedBlockHash = `0x${'cd'.repeat(32)}` as const
    await expect(app.verifier.identify(resolved({
      blockSelector: { kind: 'block_hash', blockHash: movedBlockHash },
      profile: { blockNumber: '43', blockHash: movedBlockHash, version: '8' },
      repository: {
        ...baselineSource.repository,
        profile: { blockNumber: '43', blockHash: movedBlockHash, version: '8' },
      },
    }))).resolves.toMatchObject({ fingerprint: baseline.fingerprint })
    expect(app.compile).not.toHaveBeenCalled()
  })

  it('compiles only committed source units and verifies the exact block runtime deterministically', async () => {
    const app = harness()

    const first = await app.verifier.verify(resolved())
    const second = await app.verifier.verify(resolved())

    expect(first).toMatchObject({
      valid: true,
      reason: 'verified',
      compiler: { version: '0.8.30+commit.73712a01' },
      context: {
        chainId: '31337',
        blockNumber: '42',
        blockHash,
        profileVersion: '7',
        workflowAddress,
      },
    })
    expect(first.fingerprint).toMatch(/^sha256:[0-9a-f]{64}$/)
    expect(first.deployedCodeHash).toMatch(/^0x[0-9a-f]{64}$/)
    expect(second.fingerprint).toBe(first.fingerprint)
    expect(app.readCode).toHaveBeenNthCalledWith(1, {
      chainId: '31337',
      address: workflowAddress,
      blockHash,
      requireCanonical: true,
      signal: undefined,
    })
    expect(app.compile).toHaveBeenCalledWith({
      language: 'Solidity',
      sources: {
        'contracts/Workflow.sol': { content: 'pragma solidity 0.8.30; contract Workflow {}' },
      },
      settings: {
        evmVersion: 'cancun',
        metadata: { bytecodeHash: 'ipfs' },
        optimizer: { enabled: true, runs: 200 },
        outputSelection: {
          'contracts/Workflow.sol': {
            Workflow: [
              'metadata',
              'evm.deployedBytecode.object',
              'evm.deployedBytecode.linkReferences',
              'evm.deployedBytecode.immutableReferences',
            ],
          },
        },
      },
    }, '0.8.30+commit.73712a01', undefined)
  })

  it('returns a negative comparison when compiler metadata differs from the committed exact text', async () => {
    const compiled = compilation(directRuntime)
    compiled.output.contracts['contracts/Workflow.sol']!.Workflow!.metadata = '{"compiler":"other"}'
    const app = harness(directRuntime, compiled)

    await expect(app.verifier.verify(resolved())).resolves.toMatchObject({
      valid: false,
      reason: 'metadata_mismatch',
    })
  })

  it('returns a negative comparison for retrieved source bytes that differ from compiler metadata', async () => {
    const selected = resolved()
    const unit = selected.sourceUnits['contracts/Workflow.sol']!
    const app = harness()

    await expect(app.verifier.verify(resolved({
      sourceUnits: {
        'contracts/Workflow.sol': { ...unit, expectedKeccak256: `0x${'34'.repeat(32)}` },
      },
    }))).resolves.toMatchObject({ valid: false, reason: 'source_mismatch' })
    expect(app.compile).not.toHaveBeenCalled()
  })

  it('rejects internally inconsistent exact-block resolution context before reading runtime code', async () => {
    const app = harness()

    await expectTasCode(app.verifier.verify(resolved({
      blockSelector: { kind: 'block_hash', blockHash: `0x${'cd'.repeat(32)}` },
    })), 'WORKFLOW_COMPILE_FAILED')
    expect(app.readCode).not.toHaveBeenCalled()
  })

  it('requires the compiled and deployed Solidity metadata trailers to match before comparing executable code', async () => {
    const app = harness(metadataMismatchRuntime)

    await expect(app.verifier.verify(resolved())).resolves.toMatchObject({
      valid: false,
      reason: 'metadata_mismatch',
    })
  })

  it('returns a negative comparison for any ordinary executable byte mismatch', async () => {
    const deployed = directRuntime.replace('0x6001', '0x6002') as `0x${string}`
    const app = harness(deployed)

    await expect(app.verifier.verify(resolved())).resolves.toMatchObject({
      valid: false,
      reason: 'runtime_mismatch',
    })
  })

  it('masks only compiler-reported immutable ranges and requires repeated values for one ID to agree', async () => {
    const trailer = directRuntime.slice(2 + 20)
    const compiledRuntime = `0x7f${'00'.repeat(32)}507f${'00'.repeat(32)}50${trailer}`
    const deployedRuntime = `0x7f${'33'.repeat(32)}507f${'33'.repeat(32)}50${trailer}` as `0x${string}`
    const inconsistentRuntime = `0x7f${'33'.repeat(32)}507f${'44'.repeat(32)}50${trailer}` as `0x${string}`
    const compiled = compilation(compiledRuntime, {
      immutableReferences: { '17': [{ start: 1, length: 32 }, { start: 35, length: 32 }] },
    })

    await expect(harness(deployedRuntime, compiled).verifier.verify(resolved())).resolves.toMatchObject({ valid: true })
    await expect(harness(inconsistentRuntime, compiled).verifier.verify(resolved())).resolves.toMatchObject({
      valid: false,
      reason: 'runtime_mismatch',
    })
  })

  it('rejects unresolved external-library links under the v0.1 no-delegation policy', async () => {
    const trailer = directRuntime.slice(2 + 20)
    const compiledRuntime = `0x73${'00'.repeat(20)}50${trailer}`
    const deployedRuntime = `0x73${'55'.repeat(20)}50${trailer}` as `0x${string}`
    const compiled = compilation(compiledRuntime, {
      linkReferences: { 'vendor/Library.sol': { Library: [{ start: 1, length: 20 }] } },
    })

    await expectTasCode(
      harness(deployedRuntime, compiled).verifier.verify(resolved()),
      'WORKFLOW_DEPLOYMENT_UNSUPPORTED',
    )
  })

  it.each([
    ['out-of-bounds', { immutableReferences: { '17': [{ start: 10_000, length: 32 }] } }],
    ['overlapping', {
      immutableReferences: { '17': [{ start: 1, length: 2 }] },
      linkReferences: { 'vendor/Library.sol': { Library: [{ start: 2, length: 2 }] } },
    }],
  ])('rejects %s compiler reference ranges as malformed compiler output', async (_label, references) => {
    const app = harness(directRuntime, compilation(directRuntime, references))

    await expectTasCode(app.verifier.verify(resolved()), 'WORKFLOW_COMPILE_FAILED')
  })

  it('does not hide malformed compiler references behind an ordinary metadata mismatch', async () => {
    const compiled = compilation(directRuntime, {
      immutableReferences: { '17': [{ start: 10_000, length: 32 }] },
    })
    compiled.output.contracts['contracts/Workflow.sol']!.Workflow!.metadata = '{"compiler":"other"}'

    await expectTasCode(
      harness(directRuntime, compiled).verifier.verify(resolved()),
      'WORKFLOW_COMPILE_FAILED',
    )
  })

  it('rejects deployed code without a retained supported Solidity metadata commitment', async () => {
    const app = harness('0x600160005260206000f3')

    await expectTasCode(app.verifier.verify(resolved()), 'WORKFLOW_DEPLOYMENT_UNSUPPORTED')
  })

  it('accepts the retained Solidity bzzr1 commitment form', async () => {
    const app = harness(bzzr1Runtime, compilation(bzzr1Runtime))

    await expect(app.verifier.verify(resolved())).resolves.toMatchObject({ valid: true, reason: 'verified' })
  })

  it('rejects executable DELEGATECALL or CALLCODE while skipping bytes contained in PUSH data', async () => {
    await expectTasCode(harness(proxyRuntime, compilation(proxyRuntime)).verifier.verify(resolved()), 'WORKFLOW_DEPLOYMENT_UNSUPPORTED')
    const callcodeRuntime = proxyRuntime.replace('f4a264', 'f2a264') as `0x${string}`
    await expectTasCode(
      harness(callcodeRuntime, compilation(callcodeRuntime)).verifier.verify(resolved()),
      'WORKFLOW_DEPLOYMENT_UNSUPPORTED',
    )

    const pushDataRuntime = directRuntime.replace('0x6001', '0x60f4') as `0x${string}`
    await expect(harness(pushDataRuntime, compilation(pushDataRuntime)).verifier.verify(resolved()))
      .resolves.toMatchObject({ valid: true })
  })

  it('fails closed when exact-block deployed code is absent', async () => {
    const app = harness()
    app.readCode.mockResolvedValueOnce(undefined)

    await expectTasCode(app.verifier.verify(resolved()), 'WORKFLOW_SOURCE_UNAVAILABLE')
    expect(app.compile).not.toHaveBeenCalled()
  })

  it('runs the bundled exact compiler through metadata, trailer, runtime, and fingerprint verification', { timeout: 30_000 }, async () => {
    const sourceText = 'pragma solidity 0.8.30; contract Workflow { function value() external pure returns (uint256) { return 7; } }'
    const sourceBytes = new TextEncoder().encode(sourceText)
    const compiler = createSolcCompiler({ timeoutMs: 20_000 })
    const compileSettings = {
      evmVersion: 'cancun',
      metadata: { bytecodeHash: 'ipfs' },
      optimizer: { enabled: true, runs: 200 },
      outputSelection: {
        'contracts/Workflow.sol': {
          Workflow: [
            'metadata',
            'evm.deployedBytecode.object',
            'evm.deployedBytecode.linkReferences',
            'evm.deployedBytecode.immutableReferences',
          ],
        },
      },
    }
    const first: SolidityCompilation = await compiler.compile({
      language: 'Solidity',
      sources: { 'contracts/Workflow.sol': { content: sourceText } },
      settings: compileSettings,
    }, '0.8.30+commit.73712a01')
    const contract = first.output.contracts?.['contracts/Workflow.sol']?.Workflow
    const rawMetadata = contract?.metadata
    const runtimeObject = contract?.evm?.deployedBytecode?.object
    expect(rawMetadata).toBeTypeOf('string')
    expect(runtimeObject).toMatch(/^[0-9a-f]+$/)
    const metadataBytes = new TextEncoder().encode(`${rawMetadata}\n`)
    const metadata = JSON.parse(rawMetadata!) as ResolvedWorkflowSource['metadata']
    const selected = resolved({
      settings: metadata.settings,
      metadata,
      metadataFile: {
        bytes: metadataBytes,
        text: `${rawMetadata}\n`,
        sha256: createHash('sha256').update(metadataBytes).digest('hex'),
      },
      source: {
        path: 'contracts/Workflow.sol',
        bytes: sourceBytes,
        text: sourceText,
        keccak256: keccak256(sourceBytes),
        expectedKeccak256: keccak256(sourceBytes),
      },
      sourceUnits: {
        'contracts/Workflow.sol': {
          path: 'contracts/Workflow.sol',
          bytes: sourceBytes,
          text: sourceText,
          keccak256: keccak256(sourceBytes),
          expectedKeccak256: keccak256(sourceBytes),
        },
      },
    })
    const codeReader: WorkflowCodeReader = {
      readCode: async () => `0x${runtimeObject}`,
    }
    const verifier = createWorkflowSourceVerifier({ codeReader, compiler })

    await expect(verifier.verify(selected)).resolves.toMatchObject({
      valid: true,
      reason: 'verified',
      compiler: { version: '0.8.30+commit.73712a01' },
    })
  })
})
