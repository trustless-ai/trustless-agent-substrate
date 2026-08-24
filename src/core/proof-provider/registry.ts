import { z } from 'zod'

import type { AttestationAdapter } from './adapter.js'
import type { AttestationAdapterManifest } from './types.js'

const bundledAdapter = Symbol('bundledAdapter')
const providerNameSchema = z.string().regex(/^[a-z][a-z0-9_]{0,63}$/)
const manifestSchema = z.object({
  provider: providerNameSchema,
  type: z.literal('attestation'),
  operations_namespace: z.string(),
  operations: z.tuple([z.literal('generate'), z.literal('validate')]),
}).strict()

export interface BundledAttestationAdapter {
  readonly manifest: AttestationAdapterManifest
  readonly adapter: AttestationAdapter
  readonly [bundledAdapter]: true
}

function invalidBundle(): never {
  throw new TypeError('Invalid Proof Provider adapter bundle.')
}

function reviewedManifest(manifest: unknown): AttestationAdapterManifest {
  let parsed: z.infer<typeof manifestSchema>
  try { parsed = manifestSchema.parse(manifest) } catch { return invalidBundle() }
  if (parsed.operations_namespace !== `proof_provider.attestation.${parsed.provider}`) invalidBundle()
  return Object.freeze({
    provider: parsed.provider,
    type: parsed.type,
    operations_namespace: parsed.operations_namespace,
    operations: Object.freeze(['generate', 'validate']) as readonly ['generate', 'validate'],
  })
}

function sameManifest(left: AttestationAdapterManifest, right: AttestationAdapterManifest): boolean {
  return left.provider === right.provider
    && left.type === right.type
    && left.operations_namespace === right.operations_namespace
    && left.operations.length === 2
    && right.operations.length === 2
    && left.operations[0] === 'generate'
    && left.operations[1] === 'validate'
    && right.operations[0] === 'generate'
    && right.operations[1] === 'validate'
}

function publicManifest(manifest: AttestationAdapterManifest): AttestationAdapterManifest {
  return {
    provider: manifest.provider,
    type: manifest.type,
    operations_namespace: manifest.operations_namespace,
    operations: ['generate', 'validate'],
  }
}

function reviewedAdapter(adapter: unknown): AttestationAdapter {
  try {
    if (adapter === null || typeof adapter !== 'object') return invalidBundle()
    const candidate = adapter as Partial<AttestationAdapter>
    if (typeof candidate.generate !== 'function' || typeof candidate.validate !== 'function') return invalidBundle()
    reviewedManifest(candidate.manifest)
    return candidate as AttestationAdapter
  } catch { return invalidBundle() }
}

/** Pairs a composition-root implementation with the reviewed metadata it implements. */
export function bundleAttestationAdapter(
  manifest: AttestationAdapterManifest,
  adapter: AttestationAdapter,
): BundledAttestationAdapter {
  const reviewed = reviewedManifest(manifest)
  const implementation = reviewedAdapter(adapter)
  if (!sameManifest(reviewed, reviewedManifest(implementation.manifest))) invalidBundle()
  return Object.freeze({ manifest: reviewed, adapter: implementation, [bundledAdapter]: true as const })
}

/** Immutable Provider discovery for adapters selected only by the composition root. */
export class ProofProviderRegistry {
  readonly #attestations: ReadonlyMap<string, BundledAttestationAdapter>

  constructor(bundledAdapters: readonly BundledAttestationAdapter[] = []) {
    const entries = new Map<string, BundledAttestationAdapter>()
    for (const bundle of bundledAdapters) {
      if (bundle[bundledAdapter] !== true) invalidBundle()
      const manifest = reviewedManifest(bundle.manifest)
      const adapter = reviewedAdapter(bundle.adapter)
      if (!sameManifest(manifest, reviewedManifest(adapter.manifest)) || entries.has(manifest.provider)) invalidBundle()
      entries.set(manifest.provider, Object.freeze({ manifest, adapter, [bundledAdapter]: true as const }))
    }
    this.#attestations = entries
  }

  listAttestations(): readonly AttestationAdapterManifest[] {
    return Object.freeze([...this.#attestations.values()].map(({ manifest }) => Object.freeze(publicManifest(manifest))))
  }

  getAttestation(provider: string): AttestationAdapter | undefined {
    return this.#attestations.get(provider)?.adapter
  }
}

/** Creates the default empty production registry, or a composition-root bundle for integration tests. */
export function createProofProviderRegistry(
  bundledAdapters: readonly BundledAttestationAdapter[] = [],
): ProofProviderRegistry {
  return new ProofProviderRegistry(bundledAdapters)
}
