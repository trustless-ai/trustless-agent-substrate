import { McpServer } from '@modelcontextprotocol/server'

import type { DaService } from '../core/da/service.js'
import type { ChatService } from '../core/chat/service.js'
import type { ChatConfiguredSource } from '../core/chat/types.js'
import type { ProfileResolver } from '../core/profile/resolver.js'
import { createProofProviderRegistry, type ProofProviderRegistry } from '../core/proof-provider/registry.js'
import type { RepositoryService } from '../core/repository/service.js'
import type { RoleSkillLoader, TawgSkillLoader } from '../core/skill/loader.js'
import type { CollaborationSkillArtifact, TasSkillArtifact } from '../core/skill/types.js'
import type { ChainService } from '../core/workflow/chainService.js'
import type { WorkflowSourceService } from '../core/workflow/sourceService.js'
import type { WorkflowOperationService } from '../core/workflow/types.js'
import { registerGeneratedChainTools } from './generatedChainTools.js'
import { registerDaTools } from './daTools.js'
import { registerChatWaitTools } from './chatWaitTools.js'
import { registerGeneratedChatTools, type ChatGeneratedToolEntry } from './generatedChatTools.js'
import { registerGeneratedWorkflowTools } from './generatedWorkflowTools.js'
import type { ManifestRegistry } from './manifest/registry.js'
import { registerProfileTools } from './profileTools.js'
import { registerProofProviderTools } from './proofProviderTools.js'
import { registerRepositoryTools } from './repositoryTools.js'
import type { TasPublicInstance } from './results.js'
import { registerSkillTools } from './skillTools.js'
import { registerWorkflowSourceTools } from './workflowSourceTools.js'

export interface TasMcpServerOptions {
  readonly tasSkill: TasSkillArtifact
  readonly collaborationSkill: CollaborationSkillArtifact
  readonly instance: TasPublicInstance
  readonly resolver?: ProfileResolver
  readonly repositoryService?: RepositoryService
  readonly tawgSkillLoader?: TawgSkillLoader
  readonly roleSkillLoader?: RoleSkillLoader
  readonly registry: ManifestRegistry
  readonly chainService: ChainService
  readonly workflowService?: WorkflowOperationService
  readonly workflowSourceService?: WorkflowSourceService
  readonly daService?: DaService
  readonly chatService?: ChatService
  readonly chatSources?: readonly ChatConfiguredSource[]
  readonly chatToolEntries?: readonly ChatGeneratedToolEntry[]
  readonly proofProviderRegistry?: ProofProviderRegistry
}

/** Creates one connection-local MCP server with the phase-exact Slice A1 tool inventory. */
export function createTasMcpServer(options: TasMcpServerOptions): McpServer {
  const {
    tasSkill,
    collaborationSkill,
    chatService,
    chatSources,
    chatToolEntries,
    chainService,
    daService,
    instance,
    registry,
    repositoryService,
    resolver,
    tawgSkillLoader,
    roleSkillLoader,
    proofProviderRegistry,
    workflowService,
    workflowSourceService,
  } = options
  if ((instance.phase === 'identity_setup') !== (resolver === undefined)) {
    throw new TypeError('Invalid TAS phase service composition.')
  }
  const hasRepositoryService = repositoryService !== undefined
  const hasDaService = daService !== undefined
  const hasTawgSkillLoader = tawgSkillLoader !== undefined
  const hasRoleSkillLoader = roleSkillLoader !== undefined
  const hasWorkflowService = workflowService !== undefined
  const hasWorkflowSourceService = workflowSourceService !== undefined
  const hasChatService = chatService !== undefined
  const hasChatSources = chatSources !== undefined
  const hasChatToolEntries = chatToolEntries !== undefined
  const hasProofProviderRegistry = proofProviderRegistry !== undefined
  if (instance.phase === 'member') {
    if (!hasRepositoryService || !hasTawgSkillLoader || !hasRoleSkillLoader
      || !hasWorkflowService || !hasWorkflowSourceService || !hasDaService) {
      throw new TypeError('Invalid TAS phase service composition.')
    }
    if (Number(hasChatService) + Number(hasChatSources) + Number(hasChatToolEntries) !== 0
      && Number(hasChatService) + Number(hasChatSources) + Number(hasChatToolEntries) !== 3) {
      throw new TypeError('Invalid TAS phase service composition.')
    }
  } else if (hasRepositoryService || hasTawgSkillLoader || hasRoleSkillLoader || hasWorkflowService
    || hasWorkflowSourceService || hasDaService || hasChatService || hasChatSources
    || hasChatToolEntries || hasProofProviderRegistry) {
    throw new TypeError('Invalid TAS phase service composition.')
  }

  let stableChatService: ChatService | undefined
  if (chatService !== undefined && chatSources !== undefined && chatToolEntries !== undefined) {
    const configuredPlatforms = new Set(chatSources.map(({ platform }) => platform))
    const servicePlatforms = new Set(chatService.platforms())
    if (configuredPlatforms.size !== servicePlatforms.size
      || [...configuredPlatforms].some((platform) => !servicePlatforms.has(platform))) {
      throw new TypeError('Invalid TAS phase service composition.')
    }
    const platforms = Object.freeze([...configuredPlatforms])
    const selectedChatService: ChatService = {
      platforms: () => platforms,
      invoke: (invocation) => chatService.invoke(invocation),
      wait: (invocation) => chatService.wait(invocation),
    }
    stableChatService = Object.freeze(selectedChatService)
  }

  const server = new McpServer({ name: tasSkill.skill.package, version: tasSkill.skill.version })
  registerSkillTools(server, {
    tas: tasSkill,
    collaboration: collaborationSkill,
    instance,
    ...(instance.phase === 'member' ? { tawg: tawgSkillLoader!, role: roleSkillLoader! } : {}),
  })
  registerGeneratedChainTools(server, registry, chainService, instance)
  if (instance.phase !== 'identity_setup') registerProfileTools(server, resolver!, instance)
  if (instance.phase === 'member') {
    registerRepositoryTools(server, repositoryService!, instance)
    registerWorkflowSourceTools(server, workflowSourceService!, instance)
    registerGeneratedWorkflowTools(server, registry, workflowService!, instance)
    registerDaTools(server, daService!, instance)
    if (stableChatService !== undefined && chatSources !== undefined && chatToolEntries !== undefined) {
      registerGeneratedChatTools(server, chatToolEntries, stableChatService, instance)
      registerChatWaitTools(server, stableChatService, chatSources, instance)
    }
    registerProofProviderTools(server, proofProviderRegistry ?? createProofProviderRegistry(), instance)
  }
  return server
}
