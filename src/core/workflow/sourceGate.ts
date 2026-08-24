import { TasError } from '../errors.js'
import type {
  MutableWorkflowVerificationGate,
  VerifiedWorkflowContext,
} from './types.js'

export interface WorkflowSourceGateOptions {
  readonly resolveCurrent: (signal?: AbortSignal) => Promise<VerifiedWorkflowContext>
}

function verificationRequired(): never {
  throw new TasError(
    'WORKFLOW_SOURCE_VERIFICATION_REQUIRED',
    'The current Workflow source must be verified before this operation can run.',
  )
}

function sameContext(left: VerifiedWorkflowContext, right: VerifiedWorkflowContext): boolean {
  return left.fingerprint === right.fingerprint
    && left.chainId === right.chainId
    && left.rpcUrl === right.rpcUrl
    && left.workflowAddress.toLowerCase() === right.workflowAddress.toLowerCase()
}

function snapshot(context: VerifiedWorkflowContext): VerifiedWorkflowContext {
  if (context.blockSelector.kind !== 'block_hash') {
    return verificationRequired()
  }
  return Object.freeze({
    chainId: context.chainId,
    rpcUrl: context.rpcUrl,
    workflowAddress: context.workflowAddress,
    blockSelector: Object.freeze({ ...context.blockSelector }),
    fingerprint: context.fingerprint,
  })
}

export function createWorkflowSourceGate(options: WorkflowSourceGateOptions): MutableWorkflowVerificationGate {
  const resolveCurrent = options.resolveCurrent
  let accepted: VerifiedWorkflowContext | undefined
  let revision = 0

  return Object.freeze({
    accept(context: VerifiedWorkflowContext): void {
      accepted = snapshot(context)
      revision += 1
    },
    assertAccepted(context: VerifiedWorkflowContext): VerifiedWorkflowContext {
      const expected = accepted
      if (expected === undefined) return verificationRequired()
      const selected = snapshot(context)
      if (!sameContext(expected, selected)) {
        accepted = undefined
        revision += 1
        return verificationRequired()
      }
      return selected
    },
    invalidate(): void {
      accepted = undefined
      revision += 1
    },
    async assertCurrent(signal?: AbortSignal): Promise<VerifiedWorkflowContext> {
      const expected = accepted
      const expectedRevision = revision
      if (expected === undefined) return verificationRequired()
      const current = snapshot(await resolveCurrent(signal))
      if (revision !== expectedRevision || accepted !== expected) return verificationRequired()
      if (!sameContext(expected, current)) {
        accepted = undefined
        revision += 1
        return verificationRequired()
      }
      return current
    },
  })
}
