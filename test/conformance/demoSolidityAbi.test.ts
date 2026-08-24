import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

const repositoryRoot = fileURLToPath(new URL('../../', import.meta.url))
const demoRoot = join(repositoryRoot, 'tawg/demo')

interface AbiEntry {
  readonly type: string
  readonly name?: string
  readonly inputs?: readonly unknown[]
  readonly outputs?: readonly unknown[]
  readonly stateMutability?: string
  readonly anonymous?: boolean
}

function inspectAbi(contract: string, output: string, cache: string): readonly AbiEntry[] {
  const json = execFileSync('forge', [
    'inspect', '--root', demoRoot, '--out', output, '--cache-path', cache, contract, 'abi', '--json',
  ], { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024, timeout: 120_000 })
  return JSON.parse(json) as readonly AbiEntry[]
}

function assertExactInheritedAbi(implementation: readonly AbiEntry[], standard: readonly AbiEntry[]): void {
  const required = standard.filter(({ type }) => type === 'function' || type === 'event')
  const names = new Set(required.map(({ type, name }) => `${type}:${name}`))
  const inherited = implementation.filter(({ type, name }) => names.has(`${type}:${name}`))
  expect(inherited).toHaveLength(required.length)
  for (const expected of required) {
    const matches = inherited.filter(({ type, name }) => type === expected.type && name === expected.name)
    expect(matches, `${expected.type} ${expected.name} must appear exactly once`).toEqual([expected])
  }
}

describe('Demo Solidity ABI conformance', () => {
  it('matches every inherited ERC-8301 function and event metadata exactly', () => {
    const directory = mkdtempSync(join(tmpdir(), 'tas-demo-abi-'))
    try {
      const output = join(directory, 'out')
      const cache = join(directory, 'cache')
      const inspect = (contract: string): readonly AbiEntry[] => inspectAbi(contract, output, cache)
      assertExactInheritedAbi(inspect('Workflow'), inspect('IAgentWorkflow'))
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('matches the ERC-8274 verifier function and event metadata exactly', () => {
    const directory = mkdtempSync(join(tmpdir(), 'tas-demo-abi-'))
    try {
      const output = join(directory, 'out')
      const cache = join(directory, 'cache')
      const inspect = (contract: string): readonly AbiEntry[] => inspectAbi(contract, output, cache)
      assertExactInheritedAbi(inspect('PassThroughVerifier'), inspect('IAgentVerifier'))
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })
})
