import type { PlainJsonValue } from '../json/plainJson.js'
import type {
  AttestationAdapterManifest,
  AttestationGenerateRequest,
  AttestationValidateRequest,
  AttestationValidation,
} from './types.js'

/**
 * A reviewed, composition-root-bundled Attestation Provider implementation.
 * Implementations receive credentials only in an individual generate call.
 */
export interface AttestationAdapter {
  readonly manifest: AttestationAdapterManifest
  generate(request: AttestationGenerateRequest): Promise<PlainJsonValue>
  validate(request: AttestationValidateRequest): Promise<AttestationValidation>
}
