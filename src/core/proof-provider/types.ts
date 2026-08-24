import type { PlainJsonValue } from '../json/plainJson.js'

/** Inline credential supplied for exactly one Provider generation operation. */
export interface ProofProviderCredential {
  readonly type: 'inline'
  readonly secret: string
}

/** Reviewed public metadata for one bundled Attestation Provider adapter. */
export interface AttestationAdapterManifest {
  readonly provider: string
  readonly type: 'attestation'
  readonly operations_namespace: string
  readonly operations: readonly ['generate', 'validate']
}

export interface AttestationGenerateRequest {
  readonly input: PlainJsonValue
  readonly credential: ProofProviderCredential
  readonly signal: AbortSignal
}

export interface AttestationValidateRequest {
  readonly proof: PlainJsonValue
  readonly signal: AbortSignal
}

/** A false result is a completed validation, not a Provider transport failure. */
export interface AttestationValidation {
  readonly valid: boolean
  readonly reason: string
}
