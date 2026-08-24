import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import { createSolcCompiler } from '../../src/clients/workflow/solcCompiler.js'
import type { RepositoryContentClient } from '../../src/core/repository/client.js'
import { createWorkflowSourceResolver } from '../../src/core/workflow/sourceResolver.js'
import { createWorkflowSourceVerifier } from '../../src/core/workflow/sourceVerifier.js'

const fixtureRoot = fileURLToPath(new URL('../fixtures/workflow/repository/', import.meta.url))
const repository = 'https://github.com/trustless-ai/demo-tawg'
const workflowCommit = 'b'.repeat(40)
const blockHash = `0x${'c'.repeat(64)}` as const
const workflowAddress = '0x4000000000000000000000000000000000000004'
const deployedRuntime = '0x60806040525f5ffdfea26469706673582212202bc854b8f014573d5df2486e18fbe5139d93a28c744b27d1e37043a83571ab1364736f6c634300081e0033' as const

describe('Workflow source authority to deployed-runtime verification', () => {
  it('passes an exact multi-source Repository resolution directly through bundled solc verification', async () => {
    const profileResolver = {
      binding: { chainId: '31337', tawgAddress: '0x1000000000000000000000000000000000000001' as const },
      async get() {
        return {
          data: {
            version: '7',
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
          resolution: { chain: { block_number: '42', block_hash: blockHash }, profile: { version: '7' } },
        }
      },
    }
    const contentClient: Pick<RepositoryContentClient, 'readFile'> = {
      async readFile(_source, commit, path) {
        return { path, commit, bytes: new Uint8Array(readFileSync(resolve(fixtureRoot, path))) }
      },
    }
    const sourceResolver = createWorkflowSourceResolver({ profileResolver, contentClient })
    const selected = await sourceResolver.resolve({ kind: 'block_hash', blockHash })
    const verifier = createWorkflowSourceVerifier({
      compiler: createSolcCompiler({ timeoutMs: 20_000 }),
      codeReader: {
        async readCode() { return deployedRuntime },
      },
    })

    await expect(verifier.verify(selected)).resolves.toMatchObject({
      valid: true,
      reason: 'verified',
      context: { blockHash, workflowAddress, commit: workflowCommit },
    })
  }, 30_000)
})
