import type { AttestationAdapter } from '../../../src/core/proof-provider/adapter.js'
import type {
  AttestationAdapterManifest,
  AttestationGenerateRequest,
  AttestationValidateRequest,
  AttestationValidation,
} from '../../../src/core/proof-provider/types.js'
import type { PlainJsonValue } from '../../../src/core/json/plainJson.js'

/** Test-only offline Provider adapter. It intentionally has no MCP namespace of its own. */
export class FakeAttestationAdapter implements AttestationAdapter {
  readonly generateCalls: AttestationGenerateRequest[] = []
  readonly validateCalls: AttestationValidateRequest[] = []
  generateFailure?: Error

  constructor(readonly manifest: AttestationAdapterManifest) {}

  async generate(request: AttestationGenerateRequest): Promise<PlainJsonValue> {
    this.generateCalls.push(request)
    if (this.generateFailure !== undefined) throw this.generateFailure
    return { proof: request.input }
  }

  async validate(request: AttestationValidateRequest): Promise<AttestationValidation> {
    this.validateCalls.push(request)
    const verdict = request.proof !== null && typeof request.proof === 'object' && !Array.isArray(request.proof)
      ? request.proof.verdict
      : undefined
    return verdict === 'valid'
      ? { valid: true, reason: 'verified by fixture' }
      : { valid: false, reason: 'fixture rejected proof' }
  }

  retainedOperationState(): { readonly credentials: 0; readonly proofs: 0 } {
    return { credentials: 0, proofs: 0 }
  }
}
