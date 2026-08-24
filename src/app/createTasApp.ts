import { homedir } from 'node:os'
import { join } from 'node:path'

import type { McpServerFactory } from '@modelcontextprotocol/server'
import { serveStdio, type ServeStdioOptions, type StdioServerHandle } from '@modelcontextprotocol/server/stdio'
import { createPublicClient, createWalletClient, defineChain, http, type PublicClient, type WalletClient } from 'viem'

import { loadViemActionBindings } from '../clients/chain/viemActions.js'
import { createViemProfileReader } from '../clients/chain/viemProfileReader.js'
import { createGitDaClient } from '../clients/da/gitDaClient.js'
import { createGitHubRepositoryClient } from '../clients/repository/githubRepositoryClient.js'
import { createGitHubRequest } from '../clients/repository/githubRequest.js'
import { createAgentSdkBindingClient, type AgentSdkBindingClient } from '../clients/workflow/agentSdkClient.js'
import { createSolcCompiler } from '../clients/workflow/solcCompiler.js'
import { createViemWorkflowCodeReader } from '../clients/workflow/viemWorkflowCodeReader.js'
import { TasError } from '../core/errors.js'
import { createChatService, type ChatService } from '../core/chat/service.js'
import type { ChatClientFactory, ChatPlatform } from '../core/chat/types.js'
import { createProofProviderRegistry, type ProofProviderRegistry } from '../core/proof-provider/registry.js'
import type { DaClient } from '../core/da/client.js'
import { createDaService } from '../core/da/service.js'
import { ProfileResolver } from '../core/profile/resolver.js'
import type { RepositoryClient } from '../core/repository/client.js'
import { createRepositoryResolver } from '../core/repository/resolver.js'
import { createRepositoryService } from '../core/repository/service.js'
import { createRoleSkillLoader, createTawgSkillLoader } from '../core/skill/loader.js'
import { loadBundledCollaborationSkill } from '../core/skill/collaborationSkill.js'
import { loadBundledTasSkill } from '../core/skill/tasSkill.js'
import { createChainService } from '../core/workflow/chainService.js'
import { createWorkflowContractAddressResolver } from '../core/workflow/contractAddressResolver.js'
import { createWorkflowOperationService } from '../core/workflow/operationService.js'
import { createWorkflowSourceResolver } from '../core/workflow/sourceResolver.js'
import { createWorkflowSourceRuntime, type WorkflowSourceRuntime } from '../core/workflow/sourceService.js'
import { createWorkflowSourceVerifier } from '../core/workflow/sourceVerifier.js'
import type { WorkflowCodeReader } from '../core/workflow/sourceVerifier.js'
import { loadTasConfig } from '../local/config/loadConfig.js'
import type { ResolvedTasConfig } from '../local/config/types.js'
import { acquireMemberLock } from '../local/instance/lock.js'
import { memberInstancePath } from '../local/instance/paths.js'
import type { TasPublicInstance } from '../mcp/results.js'
import { isChatGeneratedToolEntry, type ChatGeneratedToolEntry } from '../mcp/generatedChatTools.js'
import { getManifestRegistry } from '../mcp/manifest/registry.js'
import { createTasMcpServer } from '../mcp/server.js'

type ServeStdio = (factory: McpServerFactory, options?: ServeStdioOptions) => StdioServerHandle

export interface CreateTasAppDependencies {
  /** Test-only process environment seam. */
  readonly environment?: Readonly<Record<string, string | undefined>>
  /** Test-only root for the release bundle. */
  readonly packageRoot?: string
  /** Test-only root replacing ~/.tas for member state. */
  readonly stateRoot?: string
  /** Test-only Chain Client construction seam. */
  readonly createChainClient?: (chainId: number, rpcUrl: string) => PublicClient
  /** Test-only connection-only Wallet Client construction seam. */
  readonly createWalletChainClient?: (chainId: number, rpcUrl: string) => WalletClient
  /** Test-only member lock seam. */
  readonly acquireLock?: (memberDirectory: string) => Promise<() => Promise<void>>
  /** Test-only stdio serving seam. */
  readonly serve?: ServeStdio
  /** Test-only deployed Workflow code reader construction seam. */
  readonly createWorkflowCodeReader?: (client: PublicClient, chainId: string) => WorkflowCodeReader
  /** Test-only shared member Repository Client construction seam. */
  readonly createRepositoryClient?: () => RepositoryClient
  /** Test-only DA Client construction seam; production selection still comes from member config. */
  readonly createDaClient?: () => DaClient
  /** Test-only reviewed agent-sdk binding construction seam. */
  readonly createAgentSdkBindingClient?: () => AgentSdkBindingClient
  /** Composition seam for reviewed Chat Client factories; production currently supplies none. */
  readonly chatClientFactories?: Readonly<Partial<Record<ChatPlatform, ChatClientFactory>>>
  /** Composition seam for bundled Proof Provider adapters; production defaults to an empty registry. */
  readonly proofProviderRegistry?: ProofProviderRegistry
}

export interface TasApp {
  readonly instance: TasPublicInstance
  readonly terminal: Promise<{ readonly reason: 'stdio_error' }>
  close(): Promise<void>
}

function publicInstance(config: ResolvedTasConfig): TasPublicInstance {
  if (config.mode === 'identity_setup') {
    return Object.freeze({
      phase: 'identity_setup',
      chain_id: config.identitySetup.chainId,
      identity_registry_address: config.identitySetup.identityRegistryAddress,
    })
  }
  if (config.mode === 'tawg_setup') {
    return Object.freeze({
      phase: 'tawg_setup',
      chain_id: config.tawgSetup.chainId,
      tawg_address: config.tawgSetup.tawgAddress,
    })
  }
  return Object.freeze({
    phase: 'member',
    chain_id: config.instance.chainId,
    tawg_address: config.instance.tawgAddress,
    agent_id: config.instance.agentId,
  })
}

function configuredChain(chainId: number, rpcUrl: string) {
  return defineChain({
    id: chainId,
    name: `eip155:${chainId}`,
    nativeCurrency: { name: 'Native currency', symbol: 'NATIVE', decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl] } },
  })
}

function directPublicClient(chainId: number, rpcUrl: string): PublicClient {
  return createPublicClient({ chain: configuredChain(chainId, rpcUrl), transport: http(rpcUrl, { retryCount: 0 }) })
}

function directWalletClient(chainId: number, rpcUrl: string): WalletClient {
  return createWalletClient({ chain: configuredChain(chainId, rpcUrl), transport: http(rpcUrl, { retryCount: 0 }) })
}

function safeViemChainId(value: string): number {
  const chainId = Number(value)
  if (!Number.isSafeInteger(chainId) || chainId <= 0) {
    throw new TasError('CONFIG_FIELD_INVALID', 'The configured Chain ID is unsupported by the Chain Client.')
  }
  return chainId
}

function startupFailure(error: unknown): Error {
  if (error instanceof TasError) return error
  return new Error('TAS startup failed.')
}

/** Loads one configuration, owns its phase resources, and starts one stdio MCP connection. */
export async function createTasApp(
  configPath: string,
  dependencies: CreateTasAppDependencies = {},
): Promise<TasApp> {
  const environment = dependencies.environment ?? process.env
  const config = await loadTasConfig(configPath, environment)
  const instance = publicInstance(config)
  const acquireLock = dependencies.acquireLock ?? acquireMemberLock
  const createChainClient = dependencies.createChainClient ?? directPublicClient
  const createWalletChainClient = dependencies.createWalletChainClient ?? directWalletClient
  const createWorkflowCodeReader = dependencies.createWorkflowCodeReader
    ?? ((client: PublicClient, chainId: string) => createViemWorkflowCodeReader({ client, chainId }))
  const serve = dependencies.serve ?? serveStdio

  let releaseLock: (() => Promise<void>) | undefined
  let stdio: StdioServerHandle | undefined
  let workflowSourceRuntime: WorkflowSourceRuntime | undefined
  let closePromise: Promise<void> | undefined
  let stdioFailed = false
  let resolveTerminal!: (terminal: { readonly reason: 'stdio_error' }) => void
  const terminal = new Promise<{ readonly reason: 'stdio_error' }>((resolve) => { resolveTerminal = resolve })
  const close = (): Promise<void> => {
    closePromise ??= (async () => {
      let failure: unknown
      try { await workflowSourceRuntime?.close() } catch (error) { failure = error }
      try { await stdio?.close() } catch (error) { failure ??= error }
      try { await releaseLock?.() } catch (error) { failure ??= error }
      if (failure !== undefined) throw startupFailure(failure)
    })()
    return closePromise
  }
  const onStdioError = (): void => {
    if (!stdioFailed) {
      stdioFailed = true
      resolveTerminal(Object.freeze({ reason: 'stdio_error' }))
    }
    if (stdio !== undefined) void close().catch(() => {})
  }

  try {
    if (config.mode === 'member') {
      const directory = memberInstancePath(dependencies.stateRoot ?? join(homedir(), '.tas'), config)
      if (directory === undefined) throw new Error('Member path was unavailable.')
      releaseLock = await acquireLock(directory)
    }

    const bundleOptions = dependencies.packageRoot === undefined ? {} : { packageRoot: dependencies.packageRoot }
    const tasSkill = loadBundledTasSkill(bundleOptions)
    const collaborationSkill = loadBundledCollaborationSkill(bundleOptions)
    const registry = getManifestRegistry()
    const chainId = safeViemChainId(instance.chain_id)
    const publicClient = createChainClient(chainId, config.chain.rpcUrl)
    const walletClient = createWalletChainClient(chainId, config.chain.rpcUrl)
    const resolver = config.mode === 'identity_setup'
      ? undefined
      : new ProfileResolver(
        createViemProfileReader({
          client: publicClient,
          tawgAddress: config.mode === 'tawg_setup' ? config.tawgSetup.tawgAddress : config.instance.tawgAddress,
        }),
        {
          chainId: config.mode === 'tawg_setup' ? config.tawgSetup.chainId : config.instance.chainId,
          tawgAddress: config.mode === 'tawg_setup' ? config.tawgSetup.tawgAddress : config.instance.tawgAddress,
        },
      )
    const chainService = createChainService({
      registry,
      bindings: await loadViemActionBindings(registry),
      config,
      publicClient,
      walletClient,
      ...(resolver === undefined ? {} : { profileResolver: resolver }),
    })
    const memberRepository = config.mode === 'member'
      ? (() => {
          const repositoryResolver = createRepositoryResolver(resolver!)
          const githubRequest = createGitHubRequest()
          const githubClient = dependencies.createRepositoryClient?.()
            ?? createGitHubRepositoryClient(githubRequest)
          const daClient = dependencies.createDaClient?.() ?? createGitDaClient(githubRequest)
          const sourceResolver = createWorkflowSourceResolver({
            profileResolver: resolver!,
            contentClient: githubClient,
          })
          workflowSourceRuntime = createWorkflowSourceRuntime({
            resolver: sourceResolver,
            verifier: createWorkflowSourceVerifier({
              codeReader: createWorkflowCodeReader(publicClient, config.instance.chainId),
              compiler: createSolcCompiler(),
            }),
            rpcUrl: config.chain.rpcUrl,
          })
          return {
            repositoryService: createRepositoryService(repositoryResolver, githubClient),
            daService: createDaService(repositoryResolver, daClient),
            tawgSkillLoader: createTawgSkillLoader(repositoryResolver, githubClient),
            roleSkillLoader: createRoleSkillLoader(repositoryResolver, githubClient),
            workflowSourceService: workflowSourceRuntime.service,
          }
        })()
      : undefined
    const workflowService = config.mode === 'member' && workflowSourceRuntime !== undefined
      ? createWorkflowOperationService({
          agentId: config.instance.agentId,
          gate: workflowSourceRuntime.gate,
          registry,
          memberResolver: resolver!,
          contractAddressResolver: createWorkflowContractAddressResolver(),
          client: dependencies.createAgentSdkBindingClient?.() ?? createAgentSdkBindingClient(registry.list('agent-sdk')),
        })
      : undefined
    let chatService: ChatService | undefined
    let chatToolEntries: readonly ChatGeneratedToolEntry[] | undefined
    let proofProviderRegistry: ProofProviderRegistry | undefined
    if (config.mode === 'member') {
      const suppliedFactories = dependencies.chatClientFactories ?? {}
      const configuredFactories: Partial<Record<ChatPlatform, ChatClientFactory>> = {}
      for (const source of config.chat.sources) {
        const selectedFactory = suppliedFactories[source.platform]
        if (selectedFactory === undefined) {
          throw new TasError(
            'CONFIG_CLIENT_UNSUPPORTED',
            'A configured Chat Client has no available production binding.',
            { field: 'chat.sources.platform' },
          )
        }
        configuredFactories[source.platform] = selectedFactory
      }
      if (config.chat.sources.length > 0) {
        const platforms = [...new Set(config.chat.sources.map(({ platform }) => platform))]
        chatToolEntries = Object.freeze(platforms.flatMap((platform) => registry.list(platform))
          .filter(isChatGeneratedToolEntry))
        chatService = createChatService({
          sources: config.chat.sources,
          targets: config.chat.targets,
          factories: configuredFactories,
        })
      }
      proofProviderRegistry = dependencies.proofProviderRegistry ?? createProofProviderRegistry()
    }
    const factory: McpServerFactory = () => createTasMcpServer({
      tasSkill,
      collaborationSkill,
      chainService,
      instance,
      registry,
      ...(resolver === undefined ? {} : { resolver }),
      ...(memberRepository === undefined ? {} : memberRepository),
      ...(workflowService === undefined ? {} : { workflowService }),
      ...(chatService === undefined || chatToolEntries === undefined
        ? {}
        : { chatService, chatSources: config.mode === 'member' ? config.chat.sources : [], chatToolEntries }),
      ...(proofProviderRegistry === undefined ? {} : { proofProviderRegistry }),
    })
    stdio = serve(factory, {
      legacy: 'serve',
      onerror: onStdioError,
    })
    if (stdioFailed) void close().catch(() => {})
    return Object.freeze({ instance, terminal, close })
  } catch (error) {
    try { await close() } catch { /* preserve the safe startup boundary below */ }
    throw startupFailure(error)
  }
}
