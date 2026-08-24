import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { findInstallationRoot } from '../../../src/mcp/manifest/installationRoot.js'

const roots: string[] = []

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'tas-installation-root-'))
  roots.push(root)
  return root
}

function hiddenLock(root: string): void {
  mkdirSync(join(root, 'node_modules'), { recursive: true })
  writeFileSync(join(root, 'node_modules', '.package-lock.json'), '{}')
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('findInstallationRoot', () => {
  it('rejects a source root with an incomplete local installation instead of falling back to a parent tree', () => {
    const parent = temporaryRoot()
    hiddenLock(parent)
    const artifactRoot = join(parent, 'source', 'tas')
    mkdirSync(join(artifactRoot, 'node_modules'), { recursive: true })

    expect(findInstallationRoot(artifactRoot)).toBeUndefined()
  })

  it('ignores package-local nested dependencies and finds the containing installation hidden lock', () => {
    const installationRoot = temporaryRoot()
    hiddenLock(installationRoot)
    const artifactRoot = join(installationRoot, 'node_modules', '@trustless-ai', 'tas')
    mkdirSync(join(artifactRoot, 'node_modules', 'nested-dependency'), { recursive: true })

    expect(findInstallationRoot(artifactRoot)).toBe(installationRoot)
  })

  it('walks across a lock-free nested package tree to the outer installation hidden lock', () => {
    const installationRoot = temporaryRoot()
    hiddenLock(installationRoot)
    const artifactRoot = join(
      installationRoot,
      'node_modules',
      'host-package',
      'node_modules',
      '@trustless-ai',
      'tas',
    )
    mkdirSync(artifactRoot, { recursive: true })

    expect(findInstallationRoot(artifactRoot)).toBe(installationRoot)
  })

  it('finds a hoisted installation when a workspace package has no local node_modules', () => {
    const installationRoot = temporaryRoot()
    hiddenLock(installationRoot)
    const artifactRoot = join(installationRoot, 'packages', 'tas')
    mkdirSync(artifactRoot, { recursive: true })

    expect(findInstallationRoot(artifactRoot)).toBe(installationRoot)
  })
})
