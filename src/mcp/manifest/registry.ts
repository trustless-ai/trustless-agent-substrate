import type { GeneratedToolEntry, ManifestSourceProfile } from './types.js'
import {
  loadBundledAgentSdkManifest,
  loadBundledChatManifests,
  loadBundledViemManifests,
  type LoadedAgentSdkManifest,
  type LoadedChatManifests,
  type LoadedViemManifests,
} from './load.js'

export interface ManifestRegistry {
  list(profile: ManifestSourceProfile): readonly GeneratedToolEntry[]
  get(toolName: string): GeneratedToolEntry | undefined
}

export interface ManifestRegistryLoaders {
  readonly loadViem: () => LoadedViemManifests
  readonly loadAgentSdk: () => LoadedAgentSdkManifest
  readonly loadChat: () => LoadedChatManifests
}

function buildRegistry(loaders: ManifestRegistryLoaders): ManifestRegistry {
  const manifests = loaders.loadViem()
  const agentSdk = loaders.loadAgentSdk()
  const chat = loaders.loadChat()
  const groups: Readonly<Record<ManifestSourceProfile, readonly GeneratedToolEntry[]>> = Object.freeze({
    'agent-sdk': agentSdk.manifest.tools,
    'viem-public': manifests.public.tools,
    'viem-wallet': manifests.wallet.tools,
    telegram: chat.telegram.manifest.tools,
    discord: chat.discord.manifest.tools,
  })
  const byName = new Map<string, GeneratedToolEntry>()
  for (const tools of Object.values(groups)) {
    for (const tool of tools) {
      if (byName.has(tool.name)) throw new Error('TAS_MANIFEST_INVALID: duplicate Registry tool name')
      byName.set(tool.name, tool)
    }
  }
  return Object.freeze({
    list(profile: ManifestSourceProfile): readonly GeneratedToolEntry[] {
      return groups[profile]
    },
    get(toolName: string): GeneratedToolEntry | undefined {
      return byName.get(toolName)
    },
  })
}

let registry: ManifestRegistry | undefined

/** Test-only construction seam; production startup always uses the fixed bundled loaders below. */
export function createManifestRegistryForTest(loaders: ManifestRegistryLoaders): ManifestRegistry {
  return buildRegistry(loaders)
}

export function getManifestRegistry(): ManifestRegistry {
  registry ??= buildRegistry({
    loadViem: loadBundledViemManifests,
    loadAgentSdk: loadBundledAgentSdkManifest,
    loadChat: loadBundledChatManifests,
  })
  return registry
}
