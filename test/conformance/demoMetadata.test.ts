import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { keccak256 } from 'viem'
import { describe, expect, it } from 'vitest'

const repositoryRoot = fileURLToPath(new URL('../../', import.meta.url))
const demoRoot = resolve(repositoryRoot, 'tawg/demo')
const artifactPath = resolve(demoRoot, 'out/Workflow.sol/Workflow.json')
const metadataPath = resolve(demoRoot, 'contracts/Workflow.metadata.json')

interface CompilerMetadata {
  readonly compiler: { readonly version: string }
  readonly language: string
  readonly output: {
    readonly abi: readonly unknown[]
    readonly devdoc: Readonly<Record<string, unknown>>
    readonly userdoc: Readonly<Record<string, unknown>>
  }
  readonly settings: {
    readonly compilationTarget: Readonly<Record<string, string>>
    readonly evmVersion: string
    readonly libraries: Readonly<Record<string, unknown>>
    readonly metadata: Readonly<Record<string, unknown>>
    readonly optimizer: Readonly<Record<string, unknown>>
    readonly remappings: readonly string[]
  }
  readonly sources: Readonly<Record<string, { readonly keccak256: string; readonly urls: readonly string[] }>>
  readonly version: number
}

interface WorkflowArtifact {
  readonly abi: readonly unknown[]
  readonly rawMetadata: string
  readonly deployedBytecode: { readonly object: string }
}

function sourceKeccak(path: string): string {
  return keccak256(new Uint8Array(readFileSync(path)))
}

function expectIpfsMetadataTrailer(runtimeBytecode: string, rawMetadata: string): void {
  const bytecode = runtimeBytecode.startsWith('0x') ? runtimeBytecode.slice(2) : runtimeBytecode
  const encodedLength = Number.parseInt(bytecode.slice(-4), 16)
  const trailer = bytecode.slice(-(encodedLength + 2) * 2)
  expect(rawMetadata.length).toBeGreaterThan(0)
  expect(trailer).toMatch(/^a2646970667358221220[0-9a-f]{64}64736f6c634300081e0033$/)
}

describe('Demo Workflow compiler metadata', () => {
  it('pins every compiler setting that can affect reproducibility', () => {
    const foundry = readFileSync(resolve(demoRoot, 'foundry.toml'), 'utf8')

    expect(foundry).toMatch(/solc_version\s*=\s*"0\.8\.30"/)
    expect(foundry).toMatch(/auto_detect_solc\s*=\s*false/)
    expect(foundry).toMatch(/optimizer\s*=\s*true/)
    expect(foundry).toMatch(/optimizer_runs\s*=\s*200/)
    expect(foundry).toMatch(/evm_version\s*=\s*"cancun"/)
    expect(foundry).toMatch(/via_ir\s*=\s*false/)
    expect(foundry).toMatch(/bytecode_hash\s*=\s*"ipfs"/)
    expect(foundry).toMatch(/cbor_metadata\s*=\s*true/)
    expect(foundry).toMatch(/ffi\s*=\s*false/)
    expect(foundry).toMatch(/auto_detect_remappings\s*=\s*false/)
    expect(foundry).not.toMatch(/(?:\.\.\/|\/Users\/|[A-Za-z]:\\)/)
    expect(readFileSync(resolve(demoRoot, 'remappings.txt'), 'utf8'))
      .toBe('@agent-ercs/=vendor/agent-ercs/contracts/\n')
  })

  it('exactly matches a fresh compiler artifact and every committed source byte', () => {
    execFileSync('forge', ['build', '--root', demoRoot, '--offline', '--force'], {
      encoding: 'utf8',
      timeout: 120_000,
      stdio: 'pipe',
    })

    const artifact = JSON.parse(readFileSync(artifactPath, 'utf8')) as WorkflowArtifact
    const checkedMetadata = readFileSync(metadataPath, 'utf8')
    expect(checkedMetadata).toBe(`${artifact.rawMetadata}\n`)

    const metadata = JSON.parse(artifact.rawMetadata) as CompilerMetadata
    expect(metadata.compiler).toEqual({ version: '0.8.30+commit.73712a01' })
    expect(metadata.language).toBe('Solidity')
    expect(metadata.version).toBe(1)
    expect(metadata.settings).toEqual({
      compilationTarget: { 'contracts/Workflow.sol': 'Workflow' },
      evmVersion: 'cancun',
      libraries: {},
      metadata: { bytecodeHash: 'ipfs' },
      optimizer: { enabled: true, runs: 200 },
      remappings: [':@agent-ercs/=vendor/agent-ercs/contracts/'],
    })
    expect(Object.keys(metadata.output).sort()).toEqual(['abi', 'devdoc', 'userdoc'])
    expect(metadata.output.abi).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'run', type: 'function' }),
      expect.objectContaining({ name: 'onAgentReply', type: 'function' }),
      expect.objectContaining({ name: 'onAgentProve', type: 'function' }),
    ]))
    expect(artifact.abi).toEqual(expect.arrayContaining(metadata.output.abi))
    expect(metadata.output.devdoc).toBeTypeOf('object')
    expect(metadata.output.userdoc).toBeTypeOf('object')

    const expectedSources = [
      'contracts/Workflow.sol',
      'vendor/agent-ercs/contracts/execution/ERC8301/IAgentWorkflow.sol',
      'vendor/agent-ercs/contracts/verify/ERC8274/IAgentVerifier.sol',
    ]
    expect(Object.keys(metadata.sources).sort()).toEqual(expectedSources)
    for (const sourceUnit of expectedSources) {
      expect(sourceUnit).not.toMatch(/^(?:\/|[A-Za-z]:\\)|\.\.\//)
      expect(metadata.sources[sourceUnit]!.keccak256).toBe(sourceKeccak(resolve(demoRoot, sourceUnit)))
    }

    const provenance = JSON.parse(
      readFileSync(resolve(demoRoot, 'vendor/agent-ercs/PROVENANCE.json'), 'utf8'),
    ) as { readonly sources: readonly { readonly path: string; readonly sha256: string }[] }
    for (const source of provenance.sources) {
      const bytes = readFileSync(resolve(demoRoot, 'vendor/agent-ercs', source.path))
      expect(createHash('sha256').update(bytes).digest('hex')).toBe(source.sha256)
      expect(metadata.sources[`vendor/agent-ercs/${source.path}`]!.keccak256)
        .toBe(keccak256(new Uint8Array(bytes)))
    }

    expectIpfsMetadataTrailer(artifact.deployedBytecode.object, artifact.rawMetadata)
  })
})
