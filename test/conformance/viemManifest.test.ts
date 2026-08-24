import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { parseDependencyManifest } from '../../src/mcp/manifest/types.js'
import { analyzeViemActions } from '../../tools/manifest/analyzeViem.js'
import {
  checkViemManifestArtifacts,
  checkViemArtifactDigestSource,
  checkViemGeneratedOutputs,
  computeViemEntrypointDigest,
  generateViemArtifactDigestSource,
  generateViemManifestArtifacts,
  viemArtifactDigestSourceRelativePath,
  viemManifestFileNames,
  writeViemGeneratedOutputs,
  writeViemManifestArtifacts,
} from '../../tools/manifest/generate.js'
import { projectViemActionSchemas } from '../../tools/manifest/schemaEncoder.js'

const repositoryRoot = resolve(import.meta.dirname, '../..')
const temporaryRoots: string[] = []

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'tas-viem-manifest-'))
  temporaryRoots.push(directory)
  return directory
}

function bytes(directory: string, fileName: string): Buffer {
  return readFileSync(join(directory, fileName))
}

function parsed(directory: string, fileName: string): unknown {
  return JSON.parse(bytes(directory, fileName).toString('utf8')) as unknown
}

function allRecords(value: unknown): readonly Record<string, unknown>[] {
  if (value === null || typeof value !== 'object') return []
  if (Array.isArray(value)) {
    const records: Record<string, unknown>[] = []
    for (let index = 0; index < value.length; index += 1) records.push(...allRecords(value[index]))
    return records
  }
  const record = value as Record<string, unknown>
  const records: Record<string, unknown>[] = [record]
  for (const entry of Object.values(record)) records.push(...allRecords(entry))
  return records
}

afterEach(() => {
  for (const directory of temporaryRoots.splice(0)) rmSync(directory, { recursive: true, force: true })
})

describe('reviewed viem Manifest generation', () => {
  it('generates byte-identical canonical artifacts with complete reviewed accounting', { timeout: 30_000 }, () => {
    const first = temporaryDirectory()
    const second = temporaryDirectory()

    writeViemManifestArtifacts({ cwd: repositoryRoot, outputDirectory: first })
    writeViemManifestArtifacts({ cwd: repositoryRoot, outputDirectory: second })

    for (const fileName of viemManifestFileNames) {
      expect(bytes(first, fileName)).toEqual(bytes(second, fileName))
      const contents = bytes(first, fileName).toString('utf8')
      expect(contents.endsWith('\n')).toBe(false)
      expect(JSON.stringify(JSON.parse(contents))).toBe(contents)
    }

    const publicManifest = parseDependencyManifest(parsed(first, 'viem-public.v1.json'))
    const walletManifest = parseDependencyManifest(parsed(first, 'viem-wallet.v1.json'))
    const report = parsed(first, 'viem-report.v1.json') as {
      readonly source: { readonly package: string; readonly version: string; readonly package_integrity: string }
      readonly trusted_dependencies: readonly unknown[]
      readonly reviewed_entrypoints: readonly {
        readonly entrypoint: '.'
        readonly exported_types_path: string
        readonly exported_types_sha256: `sha256:${string}`
      }[]
      readonly reviewed_declarations: readonly {
        readonly package_name: string
        readonly package_version: string
        readonly package_relative_path: string
        readonly sha256: `sha256:${string}`
      }[]
      readonly reviewed_packages: readonly {
        readonly package_name: string
        readonly package_version: string
        readonly package_integrity: string
        readonly package_tree_sha256: `sha256:${string}`
        readonly package_file_count: number
        readonly package_total_bytes: number
      }[]
      readonly entries: readonly {
        readonly source_profile: 'viem-public' | 'viem-wallet'
        readonly source_name: string
        readonly result: 'included' | 'excluded'
        readonly tool_name?: string
        readonly reason_code?: string
        readonly operation?: { readonly effect: string; readonly completion: string }
      }[]
      readonly failures: readonly unknown[]
    }
    const analysis = analyzeViemActions({ cwd: repositoryRoot, project: projectViemActionSchemas })

    expect(publicManifest.source).toMatchObject({
      package: 'viem',
      version: analysis.packageVersion,
      package_integrity: analysis.packageIntegrity,
    })
    expect(walletManifest.source).toEqual(publicManifest.source)
    expect(report.source).toMatchObject({
      package: 'viem',
      version: analysis.packageVersion,
      package_integrity: analysis.packageIntegrity,
    })
    expect(report.trusted_dependencies).toEqual(analysis.trustedDependencies)
    expect(report.reviewed_declarations).toEqual(analysis.reviewedDeclarations.map((declaration) => ({
      package_name: declaration.packageName,
      package_version: declaration.packageVersion,
      package_relative_path: declaration.packageRelativePath,
      sha256: declaration.sha256,
    })))
    expect(report.reviewed_packages.map(({ package_tree_sha256: _tree, package_file_count: _count, package_total_bytes: _bytes, ...identity }) => identity))
      .toEqual(analysis.reviewedPackages.map((package_) => ({
      package_name: package_.packageName,
      package_version: package_.packageVersion,
      package_integrity: package_.packageIntegrity,
      })))
    expect(report.reviewed_packages.every(({ package_tree_sha256, package_file_count, package_total_bytes }) =>
      /^sha256:[0-9a-f]{64}$/.test(package_tree_sha256)
      && Number.isSafeInteger(package_file_count) && package_file_count > 0
      && Number.isSafeInteger(package_total_bytes) && package_total_bytes > 0)).toBe(true)
    expect(report.reviewed_packages.reduce((total, package_) => total + package_.package_file_count, 0))
      .toBeGreaterThan(12_000)
    expect(report.reviewed_packages.reduce((total, package_) => total + package_.package_total_bytes, 0))
      .toBeGreaterThan(38_000_000)
    expect(report.failures).toEqual([])

    const digestInput = {
      packageVersion: analysis.packageVersion,
      packageIntegrity: analysis.packageIntegrity,
      reviewedEntrypoints: report.reviewed_entrypoints,
      trustedDependencies: analysis.trustedDependencies,
      reviewedDeclarations: report.reviewed_declarations,
      reviewedPackages: report.reviewed_packages,
    }
    expect(publicManifest.source.entrypoint_digest).toBe(computeViemEntrypointDigest(digestInput))
    const deepIndex = report.reviewed_declarations.findIndex(({ package_name, package_relative_path }) =>
      package_name === 'ox' && package_relative_path !== '_types/index.d.ts')
    expect(deepIndex).toBeGreaterThanOrEqual(0)
    const tamperedDeclarations = report.reviewed_declarations.map((declaration, index) => index === deepIndex
      ? { ...declaration, sha256: `sha256:${'0'.repeat(64)}` as const }
      : declaration)
    expect(computeViemEntrypointDigest({ ...digestInput, reviewedDeclarations: tamperedDeclarations }))
      .not.toBe(publicManifest.source.entrypoint_digest)
    const tamperedPackages = report.reviewed_packages.map((package_, index) => index === 0
      ? { ...package_, package_integrity: `sha512-${Buffer.alloc(64, 1).toString('base64')}` }
      : package_)
    expect(computeViemEntrypointDigest({ ...digestInput, reviewedPackages: tamperedPackages }))
      .not.toBe(publicManifest.source.entrypoint_digest)
    const tamperedTrees = report.reviewed_packages.map((package_, index) => index === 0
      ? { ...package_, package_tree_sha256: `sha256:${'0'.repeat(64)}` as const }
      : package_)
    expect(computeViemEntrypointDigest({ ...digestInput, reviewedPackages: tamperedTrees }))
      .not.toBe(publicManifest.source.entrypoint_digest)

    const expectedClassifications = [...analysis.included, ...analysis.excluded]
      .map(({ sourceProfile, sourceName }) => `${sourceProfile}:${sourceName}`).toSorted()
    const reportedClassifications = report.entries
      .map(({ source_profile, source_name }) => `${source_profile}:${source_name}`)
    expect(reportedClassifications).toEqual(expectedClassifications)
    expect(new Set(reportedClassifications).size).toBe(reportedClassifications.length)

    const tools = [...publicManifest.tools, ...walletManifest.tools]
    expect(tools.map(({ name }) => name)).toEqual(tools.map(({ name }) => name).toSorted())
    expect(new Set(tools.map(({ name }) => name))).toHaveLength(tools.length)
    expect(tools).toHaveLength(report.entries.filter(({ result }) => result === 'included').length)
    for (const tool of tools) {
      const included = report.entries.find(({ tool_name }) => tool_name === tool.name)
      expect(included?.result).toBe('included')
      expect(included?.operation).toEqual(tool.operation)
      expect(tool.annotations).toEqual({
        readOnlyHint: tool.operation.effect === 'read',
        destructiveHint: tool.operation.effect === 'side_effect',
        idempotentHint: tool.operation.effect === 'read',
        openWorldHint: true,
      })
      if (tool.operation.completion === 'external_handle') {
        expect(tool.output_schema).not.toMatchObject({ description: expect.stringMatching(/receipt/i) })
      }
    }
    expect(walletManifest.tools.every(({ operation }) => operation.effect === 'side_effect')).toBe(true)
    expect(walletManifest.tools.every(({ input_schema }) => {
      const credential = (input_schema.properties as Record<string, unknown>).credential as {
        readonly properties: { readonly secret: { readonly maxLength?: number } }
      }
      return credential.properties.secret.maxLength === 4_096
    })).toBe(true)
    expect(publicManifest.tools.every(({ operation }) =>
      operation.effect === (operation.completion === 'external_handle' ? 'side_effect' : 'read'))).toBe(true)

    for (const artifact of [publicManifest, walletManifest, report]) {
      for (const record of allRecords(artifact)) {
        expect(Object.keys(record)).not.toEqual(expect.arrayContaining([
          'code', 'expression', 'inline_expression', 'source_code',
        ]))
      }
    }
  })

  it('checks generated bytes without writing any artifact', { timeout: 30_000 }, () => {
    const outputDirectory = temporaryDirectory()
    writeViemManifestArtifacts({ cwd: repositoryRoot, outputDirectory })
    const before = new Map(viemManifestFileNames.map((fileName) => [fileName, bytes(outputDirectory, fileName)]))

    expect(checkViemManifestArtifacts({ cwd: repositoryRoot, outputDirectory })).toEqual([])
    for (const fileName of viemManifestFileNames) expect(bytes(outputDirectory, fileName)).toEqual(before.get(fileName))

    writeFileSync(join(outputDirectory, 'viem-public.v1.json'), '{}', 'utf8')
    const staleBefore = new Map(viemManifestFileNames.map((fileName) => [fileName, bytes(outputDirectory, fileName)]))
    expect(checkViemManifestArtifacts({ cwd: repositoryRoot, outputDirectory })).toEqual(['viem-public.v1.json'])
    for (const fileName of viemManifestFileNames) expect(bytes(outputDirectory, fileName)).toEqual(staleBefore.get(fileName))
  })

  it('reports every artifact missing without creating a missing check directory', { timeout: 30_000 }, () => {
    const parent = temporaryDirectory()
    const outputDirectory = join(parent, 'missing-manifests')

    expect(checkViemManifestArtifacts({ cwd: repositoryRoot, outputDirectory }))
      .toEqual([...viemManifestFileNames])
    expect(existsSync(outputDirectory)).toBe(false)
  })

  it('restores every prior artifact when publication fails partway', { timeout: 30_000 }, () => {
    const outputDirectory = temporaryDirectory()
    mkdirSync(outputDirectory, { recursive: true })
    const original = new Map<string, Buffer>()
    for (const fileName of viemManifestFileNames) {
      const content = Buffer.from(`old-${fileName}`, 'utf8')
      original.set(fileName, content)
      writeFileSync(join(outputDirectory, fileName), content)
    }

    expect(() => writeViemManifestArtifacts({
      cwd: repositoryRoot,
      outputDirectory,
      testOnlyFailPublicationAfter: 1,
    })).toThrow('injected Manifest publication failure')

    for (const fileName of viemManifestFileNames) expect(bytes(outputDirectory, fileName)).toEqual(original.get(fileName))
  })

  it('rejects a pre-existing output symlink or non-directory without touching its target', { timeout: 30_000 }, () => {
    const parent = temporaryDirectory()
    const external = temporaryDirectory()
    const sentinel = join(external, 'sentinel.txt')
    writeFileSync(sentinel, 'external-safe', 'utf8')
    const linkedOutput = join(parent, 'linked-output')
    symlinkSync(external, linkedOutput, 'dir')

    expect(() => writeViemManifestArtifacts({ cwd: repositoryRoot, outputDirectory: linkedOutput }))
      .toThrow(/output directory.*regular non-symlink directory/i)
    expect(readFileSync(sentinel, 'utf8')).toBe('external-safe')
    expect(readdirSync(external)).toEqual(['sentinel.txt'])

    const fileOutput = join(parent, 'file-output')
    writeFileSync(fileOutput, 'not-a-directory', 'utf8')
    expect(() => writeViemManifestArtifacts({ cwd: repositoryRoot, outputDirectory: fileOutput }))
      .toThrow(/output directory.*regular non-symlink directory/i)
    expect(readFileSync(fileOutput, 'utf8')).toBe('not-a-directory')
  })

  it('does not move or delete an existing non-file artifact destination', { timeout: 30_000 }, () => {
    const outputDirectory = temporaryDirectory()
    const artifactDirectory = join(outputDirectory, 'viem-wallet.v1.json')
    const sentinel = join(artifactDirectory, 'sentinel.txt')
    mkdirSync(artifactDirectory)
    writeFileSync(sentinel, 'keep-me', 'utf8')

    expect(() => writeViemManifestArtifacts({ cwd: repositoryRoot, outputDirectory }))
      .toThrow(/artifact destination.*regular non-symlink file/i)
    expect(readFileSync(sentinel, 'utf8')).toBe('keep-me')
  })

  it('rejects artifact symlinks in write and check mode without following them', { timeout: 30_000 }, () => {
    const outputDirectory = temporaryDirectory()
    const external = temporaryDirectory()
    writeViemManifestArtifacts({ cwd: repositoryRoot, outputDirectory })
    const fileName = 'viem-public.v1.json'
    const destination = join(outputDirectory, fileName)
    const externalArtifact = join(external, fileName)
    const original = readFileSync(destination)
    writeFileSync(externalArtifact, original)
    unlinkSync(destination)
    symlinkSync(externalArtifact, destination)

    expect(() => writeViemManifestArtifacts({ cwd: repositoryRoot, outputDirectory }))
      .toThrow(/artifact destination.*regular non-symlink file/i)
    expect(() => checkViemManifestArtifacts({ cwd: repositoryRoot, outputDirectory }))
      .toThrow(/artifact destination.*regular non-symlink file/i)
    expect(readFileSync(externalArtifact)).toEqual(original)
  })

  it('checks size before reading oversized artifacts and rejects special artifact paths', { timeout: 30_000 }, () => {
    const outputDirectory = temporaryDirectory()
    writeViemManifestArtifacts({ cwd: repositoryRoot, outputDirectory })
    const oversizedName = 'viem-public.v1.json'
    const oversizedPath = join(outputDirectory, oversizedName)
    writeFileSync(oversizedPath, `${readFileSync(oversizedPath, 'utf8')}x`, 'utf8')
    chmodSync(oversizedPath, 0)
    expect(checkViemManifestArtifacts({ cwd: repositoryRoot, outputDirectory })).toEqual([oversizedName])
    chmodSync(oversizedPath, 0o600)

    const specialName = 'viem-wallet.v1.json'
    rmSync(join(outputDirectory, specialName))
    mkdirSync(join(outputDirectory, specialName))
    expect(() => checkViemManifestArtifacts({ cwd: repositoryRoot, outputDirectory }))
      .toThrow(/artifact destination.*regular non-symlink file/i)
  })

  it('retains the transaction backup and reports recovery details when restoration fails', { timeout: 30_000 }, () => {
    const outputDirectory = temporaryDirectory()
    writeViemManifestArtifacts({ cwd: repositoryRoot, outputDirectory })
    const original = new Map(viemManifestFileNames.map((fileName) => [fileName, bytes(outputDirectory, fileName)]))

    expect(() => writeViemManifestArtifacts({
      cwd: repositoryRoot,
      outputDirectory,
      testOnlyFailPublicationAfter: 1,
      testOnlyFailRestorationFor: 'viem-public.v1.json',
    })).toThrow(/rollback failed.*recovery retained/i)

    const transactionDirectories = readdirSync(outputDirectory)
      .filter((name) => name.startsWith('.tas-manifest-transaction-'))
    expect(transactionDirectories).toHaveLength(1)
    const recoveryRoot = join(outputDirectory, transactionDirectories[0] as string)
    expect(readFileSync(join(recoveryRoot, 'backup', 'viem-public.v1.json')))
      .toEqual(original.get('viem-public.v1.json'))
    expect(existsSync(join(outputDirectory, 'viem-public.v1.json'))).toBe(false)
    expect(bytes(outputDirectory, 'viem-wallet.v1.json')).toEqual(original.get('viem-wallet.v1.json'))
    expect(bytes(outputDirectory, 'viem-report.v1.json')).toEqual(original.get('viem-report.v1.json'))
  })

  it('matches the checked-in reviewed artifacts', { timeout: 30_000 }, () => {
    const generated = generateViemManifestArtifacts({ cwd: repositoryRoot })
    for (const fileName of viemManifestFileNames) {
      expect(readFileSync(join(repositoryRoot, 'manifests', fileName), 'utf8')).toBe(generated[fileName])
    }
  })

  it('generates trusted raw-byte artifact digest constants and detects source or artifact tampering', { timeout: 30_000 }, () => {
    const artifacts = generateViemManifestArtifacts({ cwd: repositoryRoot })
    const source = generateViemArtifactDigestSource(artifacts)
    const checkedInPath = join(repositoryRoot, viemArtifactDigestSourceRelativePath)

    expect(readFileSync(checkedInPath, 'utf8')).toBe(source)
    for (const fileName of viemManifestFileNames) {
      const digest = `sha256:${createHash('sha256').update(artifacts[fileName], 'utf8').digest('hex')}`
      expect(source).toContain(`'${fileName}': '${digest}'`)
    }

    const temporarySource = join(temporaryDirectory(), 'generatedViemArtifactDigests.ts')
    writeFileSync(temporarySource, source)
    expect(checkViemArtifactDigestSource(temporarySource, artifacts)).toBe(true)
    writeFileSync(temporarySource, `${source}\n// tampered\n`)
    expect(checkViemArtifactDigestSource(temporarySource, artifacts)).toBe(false)

    const tamperedArtifacts = {
      ...artifacts,
      'viem-public.v1.json': `${artifacts['viem-public.v1.json']} `,
    }
    expect(generateViemArtifactDigestSource(tamperedArtifacts)).not.toBe(source)
  })

  it('publishes JSON and trusted digest source as one rollback set', { timeout: 60_000 }, () => {
    const outputDirectory = temporaryDirectory()
    const sourceDirectory = temporaryDirectory()
    const artifactDigestSourcePath = join(sourceDirectory, 'generatedViemArtifactDigests.ts')
    mkdirSync(outputDirectory, { recursive: true })
    const originals = new Map<string, Buffer>()
    for (const fileName of viemManifestFileNames) {
      const contents = Buffer.from(`old-${fileName}`)
      originals.set(fileName, contents)
      writeFileSync(join(outputDirectory, fileName), contents)
    }
    const sourceContents = Buffer.from('old-generated-digests\n')
    originals.set(viemArtifactDigestSourceRelativePath, sourceContents)
    writeFileSync(artifactDigestSourcePath, sourceContents)

    expect(() => writeViemGeneratedOutputs({
      cwd: repositoryRoot,
      outputDirectory,
      artifactDigestSourcePath,
      testOnlyFailPublicationAfter: 3,
    })).toThrow('injected Manifest publication failure')

    for (const fileName of viemManifestFileNames) {
      expect(bytes(outputDirectory, fileName)).toEqual(originals.get(fileName))
    }
    expect(readFileSync(artifactDigestSourcePath)).toEqual(originals.get(viemArtifactDigestSourceRelativePath))
  })

  it('checks the generated source and rejects symlink or special destinations before publication', { timeout: 60_000 }, () => {
    const outputDirectory = temporaryDirectory()
    const sourceDirectory = temporaryDirectory()
    const artifactDigestSourcePath = join(sourceDirectory, 'generatedViemArtifactDigests.ts')
    writeViemGeneratedOutputs({ cwd: repositoryRoot, outputDirectory, artifactDigestSourcePath })
    expect(checkViemGeneratedOutputs({ cwd: repositoryRoot, outputDirectory, artifactDigestSourcePath })).toEqual([])
    writeFileSync(artifactDigestSourcePath, '// stale\n')
    expect(checkViemGeneratedOutputs({ cwd: repositoryRoot, outputDirectory, artifactDigestSourcePath }))
      .toEqual([viemArtifactDigestSourceRelativePath])

    const external = join(temporaryDirectory(), 'external.ts')
    writeFileSync(external, 'keep-safe')
    rmSync(artifactDigestSourcePath)
    symlinkSync(external, artifactDigestSourcePath)
    expect(() => writeViemGeneratedOutputs({ cwd: repositoryRoot, outputDirectory, artifactDigestSourcePath }))
      .toThrow(/artifact destination.*regular non-symlink/i)
    expect(readFileSync(external, 'utf8')).toBe('keep-safe')

    rmSync(artifactDigestSourcePath)
    mkdirSync(artifactDigestSourcePath)
    expect(() => writeViemGeneratedOutputs({ cwd: repositoryRoot, outputDirectory, artifactDigestSourcePath }))
      .toThrow(/artifact destination.*regular non-symlink/i)
    expect(readdirSync(outputDirectory).filter((name) => name.startsWith('.tas-manifest-transaction-')))
      .toEqual([])
  })
})
