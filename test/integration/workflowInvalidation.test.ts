import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import { createSolcCompiler } from '../../src/clients/workflow/solcCompiler.js'
import { TasError } from '../../src/core/errors.js'
import type { RepositoryContentClient } from '../../src/core/repository/client.js'
import { createWorkflowSourceResolver } from '../../src/core/workflow/sourceResolver.js'
import { createWorkflowSourceRuntime } from '../../src/core/workflow/sourceService.js'
import { createWorkflowSourceVerifier } from '../../src/core/workflow/sourceVerifier.js'

const fixtureRoot = fileURLToPath(new URL('../fixtures/workflow/repository/', import.meta.url))
const repository = 'https://github.com/trustless-ai/demo-tawg'
const workflowCommit = 'b'.repeat(40)
const blockHashes = {
  first: `0x${'c'.repeat(64)}`,
  second: `0x${'d'.repeat(64)}`,
} as const
const workflowAddress = '0x4000000000000000000000000000000000000004'
const deployedRuntime = '0x60806040525f5ffdfea26469706673582212202bc854b8f014573d5df2486e18fbe5139d93a28c744b27d1e37043a83571ab1364736f6c634300081e0033' as const

function expectCode(code: string) {
  return (error: unknown): boolean => error instanceof TasError && error.code === code
}

describe('Workflow verification invalidation', () => {
  it('shares one accepted fingerprint across source retrieval and operation gates, then fails closed on runtime change', async () => {
    let profileVersion = '7'
    let blockNumber = '42'
    let blockHash: `0x${string}` = blockHashes.first
    let runtimeCode: `0x${string}` = deployedRuntime
    const profileResolver = {
      binding: { chainId: '31337', tawgAddress: '0x1000000000000000000000000000000000000001' as const },
      async get() {
        return {
          data: {
            version: profileVersion,
            governance: '0x2000000000000000000000000000000000000002',
            charter: { repository, commit: 'a'.repeat(40), path: 'charter/' },
            agents: { identity_registry: '0x3000000000000000000000000000000000000003', agent_ids: [] },
            data: {},
            workflow: {
              address: workflowAddress,
              data: { source: {
                repository,
                commit: workflowCommit,
                sourcePath: 'contracts/Workflow.sol',
                metadataPath: 'contracts/Workflow.metadata.json',
              } },
            },
          },
          resolution: {
            chain: { block_number: blockNumber, block_hash: blockHash },
            profile: { version: profileVersion },
          },
        }
      },
    }
    const contentClient: Pick<RepositoryContentClient, 'readFile'> = {
      async readFile(_source, commit, path) {
        return { path, commit, bytes: new Uint8Array(readFileSync(resolve(fixtureRoot, path))) }
      },
    }
    const resolver = createWorkflowSourceResolver({ profileResolver, contentClient })
    const runtime = createWorkflowSourceRuntime({
      resolver,
      verifier: createWorkflowSourceVerifier({
        compiler: createSolcCompiler({ timeoutMs: 20_000 }),
        codeReader: { async readCode() { return runtimeCode } },
      }),
      rpcUrl: 'http://127.0.0.1:8545',
      timeoutMs: 25_000,
    })

    try {
      await expect(runtime.service.get()).rejects.toSatisfy(expectCode('WORKFLOW_SOURCE_VERIFICATION_REQUIRED'))
      const verified = await runtime.service.verify()
      expect(verified).toMatchObject({ valid: true, reason: 'verified' })
      await expect(runtime.service.get()).resolves.toMatchObject({
        fingerprint: verified.fingerprint,
        sourceContent: expect.stringContaining('contract Workflow'),
      })
      await expect(runtime.gate.assertCurrent()).resolves.toMatchObject({ fingerprint: verified.fingerprint })

      // Profile/block movement alone does not change the immutable Workflow material.
      profileVersion = '8'
      blockNumber = '43'
      blockHash = blockHashes.second
      await expect(runtime.gate.assertCurrent()).resolves.toMatchObject({ fingerprint: verified.fingerprint })

      runtimeCode = '0x6000'
      await expect(runtime.gate.assertCurrent()).rejects.toSatisfy(expectCode('WORKFLOW_SOURCE_VERIFICATION_REQUIRED'))
      await expect(runtime.service.get()).rejects.toSatisfy(expectCode('WORKFLOW_SOURCE_VERIFICATION_REQUIRED'))
    } finally {
      await runtime.close()
    }
  }, 35_000)
})
