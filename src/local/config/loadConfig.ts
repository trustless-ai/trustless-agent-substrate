import { readFile } from 'node:fs/promises'
import { parse } from 'smol-toml'
import { getAddress } from 'viem'
import { z } from 'zod'
import { TasError } from '../../core/errors.js'
import type {
  CanonicalDecimal,
  ChatSourceConfig,
  ChatTargetConfig,
  EvmAddress,
  ProofProviderConfig,
  ResolvedChainConfig,
  ResolvedTasConfig,
} from './types.js'

const modeSchema = z.enum(['identity_setup', 'tawg_setup', 'member'])
const identitySetupSchema = z.object({
  chain_id: z.string(),
  identity_registry_address: z.string(),
}).strict()
const tawgSetupSchema = z.object({
  chain_id: z.string(),
  tawg_address: z.string(),
}).strict()
const instanceSchema = z.object({
  chain_id: z.string(),
  tawg_address: z.string(),
  agent_id: z.string(),
}).strict()
const chainSchema = z.object({
  family: z.string(),
  rpc_url: z.string().optional(),
  rpc_url_env: z.string().optional(),
}).strict()
const repositorySchema = z.object({ client: z.string() }).strict()
const daSchema = z.object({ client: z.string() }).strict()
const sourceSchema = z.object({
  name: z.string(),
  platform: z.string(),
  poll_interval: z.string().optional(),
}).strict()
const targetSchema = z.object({
  name: z.string(),
  source: z.string(),
  conversation_id: z.string(),
}).strict()
const chatSchema = z.object({
  sources: z.array(sourceSchema),
  targets: z.array(targetSchema),
}).strict()
const providerSchema = z.object({
  name: z.string(),
  type: z.string(),
  integration: z.string(),
  base_url: z.string(),
}).strict()
const rootSchema = z.object({
  config_version: z.unknown().optional(),
  mode: z.unknown().optional(),
  identity_setup: z.unknown().optional(),
  tawg_setup: z.unknown().optional(),
  instance: z.unknown().optional(),
  chain: z.unknown().optional(),
  repository: z.unknown().optional(),
  da: z.unknown().optional(),
  chat: z.unknown().optional(),
  proof_providers: z.unknown().optional(),
}).strict()

const UINT256_MAX = (1n << 256n) - 1n
const ZERO_ADDRESS = `0x${'0'.repeat(40)}`
const stableName = /^[a-z][a-z0-9_-]{0,63}$/
const envName = /^[A-Za-z_][A-Za-z0-9_]*$/
const decimal = /^(0|[1-9][0-9]*)$/
const duration = /^(0|[1-9][0-9]*)(ms|s|m)$/

type ParsedRoot = z.infer<typeof rootSchema>
type UnresolvedChainConfig =
  | { readonly family: 'evm'; readonly rpcSource: 'config'; readonly rpcUrl: string }
  | { readonly family: 'evm'; readonly rpcSource: 'environment'; readonly variable: string }
type ProjectedTasConfig =
  | Omit<Extract<ResolvedTasConfig, { readonly mode: 'identity_setup' }>, 'chain'> & { readonly chain: UnresolvedChainConfig }
  | Omit<Extract<ResolvedTasConfig, { readonly mode: 'tawg_setup' }>, 'chain'> & { readonly chain: UnresolvedChainConfig }
  | Omit<Extract<ResolvedTasConfig, { readonly mode: 'member' }>, 'chain'> & { readonly chain: UnresolvedChainConfig }

function fieldError(field: string): TasError {
  return new TasError('CONFIG_FIELD_INVALID', `Invalid configuration field: ${field}`, { field })
}

function conflictError(field: string): TasError {
  return new TasError('CONFIG_CONFLICT', `Conflicting configuration: ${field}`, { field })
}

function referenceError(field: string): TasError {
  return new TasError('CONFIG_REFERENCE_INVALID', `Invalid configuration reference: ${field}`, { field })
}

function unsupportedError(field: string): TasError {
  return new TasError('CONFIG_CLIENT_UNSUPPORTED', `Unsupported configuration client: ${field}`, { field })
}

function parseWithSchema<T>(schema: z.ZodType<T>, value: unknown, field: string): T {
  const result = schema.safeParse(value)
  if (!result.success) throw fieldError(field)
  return result.data
}

function canonicalDecimal(value: string, field: string, allowZero: boolean): CanonicalDecimal {
  if (!decimal.test(value)) throw fieldError(field)
  const number = BigInt(value)
  if ((!allowZero && number === 0n) || number > UINT256_MAX) throw fieldError(field)
  return value
}

function evmAddress(value: string, field: string): EvmAddress {
  try {
    const normalized = getAddress(value)
    if (normalized.toLowerCase() === ZERO_ADDRESS) throw fieldError(field)
    return normalized
  } catch (error) {
    if (error instanceof TasError) throw error
    throw fieldError(field)
  }
}

function noCredentialsUrl(value: string, field: string): string {
  try {
    const url = new URL(value)
    if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.username !== '' || url.password !== '') {
      throw fieldError(field)
    }
    return value
  } catch (error) {
    if (error instanceof TasError) throw error
    throw fieldError(field)
  }
}

function projectChain(raw: unknown): UnresolvedChainConfig {
  const chain = parseWithSchema(chainSchema, raw, 'chain')
  if (chain.family !== 'evm') throw unsupportedError('chain.family')
  const hasUrl = chain.rpc_url !== undefined
  const hasEnv = chain.rpc_url_env !== undefined
  if (hasUrl === hasEnv) throw conflictError('chain.rpc_url')
  if (chain.rpc_url !== undefined) {
    return { family: 'evm', rpcUrl: noCredentialsUrl(chain.rpc_url, 'chain.rpc_url'), rpcSource: 'config' }
  }

  const variable = chain.rpc_url_env as string
  if (!envName.test(variable)) throw fieldError('chain.rpc_url_env')
  return { family: 'evm', variable, rpcSource: 'environment' }
}

function resolveChain(
  chain: UnresolvedChainConfig,
  environment: Readonly<Record<string, string | undefined>>,
): ResolvedChainConfig {
  if (chain.rpcSource === 'config') {
    return { family: 'evm', rpcUrl: chain.rpcUrl, rpcSource: 'config' }
  }

  let rpcUrl: string | undefined
  try {
    rpcUrl = environment[chain.variable]
  } catch {
    throw new TasError('CONFIG_ENV_REQUIRED', `Required configuration environment variable is unavailable: ${chain.variable}`, { variable: chain.variable })
  }
  if (rpcUrl === undefined || rpcUrl === '') {
    throw new TasError('CONFIG_ENV_REQUIRED', `Required configuration environment variable is missing: ${chain.variable}`, { variable: chain.variable })
  }
  try {
    const url = new URL(rpcUrl)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('invalid protocol')
  } catch {
    throw fieldError('chain.rpc_url_env')
  }
  return { family: 'evm', rpcUrl, rpcSource: 'environment' }
}

function uniqueNames(values: readonly { readonly name: string }[], field: string): void {
  const names = new Set<string>()
  for (const value of values) {
    if (!stableName.test(value.name) || names.has(value.name)) throw fieldError(field)
    names.add(value.name)
  }
}

function pollInterval(value: string): string {
  const match = duration.exec(value)
  if (match === null) throw fieldError('chat.sources.poll_interval')
  const amount = BigInt(match[1])
  const multiplier = match[2] === 'ms' ? 1n : match[2] === 's' ? 1_000n : 60_000n
  const milliseconds = amount * multiplier
  if (milliseconds < 1_000n || milliseconds > 60_000n) throw fieldError('chat.sources.poll_interval')
  return value
}

function resolveChat(raw: unknown): { readonly sources: readonly ChatSourceConfig[]; readonly targets: readonly ChatTargetConfig[] } {
  if (raw === undefined) return { sources: [], targets: [] }
  const chat = parseWithSchema(chatSchema, raw, 'chat')
  const sources = chat.sources.map((source): ChatSourceConfig => {
    if (source.platform !== 'telegram' && source.platform !== 'discord') throw unsupportedError('chat.sources.platform')
    return { name: source.name, platform: source.platform, pollInterval: pollInterval(source.poll_interval ?? '6s') }
  })
  const targets = chat.targets.map((target): ChatTargetConfig => {
    if (!stableName.test(target.name) || target.conversation_id === '') throw fieldError('chat.targets')
    return { name: target.name, source: target.source, conversationId: target.conversation_id }
  })
  uniqueNames(sources, 'chat.sources')
  uniqueNames(targets, 'chat.targets')
  const sourceNames = new Set(sources.map(({ name }) => name))
  const destinations = new Set<string>()
  const sourcesWithTargets = new Set<string>()
  for (const target of targets) {
    if (!sourceNames.has(target.source)) throw referenceError('chat.targets.source')
    const destination = `${target.source}\u0000${target.conversationId}`
    if (destinations.has(destination)) throw fieldError('chat.targets')
    destinations.add(destination)
    sourcesWithTargets.add(target.source)
  }
  if ((sources.length === 0) !== (targets.length === 0)) throw referenceError('chat')
  if (sources.some(({ name }) => !sourcesWithTargets.has(name))) throw referenceError('chat.sources')
  return { sources, targets }
}

function resolveProofProviders(raw: unknown): readonly ProofProviderConfig[] {
  if (raw === undefined) return []
  const providers = parseWithSchema(z.array(providerSchema), raw, 'proof_providers')
  uniqueNames(providers, 'proof_providers')
  return providers.map((provider): ProofProviderConfig => {
    if (provider.type !== 'attestation' || provider.integration === '') throw unsupportedError('proof_providers')
    noCredentialsUrl(provider.base_url, 'proof_providers.base_url')
    throw unsupportedError('proof_providers.integration')
  })
}

function validateRoot(parsed: unknown): ParsedRoot {
  const root = parseWithSchema(rootSchema, parsed, 'root')
  if (root.config_version !== 1) {
    throw new TasError('CONFIG_VERSION_UNSUPPORTED', 'Unsupported configuration version', { field: 'config_version' })
  }
  if (modeSchema.safeParse(root.mode).success === false) throw fieldError('mode')
  if (root.chain === undefined) throw fieldError('chain')
  return root
}

function phase(root: ParsedRoot): 'identity_setup' | 'tawg_setup' | 'member' {
  const tables = [root.identity_setup, root.tawg_setup, root.instance].filter((value) => value !== undefined)
  if (tables.length !== 1) throw conflictError('phase')
  return root.mode as 'identity_setup' | 'tawg_setup' | 'member'
}

function validatePhaseConfiguration(root: ParsedRoot, selectedPhase: 'identity_setup' | 'tawg_setup' | 'member'): void {
  if (selectedPhase === 'identity_setup') {
    if (root.mode !== 'identity_setup' || root.identity_setup === undefined || root.repository !== undefined || root.da !== undefined || root.chat !== undefined || root.proof_providers !== undefined) {
      throw conflictError('identity_setup')
    }
    return
  }
  if (selectedPhase === 'tawg_setup') {
    if (root.mode !== 'tawg_setup' || root.tawg_setup === undefined || root.repository !== undefined || root.da !== undefined || root.chat !== undefined || root.proof_providers !== undefined) {
      throw conflictError('tawg_setup')
    }
    return
  }
  if (root.mode !== 'member' || root.instance === undefined) throw conflictError('member')
  if (root.repository === undefined || root.da === undefined) throw fieldError('member.client')
}

function projectConfig(root: ParsedRoot): ProjectedTasConfig {
  const selectedPhase = phase(root)
  validatePhaseConfiguration(root, selectedPhase)
  const chain = projectChain(root.chain)

  if (selectedPhase === 'identity_setup') {
    const identity = parseWithSchema(identitySetupSchema, root.identity_setup, 'identity_setup')
    return {
      configVersion: 1,
      mode: 'identity_setup',
      identitySetup: {
        chainId: canonicalDecimal(identity.chain_id, 'identity_setup.chain_id', false),
        identityRegistryAddress: evmAddress(identity.identity_registry_address, 'identity_setup.identity_registry_address'),
      },
      chain,
    }
  }

  if (selectedPhase === 'tawg_setup') {
    const tawg = parseWithSchema(tawgSetupSchema, root.tawg_setup, 'tawg_setup')
    return {
      configVersion: 1,
      mode: 'tawg_setup',
      tawgSetup: {
        chainId: canonicalDecimal(tawg.chain_id, 'tawg_setup.chain_id', false),
        tawgAddress: evmAddress(tawg.tawg_address, 'tawg_setup.tawg_address'),
      },
      chain,
    }
  }

  const instance = parseWithSchema(instanceSchema, root.instance, 'instance')
  const repository = parseWithSchema(repositorySchema, root.repository, 'repository')
  const da = parseWithSchema(daSchema, root.da, 'da')
  if (repository.client !== 'github') throw unsupportedError('repository.client')
  if (da.client !== 'git') throw unsupportedError('da.client')
  return {
    configVersion: 1,
    mode: 'member',
    instance: {
      chainId: canonicalDecimal(instance.chain_id, 'instance.chain_id', false),
      tawgAddress: evmAddress(instance.tawg_address, 'instance.tawg_address'),
      agentId: canonicalDecimal(instance.agent_id, 'instance.agent_id', true),
    },
    chain,
    repository: { client: 'github' },
    da: { client: 'git' },
    chat: resolveChat(root.chat),
    proofProviders: resolveProofProviders(root.proof_providers),
  }
}

function resolveConfig(
  projected: ProjectedTasConfig,
  environment: Readonly<Record<string, string | undefined>>,
): ResolvedTasConfig {
  return { ...projected, chain: resolveChain(projected.chain, environment) }
}

export async function loadTasConfig(
  path: string,
  environment: Readonly<Record<string, string | undefined>>,
): Promise<ResolvedTasConfig> {
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new TasError('CONFIG_FILE_NOT_FOUND', 'Configuration file was not found')
    }
    throw new TasError('CONFIG_PARSE_FAILED', 'Configuration file could not be read')
  }

  let parsed: unknown
  try {
    parsed = parse(text)
  } catch {
    throw new TasError('CONFIG_PARSE_FAILED', 'Configuration file could not be parsed')
  }
  const root = validateRoot(parsed)
  return resolveConfig(projectConfig(root), environment)
}
