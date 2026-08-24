import { createHash } from 'node:crypto'
import { readFileSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

const repositoryRoot = fileURLToPath(new URL('../../', import.meta.url))
const demoRoot = resolve(repositoryRoot, 'tawg/demo')
const vendorRoot = resolve(demoRoot, 'vendor/agent-ercs')
const pinnedCommit = '00605871ff33e80ff21804e5d1cd1ba5fa1c2d68'
const expectedSources = {
  'contracts/execution/ERC8301/IAgentWorkflow.sol': 'e551dc81859c03828a55b116ee70720b8c60edfb261f6880c37317ca3bc7ca9e',
  'contracts/verify/ERC8274/IAgentVerifier.sol': '115942e5c66f76e8447f9cae51f80d6820a09c22609022bcd8443455b49baa36',
} as const

interface ProvenanceSource {
  readonly path: string
  readonly sourceUrl: string
  readonly sha256: string
  readonly spdxLicense: string
}

interface LicenseEvidence {
  readonly path: string
  readonly sourceUrl: string
  readonly sha256: string
}

interface Provenance {
  readonly repository: string
  readonly commit: string
  readonly repositoryLicense: string
  readonly repositoryLicenseEvidence: LicenseEvidence
  readonly licenseNote: string
  readonly sources: readonly ProvenanceSource[]
}

function solidityFiles(directory: string, prefix = ''): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const relativePath = prefix === '' ? entry.name : `${prefix}/${entry.name}`
    const path = resolve(directory, entry.name)
    if (entry.isDirectory()) return solidityFiles(path, relativePath)
    return entry.isFile() && entry.name.endsWith('.sol') ? [relativePath] : []
  }).sort()
}

function sha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

describe('Demo TAWG standalone dependencies', () => {
  it('pins exact reviewed agent-ercs source provenance and bytes', () => {
    const provenance = JSON.parse(readFileSync(resolve(vendorRoot, 'PROVENANCE.json'), 'utf8')) as Provenance
    expect(Object.keys(provenance).sort()).toEqual([
      'commit', 'licenseNote', 'repository', 'repositoryLicense', 'repositoryLicenseEvidence', 'sources',
    ])
    expect(provenance.repository).toBe('https://github.com/trustless-ai/agent-ercs')
    expect(provenance.commit).toBe(pinnedCommit)
    expect(provenance.repositoryLicense).toBe('Apache-2.0')
    expect(provenance.repositoryLicenseEvidence).toEqual({
      path: 'LICENSE',
      sourceUrl: `https://raw.githubusercontent.com/trustless-ai/agent-ercs/${pinnedCommit}/LICENSE`,
      sha256: 'c71d239df91726fc519c6eb72d318ec65820627232b2f796219e87dcf35d0ab4',
    })
    expect(sha256(resolve(vendorRoot, 'LICENSE'))).toBe(provenance.repositoryLicenseEvidence.sha256)
    expect(readFileSync(resolve(vendorRoot, 'LICENSE'), 'utf8')).toMatch(/Apache License\s+Version 2\.0/)
    expect(provenance.licenseNote).toMatch(/repository[^.]*Apache-2\.0/i)
    expect(provenance.licenseNote).toMatch(/Solidity[^.]*SPDX[^.]*MIT/i)
    expect(provenance.licenseNote).toMatch(/(?:does not|without)[^.]*determin|not[^.]*legal conclusion/i)

    const sources = [...provenance.sources].sort((left, right) => left.path.localeCompare(right.path))
    expect(sources.map(({ path }) => path)).toEqual(Object.keys(expectedSources).sort())
    for (const source of sources) {
      const expectedDigest = expectedSources[source.path as keyof typeof expectedSources]
      expect(Object.keys(source).sort()).toEqual(['path', 'sha256', 'sourceUrl', 'spdxLicense'])
      expect(source.sha256).toBe(expectedDigest)
      expect(source.spdxLicense).toBe('MIT')
      expect(source.sourceUrl).toBe(`https://raw.githubusercontent.com/trustless-ai/agent-ercs/${pinnedCommit}/${source.path}`)
      expect(sha256(resolve(vendorRoot, source.path))).toBe(expectedDigest)
      expect(readFileSync(resolve(vendorRoot, source.path), 'utf8')).toMatch(/^\/\/ SPDX-License-Identifier: MIT\n/)
    }
  })

  it('vendors no Solidity source beyond the two reviewed interfaces', () => {
    expect(solidityFiles(vendorRoot)).toEqual(Object.keys(expectedSources).sort())
  })

  it('maps the pinned interfaces without requiring a package checkout', () => {
    expect(readFileSync(resolve(demoRoot, 'remappings.txt'), 'utf8')).toBe('@agent-ercs/=vendor/agent-ercs/contracts/\n')
    const foundry = readFileSync(resolve(demoRoot, 'foundry.toml'), 'utf8')
    expect(foundry).not.toMatch(/forge-std|\.\.\/|\/Users\/|[A-Za-z]:\\/)
    expect(foundry).toMatch(/solc_version\s*=\s*"0\.8\.30"/)
  })

  it('keeps the local Foundry test base dependency-free and narrowly scoped', () => {
    const testBase = readFileSync(resolve(demoRoot, 'test/TestBase.sol'), 'utf8')
    expect(testBase).not.toMatch(/^\s*import\b/m)
    expect(testBase).toMatch(/^\/\/ SPDX-License-Identifier: MIT\npragma solidity \^0\.8\.30;/)
    expect(testBase).toMatch(/interface Vm/)
    expect(testBase).toMatch(/abstract contract TestBase/)
    expect(testBase).not.toMatch(/contract Workflow|PassThroughVerifier|IAgentWorkflow|IAgentVerifier/)
  })
})
