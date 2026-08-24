import { describe, expect, it } from 'vitest'

import { bundleAttestationAdapter, createProofProviderRegistry } from '../../../src/core/proof-provider/registry.js'
import { FakeAttestationAdapter } from '../../fakes/proof-provider/fakeAttestationAdapter.js'

const manifest = {
  provider: 'fixture_attestor',
  type: 'attestation',
  operations_namespace: 'proof_provider.attestation.fixture_attestor',
  operations: ['generate', 'validate'],
} as const

describe('Proof Provider adapter registry', () => {
  it('has no adapters in the production composition', () => {
    expect(createProofProviderRegistry().listAttestations()).toEqual([])
  })

  it('discovers only a bundled adapter paired with its reviewed manifest', () => {
    const adapter = new FakeAttestationAdapter(manifest)
    const registry = createProofProviderRegistry([bundleAttestationAdapter(manifest, adapter)])

    expect(registry.listAttestations()).toEqual([manifest])
    expect(registry.getAttestation('fixture_attestor')).toBe(adapter)
  })

  it('rejects a bundled adapter whose manifest does not match its reviewed metadata', () => {
    const adapter = new FakeAttestationAdapter(manifest)

    expect(() => bundleAttestationAdapter({
      ...manifest, provider: 'other_attestor', operations_namespace: 'proof_provider.attestation.other_attestor',
    }, adapter)).toThrow('Invalid Proof Provider adapter bundle.')
  })

  it('rejects duplicate provider identities in the composition root bundle', () => {
    const first = new FakeAttestationAdapter(manifest)
    const second = new FakeAttestationAdapter(manifest)

    expect(() => createProofProviderRegistry([
      bundleAttestationAdapter(manifest, first), bundleAttestationAdapter(manifest, second),
    ]))
      .toThrow('Invalid Proof Provider adapter bundle.')
  })

  it('rejects a manifest-bearing object that does not implement both Provider operations', () => {
    expect(() => bundleAttestationAdapter(manifest, { manifest } as never))
      .toThrow('Invalid Proof Provider adapter bundle.')
  })
})
