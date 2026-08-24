import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import {
  reviewedPackageTreeLimits,
  snapshotReviewedPackageTrees,
  snapshotReviewedPackageTreesForTest,
} from '../../../src/mcp/manifest/packageTree.js'

const temporaryRoots: string[] = []

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'tas-package-tree-'))
  temporaryRoots.push(directory)
  return directory
}

function packageRoot(name = 'package'): string {
  const root = join(temporaryDirectory(), name)
  mkdirSync(root)
  return root
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('reviewed package-tree snapshots', () => {
  it('is deterministic across creation order and binds paths plus file bytes', () => {
    const first = packageRoot('first')
    writeFileSync(join(first, 'runtime.js'), 'export const value = 1\n')
    writeFileSync(join(first, 'package.json'), '{"name":"fixture","version":"1.0.0"}\n')

    const second = packageRoot('second')
    writeFileSync(join(second, 'package.json'), '{"name":"fixture","version":"1.0.0"}\n')
    writeFileSync(join(second, 'runtime.js'), 'export const value = 1\n')

    const firstSnapshot = snapshotReviewedPackageTrees([{ packageName: 'fixture', packageRoot: first }])[0]
    const secondSnapshot = snapshotReviewedPackageTrees([{ packageName: 'fixture', packageRoot: second }])[0]
    expect(firstSnapshot).toEqual(secondSnapshot)
    expect(firstSnapshot).toMatchObject({
      packageName: 'fixture',
      packageFileCount: 2,
      packageTotalBytes: 60,
      packageTreeSha256: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
    })

    writeFileSync(join(first, 'runtime.js'), 'export const value = 2\n')
    const modified = snapshotReviewedPackageTrees([{ packageName: 'fixture', packageRoot: first }])[0]
    expect(modified?.packageTreeSha256).not.toBe(firstSnapshot?.packageTreeSha256)

    writeFileSync(join(first, 'runtime.js.map'), '{}')
    const added = snapshotReviewedPackageTrees([{ packageName: 'fixture', packageRoot: first }])[0]
    expect(added?.packageTreeSha256).not.toBe(modified?.packageTreeSha256)
    expect(added?.packageFileCount).toBe(3)

    rmSync(join(first, 'runtime.js'))
    const deleted = snapshotReviewedPackageTrees([{ packageName: 'fixture', packageRoot: first }])[0]
    expect(deleted?.packageTreeSha256).not.toBe(added?.packageTreeSha256)
    expect(deleted?.packageFileCount).toBe(2)
  })

  it('uses fixed production budgets with room above the current dependency tree', () => {
    expect(reviewedPackageTreeLimits).toEqual({
      maximumFileBytes: 4 * 1_024 * 1_024,
      maximumPackageFiles: 20_000,
      maximumPackageBytes: 128 * 1_024 * 1_024,
      maximumGlobalFiles: 50_000,
      maximumGlobalBytes: 256 * 1_024 * 1_024,
      maximumPackageDirectories: 50_000,
      maximumGlobalDirectories: 100_000,
      maximumPackageEntries: 50_000,
      maximumGlobalEntries: 100_000,
    })
  })

  it('rejects symlinks and nested node_modules anywhere inside a package', () => {
    const linked = packageRoot('linked')
    const external = join(temporaryDirectory(), 'external.js')
    writeFileSync(external, 'external')
    symlinkSync(external, join(linked, 'linked.js'))
    expect(() => snapshotReviewedPackageTrees([{ packageName: 'linked', packageRoot: linked }]))
      .toThrow('symlink')

    const nested = packageRoot('nested')
    mkdirSync(join(nested, 'lib', 'node_modules'), { recursive: true })
    expect(() => snapshotReviewedPackageTrees([{ packageName: 'nested', packageRoot: nested }]))
      .toThrow('nested node_modules')

    const uppercaseNested = packageRoot('uppercase-nested')
    mkdirSync(join(uppercaseNested, 'lib', 'NODE_MODULES'), { recursive: true })
    expect(() => snapshotReviewedPackageTrees([{ packageName: 'uppercase-nested', packageRoot: uppercaseNested }]))
      .toThrow('nested node_modules')
  })

  it.skipIf(process.platform === 'win32')('rejects special filesystem entries', () => {
    const root = packageRoot('special')
    execFileSync('mkfifo', [join(root, 'pipe')])
    expect(() => snapshotReviewedPackageTrees([{ packageName: 'special', packageRoot: root }]))
      .toThrow('special filesystem entry')
  })

  it.each([
    ['single-file byte', { maximumFileBytes: 3 }, [['a', '1234']], 'single-file byte budget'],
    ['package file-count', { maximumPackageFiles: 1 }, [['a', '1'], ['b', '2']], 'package file-count budget'],
    ['package byte', { maximumPackageBytes: 3 }, [['a', '12'], ['b', '34']], 'package byte budget'],
    ['package directory-count', { maximumPackageDirectories: 1 }, [], 'package directory-count budget'],
  ] as const)('fails the %s budget before hashing unbounded input', (_name, override, files, expected) => {
    const root = packageRoot('bounded')
    for (const [name, contents] of files) writeFileSync(join(root, name), contents)
    if ('maximumPackageDirectories' in override) mkdirSync(join(root, 'one', 'two'), { recursive: true })
    expect(() => snapshotReviewedPackageTreesForTest(
      [{ packageName: 'bounded', packageRoot: root }],
      { ...reviewedPackageTreeLimits, ...override },
    )).toThrow(expected)
  })

  it('stops a huge single directory at the entry budget before processing later entries', () => {
    const root = packageRoot('many-entries')
    for (let index = 0; index < 1_024; index += 1) {
      writeFileSync(join(root, `entry-${index.toString().padStart(4, '0')}`), 'x')
    }
    expect(() => snapshotReviewedPackageTreesForTest(
      [{ packageName: 'many-entries', packageRoot: root }],
      { ...reviewedPackageTreeLimits, maximumPackageEntries: 2 },
    )).toThrow('package entry-count budget')
  })

  it.each([
    ['global file-count', { maximumGlobalFiles: 1 }, 'global file-count budget'],
    ['global byte', { maximumGlobalBytes: 3 }, 'global byte budget'],
    ['global directory-count', { maximumGlobalDirectories: 1 }, 'global directory-count budget'],
    ['global entry-count', { maximumGlobalEntries: 1 }, 'global entry-count budget'],
  ] as const)('fails the %s across packages', (_name, override, expected) => {
    const first = packageRoot('first')
    const second = packageRoot('second')
    writeFileSync(join(first, 'a'), '12')
    writeFileSync(join(second, 'b'), '34')
    expect(() => snapshotReviewedPackageTreesForTest([
      { packageName: 'first', packageRoot: first },
      { packageName: 'second', packageRoot: second },
    ], { ...reviewedPackageTreeLimits, ...override })).toThrow(expected)
  })
})
