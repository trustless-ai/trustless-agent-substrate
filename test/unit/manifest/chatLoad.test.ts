import { createHash } from 'node:crypto'
import {
  cpSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { afterAll, describe, expect, it, vi } from 'vitest'

import { canonicalJson } from '../../../tools/manifest/canonicalJson.js'

const artifactNames = [
  'telegram.v1.json', 'telegram-report.v1.json', 'discord.v1.json', 'discord-report.v1.json',
] as const
type ArtifactName = typeof artifactNames[number]

const loaderHarness = vi.hoisted(() => ({
  overrides: [] as Array<{ readonly from: string; readonly to: string }>,
  digests: {
    'telegram.v1.json': 'sha256:87f08538816a2bbbca37f69d8279b1e52a504e55d8881517e99e9515bde0052b',
    'telegram-report.v1.json': 'sha256:c4911b57810221315256686e7cadffff8999c26ba5b1644c0f86537b01f651ec',
    'discord.v1.json': 'sha256:c5393ac9df404112fd2d9f26b4e07678fefc09c28f3b90d5a0e0f5f0cc7acab0',
    'discord-report.v1.json': 'sha256:d7481ecaa5760d3fad6c16396ff1d879aae77eb2017333c3d4c66b37f7be993a',
  } as Record<ArtifactName, `sha256:${string}`>,
}))

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  const matchingOverride = (path: unknown) => typeof path === 'string'
    ? loaderHarness.overrides.filter(({ from }) => path === from || path.startsWith(`${from}/`))
      .toSorted((left, right) => right.from.length - left.from.length)[0]
    : undefined
  const redirect = <T>(path: T): T => {
    const match = matchingOverride(path)
    return match === undefined || typeof path !== 'string'
      ? path
      : `${match.to}${path.slice(match.from.length)}` as T
  }
  return {
    ...actual,
    lstatSync: ((path: unknown, ...rest: unknown[]) => (actual.lstatSync as any)(redirect(path), ...rest)) as any,
    openSync: ((path: unknown, ...rest: unknown[]) => (actual.openSync as any)(redirect(path), ...rest)) as any,
    realpathSync: ((path: unknown, ...rest: unknown[]) => {
      const match = matchingOverride(path)
      const result = (actual.realpathSync as any)(redirect(path), ...rest) as unknown
      if (match === undefined || typeof result !== 'string') return result
      const target = actual.realpathSync(match.to)
      return result === target || result.startsWith(`${target}/`)
        ? `${match.from}${result.slice(target.length)}`
        : result
    }) as any,
  }
})

vi.mock('../../../src/mcp/manifest/generatedChatArtifactDigests.js', () => ({
  bundledChatArtifactDigests: loaderHarness.digests,
}))

import { loadBundledChatManifests } from '../../../src/mcp/manifest/load.js'

const repositoryRoot = resolve(import.meta.dirname, '../../..')
const temporaryRoots: string[] = []

function temporaryDirectory(): string {
  const path = mkdtempSync(join(tmpdir(), 'tas-chat-loader-'))
  temporaryRoots.push(path)
  return path
}

function bundledArtifacts(): Record<ArtifactName, Buffer> {
  return Object.fromEntries(artifactNames.map((name) => [
    name, readFileSync(join(repositoryRoot, 'manifests', name)),
  ])) as Record<ArtifactName, Buffer>
}

function reviewArtifacts(artifacts: Readonly<Record<ArtifactName, Buffer>>): void {
  for (const name of artifactNames) {
    loaderHarness.digests[name] = `sha256:${createHash('sha256').update(artifacts[name]).digest('hex')}`
  }
}

function invokeWithArtifacts(artifacts: Readonly<Record<ArtifactName, Buffer>>, review = false): unknown {
  const root = temporaryDirectory()
  for (const name of artifactNames) writeFileSync(join(root, name), artifacts[name])
  if (review) reviewArtifacts(artifacts)
  loaderHarness.overrides.push({ from: join(repositoryRoot, 'manifests'), to: root })
  try {
    return loadBundledChatManifests()
  } finally {
    loaderHarness.overrides.splice(0)
    reviewArtifacts(bundledArtifacts())
  }
}

function expectInvalid(run: () => unknown): void {
  expect(run).toThrow('TAS_MANIFEST_INVALID: bundled Manifest validation failed')
}

afterAll(() => {
  for (const root of temporaryRoots) rmSync(root, { recursive: true, force: true })
})

describe('bundled Chat Manifest loader', () => {
  it('admits the complete reviewed platform inventories as immutable Registry inputs', () => {
    const loaded = loadBundledChatManifests()

    expect(loaded.telegram.manifest.tools).toHaveLength(56)
    expect(loaded.discord.manifest.tools).toHaveLength(4)
    expect(Object.isFrozen(loaded)).toBe(true)
    expect(Object.isFrozen(loaded.telegram.manifest.tools)).toBe(true)
    expect(Object.isFrozen(loaded.discord.review.entries)).toBe(true)
  })

  it('rejects raw-byte artifact tampering before parsing descriptions', () => {
    const artifacts = bundledArtifacts()
    artifacts['telegram.v1.json'] = Buffer.concat([artifacts['telegram.v1.json'], Buffer.from(' ')])
    expectInvalid(() => invokeWithArtifacts(artifacts))
  })

  it('rejects a re-digested Telegram artifact that injects the Discord namespace', () => {
    const artifacts = bundledArtifacts()
    const manifest = JSON.parse(artifacts['telegram.v1.json'].toString('utf8')) as any
    manifest.tools[0].name = 'chat.discord.message_manager.delete'
    artifacts['telegram.v1.json'] = Buffer.from(canonicalJson(manifest, { maxExpandedNodes: 100_000 }))
    expectInvalid(() => invokeWithArtifacts(artifacts, true))
  })

  it('rejects unknown report fields even when the artifact digest is re-reviewed', () => {
    const artifacts = bundledArtifacts()
    const report = JSON.parse(artifacts['discord-report.v1.json'].toString('utf8')) as any
    report.unreviewed = true
    artifacts['discord-report.v1.json'] = Buffer.from(canonicalJson(report, { maxExpandedNodes: 100_000 }))
    expectInvalid(() => invokeWithArtifacts(artifacts, true))
  })

  it('rejects a re-digested Chat tool that weakens the inline credential schema', () => {
    const artifacts = bundledArtifacts()
    const manifest = JSON.parse(artifacts['telegram.v1.json'].toString('utf8')) as any
    manifest.tools[0].input_schema.properties.credential.properties.secret.minLength = 0
    artifacts['telegram.v1.json'] = Buffer.from(canonicalJson(manifest, { maxExpandedNodes: 100_000 }))
    expectInvalid(() => invokeWithArtifacts(artifacts, true))
  })

  it('rejects a re-digested report that omits one included operation', () => {
    const artifacts = bundledArtifacts()
    const report = JSON.parse(artifacts['discord-report.v1.json'].toString('utf8')) as any
    const index = report.entries.findIndex((entry: any) => entry.result === 'included')
    report.entries.splice(index, 1)
    artifacts['discord-report.v1.json'] = Buffer.from(canonicalJson(report, { maxExpandedNodes: 100_000 }))
    expectInvalid(() => invokeWithArtifacts(artifacts, true))
  })

  it('rejects an oversized fixed artifact before JSON parsing', () => {
    const artifacts = bundledArtifacts()
    artifacts['telegram.v1.json'] = Buffer.alloc(1_048_576, 0x20)
    expectInvalid(() => invokeWithArtifacts(artifacts))
  })

  it('rejects a symlink in place of a fixed bundled artifact', () => {
    const artifacts = bundledArtifacts()
    const root = temporaryDirectory()
    const target = join(root, 'target.json')
    writeFileSync(target, artifacts['telegram.v1.json'])
    for (const name of artifactNames.filter((name) => name !== 'telegram.v1.json')) {
      writeFileSync(join(root, name), artifacts[name])
    }
    symlinkSync(target, join(root, 'telegram.v1.json'))
    loaderHarness.overrides.push({ from: join(repositoryRoot, 'manifests'), to: root })
    try {
      expectInvalid(() => loadBundledChatManifests())
    } finally {
      loaderHarness.overrides.splice(0)
    }
  })

  it('rejects an installed Chat entrypoint that differs from the reviewed source digest', () => {
    const mirror = join(temporaryDirectory(), 'grammy')
    const installed = join(repositoryRoot, 'node_modules', 'grammy')
    cpSync(installed, mirror, { recursive: true })
    writeFileSync(join(mirror, 'out', 'mod.d.ts'), '\n// tampered\n', { flag: 'a' })
    loaderHarness.overrides.push({ from: installed, to: mirror })
    try {
      expectInvalid(() => loadBundledChatManifests())
    } finally {
      loaderHarness.overrides.splice(0)
    }
  })
})
