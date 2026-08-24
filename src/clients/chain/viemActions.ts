import type { Account } from 'viem'

import { TasError } from '../../core/errors.js'
import { getManifestRegistry } from '../../mcp/manifest/registry.js'
import type { ManifestRegistry } from '../../mcp/manifest/registry.js'
import type { GeneratedToolEntry } from '../../mcp/manifest/types.js'

export type ViemAction = (
  client: unknown,
  parameters: Readonly<Record<string, unknown>>,
) => unknown

export interface ViemActionBindings {
  get(entry: GeneratedToolEntry): ViemAction
  accountFromPrivateKey(privateKey: `0x${string}`): Account
}

function unsupported(): never {
  throw new TasError('MANIFEST_BINDING_UNSUPPORTED', 'The requested Chain binding is unavailable.')
}

function exactFunction(module: object, member: string): (...arguments_: never[]) => unknown {
  let descriptor: PropertyDescriptor | undefined
  try {
    descriptor = Object.getOwnPropertyDescriptor(module, member)
  } catch {
    return unsupported()
  }
  if (descriptor === undefined || !('value' in descriptor) || typeof descriptor.value !== 'function') {
    return unsupported()
  }
  return descriptor.value as (...arguments_: never[]) => unknown
}

/**
 * Loads the exact viem members accepted by the process Manifest Registry.
 * viem remains outside the pre-validation module graph: both runtime imports happen
 * only after the supplied registry is proven to be the validated singleton.
 */
export async function loadViemActionBindings(registry: ManifestRegistry): Promise<ViemActionBindings> {
  if (registry !== getManifestRegistry()) return unsupported()

  const groups = [
    { entries: registry.list('viem-public'), sourceExport: 'PublicActions' as const },
    { entries: registry.list('viem-wallet'), sourceExport: 'WalletActions' as const },
  ]
  const entries = groups.flatMap(({ entries: groupEntries }) => groupEntries)
  let actionModule: object
  let accountModule: object
  try {
    ;[actionModule, accountModule] = await Promise.all([
      import('viem/actions'),
      import('viem/accounts'),
    ])
  } catch {
    return unsupported()
  }

  const byEntry = new Map<GeneratedToolEntry, ViemAction>()
  for (const group of groups) {
    for (const entry of group.entries) {
      const sourceExport = group.sourceExport
      if (registry.get(entry.name) !== entry
        || entry.source.entrypoint !== '.'
        || entry.source.export !== sourceExport
        || entry.binding.kind !== 'client_action'
        || entry.binding.target !== `${sourceExport}.${entry.source.member}`) return unsupported()
      byEntry.set(entry, exactFunction(actionModule, entry.source.member) as ViemAction)
    }
  }
  if (byEntry.size !== entries.length) return unsupported()

  const privateKeyToAccount = exactFunction(accountModule, 'privateKeyToAccount') as (
    privateKey: `0x${string}`,
  ) => Account

  return Object.freeze({
    get(entry: GeneratedToolEntry): ViemAction {
      if (registry.get(entry.name) !== entry) return unsupported()
      const action = byEntry.get(entry)
      return action ?? unsupported()
    },
    accountFromPrivateKey(privateKey: `0x${string}`): Account {
      return privateKeyToAccount(privateKey)
    },
  })
}
