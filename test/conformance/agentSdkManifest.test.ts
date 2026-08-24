import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import { afterEach, describe, expect, it } from 'vitest'

import { parseDependencyManifest } from '../../src/mcp/manifest/types.js'
import { analyzeAgentSdk } from '../../tools/manifest/analyzeAgentSdk.js'
import {
  allManifestFileNames,
  agentSdkArtifactDigestSourceRelativePath,
  agentSdkManifestFileNames,
  chatArtifactDigestSourceRelativePath,
  computeAgentSdkEntrypointDigest,
  reviewAgentSdkEntrypoints,
  viemArtifactDigestSourceRelativePath,
  writeGeneratedOutputs,
  writeAgentSdkManifestArtifacts,
} from '../../tools/manifest/generate.js'

const repositoryRoot = resolve(import.meta.dirname, '../..')
const roots: string[] = []

function temporaryDirectory(): string {
  const root = mkdtempSync(join(tmpdir(), 'tas-agent-sdk-manifest-'))
  roots.push(root)
  return root
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('reviewed agent-sdk Manifest generation', () => {
  it('publishes compiled raw-byte digests for both agent-sdk artifacts', { timeout: 60_000 }, async () => {
    const outputDirectory = temporaryDirectory()
    const sourceDirectory = temporaryDirectory()
    const viemArtifactDigestSourcePath = join(sourceDirectory, 'generatedViemArtifactDigests.ts')
    const agentSdkArtifactDigestSourcePath = join(sourceDirectory, 'generatedAgentSdkArtifactDigests.ts')
    const chatArtifactDigestSourcePath = join(sourceDirectory, 'generatedChatArtifactDigests.ts')

    writeGeneratedOutputs({
      cwd: repositoryRoot,
      outputDirectory,
      artifactDigestSourcePath: viemArtifactDigestSourcePath,
      agentSdkArtifactDigestSourcePath,
      chatArtifactDigestSourcePath,
    })

    const generated = await import(`${pathToFileURL(agentSdkArtifactDigestSourcePath).href}?v=${Date.now()}`) as {
      readonly bundledAgentSdkArtifactDigests: Readonly<Record<string, `sha256:${string}`>>
    }
    for (const fileName of agentSdkManifestFileNames) {
      const actual = `sha256:${createHash('sha256').update(readFileSync(join(outputDirectory, fileName))).digest('hex')}`
      expect(generated.bundledAgentSdkArtifactDigests[fileName]).toBe(actual)
    }
    expect(Object.keys(generated.bundledAgentSdkArtifactDigests).toSorted()).toEqual([...agentSdkManifestFileNames].toSorted())
  })

  it('generates byte-identical canonical artifacts and accounts for every public callable', { timeout: 30_000 }, () => {
    const first = temporaryDirectory()
    const second = temporaryDirectory()
    writeAgentSdkManifestArtifacts({ cwd: repositoryRoot, outputDirectory: first })
    writeAgentSdkManifestArtifacts({ cwd: repositoryRoot, outputDirectory: second })

    for (const fileName of agentSdkManifestFileNames) {
      const firstBytes = readFileSync(join(first, fileName))
      const secondBytes = readFileSync(join(second, fileName))
      expect(firstBytes).toEqual(secondBytes)
      const text = firstBytes.toString('utf8')
      expect(text.endsWith('\n')).toBe(false)
      expect(JSON.stringify(JSON.parse(text))).toBe(text)
    }

    const manifest = parseDependencyManifest(JSON.parse(
      readFileSync(join(first, 'agent-sdk.v1.json'), 'utf8'),
    ) as unknown)
    const report = JSON.parse(readFileSync(join(first, 'agent-sdk-report.v1.json'), 'utf8')) as {
      readonly source: { readonly package: string; readonly version: string; readonly package_integrity: string }
      readonly reviewed_entrypoints: readonly {
        readonly entrypoint: string
        readonly exported_types_path: string
        readonly exported_runtime_path: string
        readonly exported_types_sha256: `sha256:${string}`
      }[]
      readonly reviewed_declarations: readonly unknown[]
      readonly trusted_dependencies: readonly unknown[]
      readonly reviewed_packages: readonly unknown[]
      readonly reviewed_runtime_files: readonly {
        readonly package_name: string
        readonly package_version: string
        readonly package_relative_path: string
        readonly sha256: `sha256:${string}`
      }[]
      readonly entries: readonly {
        readonly entrypoint: string
        readonly export_name: string
        readonly member?: string
        readonly result: 'included' | 'excluded'
        readonly tool_name?: string
        readonly reason_code?: string
      }[]
      readonly provider_adapter_claims: readonly unknown[]
      readonly failures: readonly unknown[]
    }
    const analysis = analyzeAgentSdk({ cwd: repositoryRoot })

    expect(manifest).toMatchObject({
      manifest_id: 'agent-sdk',
      source_profile: 'agent-sdk',
      source: {
        package: '@trustless-ai/agent-sdk',
        version: '0.3.0',
        package_integrity: analysis.packageIntegrity,
      },
    })
    expect(manifest.source.entrypoints).toEqual(analysis.entrypoints)
    expect(report.reviewed_entrypoints.map(({ entrypoint }) => entrypoint)).toEqual(analysis.entrypoints)
    expect(report.reviewed_runtime_files).toEqual(analysis.reviewedRuntimeFiles.map((file) => ({
      package_name: file.packageName,
      package_version: file.packageVersion,
      package_relative_path: file.packageRelativePath,
      sha256: file.sha256,
    })))
    const digestInput = {
      packageVersion: analysis.packageVersion,
      packageIntegrity: analysis.packageIntegrity,
      reviewedEntrypoints: report.reviewed_entrypoints,
      trustedDependencies: analysis.trustedDependencies,
      reviewedPackages: report.reviewed_packages,
      reviewedDeclarations: report.reviewed_declarations,
      reviewedRuntimeFiles: report.reviewed_runtime_files,
    }
    expect(manifest.source.entrypoint_digest).toBe(computeAgentSdkEntrypointDigest(digestInput))
    const changedRuntimeFiles = report.reviewed_runtime_files.map((file, index) => index === 0
      ? { ...file, sha256: `sha256:${'0'.repeat(64)}` as const }
      : file)
    expect(computeAgentSdkEntrypointDigest({ ...digestInput, reviewedRuntimeFiles: changedRuntimeFiles }))
      .not.toBe(manifest.source.entrypoint_digest)
    const changedRuntimePath = report.reviewed_entrypoints.map((entrypoint, index) => index === 0
      ? { ...entrypoint, exported_runtime_path: './dist/changed-runtime.js' }
      : entrypoint)
    expect(computeAgentSdkEntrypointDigest({ ...digestInput, reviewedEntrypoints: changedRuntimePath }))
      .not.toBe(manifest.source.entrypoint_digest)
    expect(report.provider_adapter_claims).toEqual([])
    expect(report.failures).toEqual([])

    const analysisKeys = [...analysis.included, ...analysis.excluded].map(({ entrypoint, exportName, member }) =>
      `${entrypoint}:${exportName}:${member ?? ''}`).toSorted()
    const reportKeys = report.entries.map(({ entrypoint, export_name, member }) =>
      `${entrypoint}:${export_name}:${member ?? ''}`)
    expect(reportKeys).toEqual(analysisKeys)
    expect(new Set(reportKeys)).toHaveLength(reportKeys.length)
    expect(manifest.tools).toHaveLength(report.entries.filter(({ result }) => result === 'included').length)
    expect(manifest.tools).toHaveLength(56)
    const reads = manifest.tools.filter(({ operation }) => operation.effect === 'read')
    const writes = manifest.tools.filter(({ operation }) => operation.effect === 'side_effect')
    expect(reads).toHaveLength(40)
    expect(writes).toHaveLength(16)
    expect(reads.every(({ credential }) => credential === 'none')).toBe(true)
    expect(writes.every(({ credential }) => credential === 'evm_private_key')).toBe(true)
    expect(reads.every(({ input_schema }) =>
      !Object.hasOwn((input_schema.properties ?? {}) as object, 'credential'))).toBe(true)
    expect(writes.every(({ input_schema }) => {
      const credential = (input_schema.properties as Record<string, unknown> | undefined)?.credential
      const required = input_schema.required
      return credential !== undefined
        && JSON.stringify(credential).includes('"writeOnly":true')
        && JSON.stringify(credential).includes('"maxLength":4096')
        && !(Array.isArray(required) && Array.prototype.includes.call(required, 'credential'))
    })).toBe(true)
    for (const action of analysis.included) {
      const tool = manifest.tools.find(({ name }) => name === action.toolName)
      expect(tool?.binding).toMatchObject({ arguments: action.invocationArguments })
      const inputSlots = action.invocationArguments
        .filter((argument) => argument.kind === 'input')
        .map(({ name }) => name)
      const properties = Object.keys((tool?.input_schema.properties ?? {}) as object)
        .filter((name) => name !== 'credential')
      expect(inputSlots.toSorted()).toEqual(properties.toSorted())
    }
    expect(manifest.tools.find(({ name }) => name === 'workflow.verify.erc8274.get_trusted_verifier')?.binding)
      .toMatchObject({ arguments: [{ kind: 'runtime', source: 'chain_config' }] })
    const optionalAction = analysis.included.find((action) => {
      const properties = Object.keys((action.projection.input_schema.properties ?? {}) as object)
      const required = action.projection.input_schema.required
      return properties.some((name) => !(Array.isArray(required) && required.includes(name)))
    })
    expect(optionalAction).toBeDefined()
    expect(manifest.tools.find(({ name }) => name === optionalAction?.toolName)?.binding)
      .toMatchObject({ arguments: optionalAction?.invocationArguments })
    expect(manifest.tools.map(({ name }) => name).toSorted()).toEqual(manifest.tools.map(({ name }) => name))
    expect(new Set(manifest.tools.map(({ name }) => name))).toHaveLength(manifest.tools.length)
    expect(manifest.tools.some(({ name }) => /invino|review_gate/.test(name))).toBe(false)
    expect(report.entries.some(({ entrypoint }) => /governance\/InvinoVeritas/i.test(entrypoint))).toBe(false)
  })

  it('rejects package export paths that changed after analyzer review', () => {
    const packageRoot = temporaryDirectory()
    const runtimeBytes = 'export const value = 1\n'
    writeFileSync(join(packageRoot, 'types.d.ts'), 'export declare const value: 1\n')
    writeFileSync(join(packageRoot, 'runtime.js'), runtimeBytes)
    writeFileSync(join(packageRoot, 'changed.js'), 'export const changed = true\n')
    writeFileSync(join(packageRoot, 'changed.d.ts'), 'export declare const changed: true\n')
    const runtimeFiles = ['runtime.js', 'changed.js'].map((packageRelativePath) => ({
      package_name: '@trustless-ai/agent-sdk',
      package_version: '0.3.0',
      package_relative_path: packageRelativePath,
      sha256: `sha256:${createHash('sha256').update(readFileSync(join(packageRoot, packageRelativePath))).digest('hex')}` as const,
    }))
    const reviewedEntrypoints = [{
      entrypoint: '.',
      typesPackageRelativePath: 'types.d.ts',
      runtimePackageRelativePath: 'runtime.js',
    }]
    const writePackageExports = (types: string, runtime: string) => {
      writeFileSync(join(packageRoot, 'package.json'), JSON.stringify({
        name: '@trustless-ai/agent-sdk',
        version: '0.3.0',
        exports: { '.': { types, default: runtime } },
      }))
    }

    writePackageExports('./types.d.ts', './runtime.js')
    expect(reviewAgentSdkEntrypoints({ packageRoot, reviewedEntrypoints, reviewedRuntimeFiles: runtimeFiles }))
      .toMatchObject([{ exported_types_path: './types.d.ts', exported_runtime_path: './runtime.js' }])

    writePackageExports('./types.d.ts', './changed.js')
    expect(() => reviewAgentSdkEntrypoints({ packageRoot, reviewedEntrypoints, reviewedRuntimeFiles: runtimeFiles }))
      .toThrow(/runtime export.*analyzer/i)

    writePackageExports('./changed.d.ts', './runtime.js')
    expect(() => reviewAgentSdkEntrypoints({ packageRoot, reviewedEntrypoints, reviewedRuntimeFiles: runtimeFiles }))
      .toThrow(/types export.*analyzer/i)
  })

  it('publishes viem, agent-sdk, Chat, and trusted digest outputs as one rollback set', { timeout: 60_000 }, () => {
    const outputDirectory = temporaryDirectory()
    const sourceDirectory = temporaryDirectory()
    const artifactDigestSourcePath = join(sourceDirectory, 'generatedViemArtifactDigests.ts')
    const agentSdkArtifactDigestSourcePath = join(sourceDirectory, 'generatedAgentSdkArtifactDigests.ts')
    const chatArtifactDigestSourcePath = join(sourceDirectory, 'generatedChatArtifactDigests.ts')
    const originals = new Map<string, Buffer>()
    for (const fileName of allManifestFileNames) {
      const contents = Buffer.from(`old-${fileName}`, 'utf8')
      originals.set(fileName, contents)
      writeFileSync(join(outputDirectory, fileName), contents)
    }
    const sourceContents = Buffer.from('old-generated-digests\n', 'utf8')
    originals.set(viemArtifactDigestSourceRelativePath, sourceContents)
    writeFileSync(artifactDigestSourcePath, sourceContents)
    originals.set(agentSdkArtifactDigestSourceRelativePath, sourceContents)
    writeFileSync(agentSdkArtifactDigestSourcePath, sourceContents)
    originals.set(chatArtifactDigestSourceRelativePath, sourceContents)
    writeFileSync(chatArtifactDigestSourcePath, sourceContents)

    expect(() => writeGeneratedOutputs({
      cwd: repositoryRoot,
      outputDirectory,
      artifactDigestSourcePath,
      agentSdkArtifactDigestSourcePath,
      chatArtifactDigestSourcePath,
      testOnlyFailPublicationAfter: 4,
    })).toThrow('injected Manifest publication failure')

    for (const fileName of allManifestFileNames) {
      expect(readFileSync(join(outputDirectory, fileName))).toEqual(originals.get(fileName))
    }
    expect(readFileSync(artifactDigestSourcePath)).toEqual(originals.get(viemArtifactDigestSourceRelativePath))
    expect(readFileSync(agentSdkArtifactDigestSourcePath)).toEqual(originals.get(agentSdkArtifactDigestSourceRelativePath))
    expect(readFileSync(chatArtifactDigestSourcePath)).toEqual(originals.get(chatArtifactDigestSourceRelativePath))
  })
})
