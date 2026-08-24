import { describe, expect, it } from 'vitest'

import { TasError } from '../../../src/core/errors.js'
import { createWorkflowSourceGate } from '../../../src/core/workflow/sourceGate.js'
import type { VerifiedWorkflowContext } from '../../../src/core/workflow/types.js'

const verified: VerifiedWorkflowContext = {
  chainId: '31337',
  rpcUrl: 'http://127.0.0.1:8545',
  workflowAddress: '0x1000000000000000000000000000000000000001',
  blockSelector: { kind: 'block_hash', blockHash: `0x${'a'.repeat(64)}` },
  fingerprint: `sha256:${'b'.repeat(64)}`,
}

function expectCode(code: string) {
  return (error: unknown): boolean => error instanceof TasError && error.code === code
}

describe('Workflow source gate', () => {
  it('accepts an explicitly resolved matching fingerprint without re-resolving current state', () => {
    const gate = createWorkflowSourceGate({ resolveCurrent: async () => verified })
    gate.accept(verified)

    expect(gate.assertAccepted({
      ...verified,
      blockSelector: { kind: 'block_hash', blockHash: `0x${'9'.repeat(64)}` },
    })).toMatchObject({ fingerprint: verified.fingerprint })
  })

  it('invalidates an explicitly resolved mismatching fingerprint', () => {
    const gate = createWorkflowSourceGate({ resolveCurrent: async () => verified })
    gate.accept(verified)

    expect(() => gate.assertAccepted({ ...verified, fingerprint: 'different' }))
      .toThrowError(TasError)
    expect(() => gate.assertAccepted(verified)).toThrowError(TasError)
  })

  it('fails closed until the current source fingerprint has been accepted', async () => {
    const gate = createWorkflowSourceGate({ resolveCurrent: async () => verified })

    await expect(gate.assertCurrent()).rejects.toSatisfy(expectCode('WORKFLOW_SOURCE_VERIFICATION_REQUIRED'))
  })

  it('returns the freshly resolved context only while its accepted fingerprint remains current', async () => {
    let current = verified
    const gate = createWorkflowSourceGate({ resolveCurrent: async () => current })
    gate.accept(verified)

    await expect(gate.assertCurrent()).resolves.toEqual(verified)

    current = { ...verified, fingerprint: `sha256:${'c'.repeat(64)}` }
    await expect(gate.assertCurrent()).rejects.toSatisfy(expectCode('WORKFLOW_SOURCE_VERIFICATION_REQUIRED'))
    current = verified
    await expect(gate.assertCurrent()).rejects.toSatisfy(expectCode('WORKFLOW_SOURCE_VERIFICATION_REQUIRED'))
  })

  it('returns a newer exact block when the verified Workflow fingerprint is unchanged', async () => {
    const newer = {
      ...verified,
      blockSelector: { kind: 'block_hash', blockHash: `0x${'c'.repeat(64)}` } as const,
    }
    const gate = createWorkflowSourceGate({ resolveCurrent: async () => newer })
    gate.accept(verified)

    await expect(gate.assertCurrent()).resolves.toEqual(newer)
  })

  it('rejects a matching fingerprint when the verified execution context changed', async () => {
    const changed = { ...verified, workflowAddress: '0x2000000000000000000000000000000000000002' as const }
    const gate = createWorkflowSourceGate({ resolveCurrent: async () => changed })
    gate.accept(verified)

    await expect(gate.assertCurrent()).rejects.toSatisfy(expectCode('WORKFLOW_SOURCE_VERIFICATION_REQUIRED'))
  })

  it.each([
    { kind: 'latest' },
    { kind: 'safe' },
    { kind: 'finalized' },
    { kind: 'block_number', blockNumber: '42' },
  ])('does not admit the non-hash chain selector $kind as a verified Workflow context', (blockSelector) => {
    const moving = { ...verified, blockSelector } as unknown as VerifiedWorkflowContext
    const gate = createWorkflowSourceGate({ resolveCurrent: async () => moving })

    expect(() => gate.accept(moving)).toThrow()
  })

  it('snapshots an accepted context so later caller mutation cannot move the trust decision', async () => {
    const accepted = {
      ...verified,
      blockSelector: { ...verified.blockSelector },
    } as VerifiedWorkflowContext
    let current = verified
    const gate = createWorkflowSourceGate({ resolveCurrent: async () => current })
    gate.accept(accepted)

    ;(accepted as { fingerprint: string }).fingerprint = `sha256:${'d'.repeat(64)}`
    current = { ...verified, fingerprint: `sha256:${'d'.repeat(64)}` }

    await expect(gate.assertCurrent()).rejects.toSatisfy(expectCode('WORKFLOW_SOURCE_VERIFICATION_REQUIRED'))
  })

  it('rejects an in-flight assertion when the gate is invalidated before resolution completes', async () => {
    let resolveCurrent!: (context: VerifiedWorkflowContext) => void
    const current = new Promise<VerifiedWorkflowContext>((resolve) => { resolveCurrent = resolve })
    const gate = createWorkflowSourceGate({ resolveCurrent: async () => await current })
    gate.accept(verified)

    const pending = gate.assertCurrent()
    gate.invalidate()
    resolveCurrent(verified)

    await expect(pending).rejects.toSatisfy(expectCode('WORKFLOW_SOURCE_VERIFICATION_REQUIRED'))
  })

  it('does not let an older assertion clear a newer accepted verification', async () => {
    let resolveCurrent!: (context: VerifiedWorkflowContext) => void
    const current = new Promise<VerifiedWorkflowContext>((resolve) => { resolveCurrent = resolve })
    let calls = 0
    const gate = createWorkflowSourceGate({
      resolveCurrent: async () => {
        calls += 1
        return calls === 1 ? await current : verified
      },
    })
    gate.accept(verified)

    const pending = gate.assertCurrent()
    gate.accept(verified)
    resolveCurrent({ ...verified, fingerprint: `sha256:${'e'.repeat(64)}` })

    await expect(pending).rejects.toSatisfy(expectCode('WORKFLOW_SOURCE_VERIFICATION_REQUIRED'))
    await expect(gate.assertCurrent()).resolves.toEqual(verified)
  })
})
