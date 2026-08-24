import { join } from 'node:path'

import type { ResolvedTasConfig } from '../config/types.js'

/**
 * Returns the local process directory for a validated member identity.
 * Setup modes deliberately own no member-local state.
 */
export function memberInstancePath(root: string, identity: ResolvedTasConfig): string | undefined {
  if (identity.mode !== 'member') return undefined

  const { agentId, chainId, tawgAddress } = identity.instance
  return join(root, 'instances', `eip155-${chainId}-${tawgAddress.toLowerCase()}`, 'agents', agentId)
}
