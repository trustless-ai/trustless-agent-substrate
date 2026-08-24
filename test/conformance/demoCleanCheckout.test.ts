import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import {
  copyFileSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { keccak256 } from 'viem'
import { describe, expect, it } from 'vitest'

const repositoryRoot = fileURLToPath(new URL('../../', import.meta.url))
const sourceDemoRoot = resolve(repositoryRoot, 'tawg/demo')
const omittedDirectories = new Set(['out', 'cache', 'broadcast'])

interface WorkflowArtifact {
  readonly rawMetadata: string
  readonly deployedBytecode: { readonly object: string }
}

function copyReviewedTree(source: string, destination: string): void {
  const sourceStat = lstatSync(source)
  if (sourceStat.isSymbolicLink()) throw new Error(`symlink rejected: ${source}`)
  if (!sourceStat.isDirectory()) throw new Error(`copy root is not a directory: ${source}`)
  mkdirSync(destination, { recursive: true })

  for (const entry of readdirSync(source)) {
    const sourcePath = resolve(source, entry)
    const destinationPath = resolve(destination, entry)
    const stat = lstatSync(sourcePath)
    if (stat.isSymbolicLink()) throw new Error(`symlink rejected: ${sourcePath}`)
    if (omittedDirectories.has(entry) && stat.isDirectory()) continue
    if (stat.isDirectory()) {
      copyReviewedTree(sourcePath, destinationPath)
    } else if (stat.isFile()) {
      copyFileSync(sourcePath, destinationPath)
    } else {
      throw new Error(`non-regular file rejected: ${sourcePath}`)
    }
  }
}

function validateInputs(demoRoot: string): void {
  const provenance = JSON.parse(
    readFileSync(resolve(demoRoot, 'vendor/agent-ercs/PROVENANCE.json'), 'utf8'),
  ) as { readonly sources: readonly { readonly path: string; readonly sha256: string }[] }
  const metadata = JSON.parse(readFileSync(resolve(demoRoot, 'contracts/Workflow.metadata.json'), 'utf8')) as {
    readonly sources: Readonly<Record<string, { readonly keccak256: string }>>
  }

  for (const source of provenance.sources) {
    const path = resolve(demoRoot, 'vendor/agent-ercs', source.path)
    const bytes = readFileSync(path)
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(source.sha256)
  }
  for (const [sourceUnit, record] of Object.entries(metadata.sources)) {
    expect(sourceUnit).not.toMatch(/^(?:\/|[A-Za-z]:\\)|\.\.\//)
    expect(keccak256(new Uint8Array(readFileSync(resolve(demoRoot, sourceUnit))))).toBe(record.keccak256)
  }
}

function expectRuntimeTrailer(runtimeBytecode: string, rawMetadata: string): void {
  const bytecode = runtimeBytecode.startsWith('0x') ? runtimeBytecode.slice(2) : runtimeBytecode
  const encodedLength = Number.parseInt(bytecode.slice(-4), 16)
  const trailer = bytecode.slice(-(encodedLength + 2) * 2)
  expect(rawMetadata.length).toBeGreaterThan(0)
  expect(trailer).toMatch(/^a2646970667358221220[0-9a-f]{64}64736f6c634300081e0033$/)
}

describe('Demo TAWG clean-copy conformance', () => {
  it('builds and tests using only the copied standalone Demo tree', () => {
    const temporaryRoot = mkdtempSync(resolve(tmpdir(), 'tawg-demo-clean-'))
    const cleanDemoRoot = resolve(temporaryRoot, 'demo')

    try {
      copyReviewedTree(sourceDemoRoot, cleanDemoRoot)
      expect(readdirSync(temporaryRoot)).toEqual(['demo'])
      expect(basename(cleanDemoRoot)).toBe('demo')
      expect(() => lstatSync(resolve(cleanDemoRoot, 'node_modules'))).toThrow()
      for (const omitted of omittedDirectories) {
        expect(() => lstatSync(resolve(cleanDemoRoot, omitted))).toThrow()
      }

      validateInputs(cleanDemoRoot)
      execFileSync('forge', ['test', '--root', cleanDemoRoot, '--offline', '--force'], {
        encoding: 'utf8',
        timeout: 180_000,
        stdio: 'pipe',
      })

      const artifact = JSON.parse(
        readFileSync(resolve(cleanDemoRoot, 'out/Workflow.sol/Workflow.json'), 'utf8'),
      ) as WorkflowArtifact
      expect(readFileSync(resolve(cleanDemoRoot, 'contracts/Workflow.metadata.json'), 'utf8'))
        .toBe(`${artifact.rawMetadata}\n`)
      expectRuntimeTrailer(artifact.deployedBytecode.object, artifact.rawMetadata)
    } finally {
      rmSync(temporaryRoot, { recursive: true, force: true })
    }
  }, 200_000)
})
