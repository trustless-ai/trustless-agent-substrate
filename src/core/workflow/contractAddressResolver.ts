import { TasError } from '../errors.js'
import type {
  VerifiedWorkflowContext,
  WorkflowContractAddressResolver,
} from './types.js'
import type { GeneratedToolEntry } from '../../mcp/manifest/types.js'

/**
 * Resolves only contracts whose address is an authority of the verified
 * Profile Workflow descriptor. Other ERC namespaces require an explicit
 * Profile-backed address source before TAS can expose their bindings.
 */
export function createWorkflowContractAddressResolver(): WorkflowContractAddressResolver {
  return Object.freeze({
    async resolve(entry: GeneratedToolEntry, context: VerifiedWorkflowContext) {
      if (entry.source.entrypoint === './execution/ERC8301') return context.workflowAddress
      throw new TasError(
        'MANIFEST_BINDING_UNSUPPORTED',
        'The requested Workflow binding has no authoritative contract address.',
      )
    },
  })
}
