import { isDeepStrictEqual, types as utilTypes } from 'node:util'

import { z } from 'zod'
import { clonePlainJson } from '../../core/json/plainJson.js'

/** Source profiles currently admitted to the runtime Registry. */
export type ManifestSourceProfile = 'agent-sdk' | 'viem-public' | 'viem-wallet' | 'telegram' | 'discord'
/** Dependency profiles accepted by the reviewed artifact schema. */
export type DependencySourceProfile = 'agent-sdk' | ManifestSourceProfile
export type OperationEffect = 'read' | 'side_effect'
export type OperationCompletion = 'synchronous' | 'bounded_wait' | 'external_handle'
export type ManifestRuntimeDependency =
  | 'chain_client'
  | 'contract_address'
  | 'account'
  | 'chat_source'
  | 'chat_target'
  | 'chat_context'
export type ManifestInvocationArgument =
  | { readonly kind: 'input'; readonly name: string }
  | { readonly kind: 'runtime'; readonly source: 'chain_config' }

export type GeneratedToolBinding =
  | { readonly kind: 'client_action'; readonly target: string }
  | { readonly kind: 'chat_operation'; readonly target: string }
  | {
    readonly kind: 'function' | 'class_method'
    readonly target: string
    readonly arguments: readonly ManifestInvocationArgument[]
  }

export interface GeneratedToolEntry {
  readonly name: string
  readonly description: string
  readonly source: {
    readonly entrypoint: string
    readonly export: string
    readonly member: string
  }
  readonly binding: GeneratedToolBinding
  readonly input_schema: Readonly<Record<string, unknown>>
  readonly output_schema: Readonly<Record<string, unknown>>
  readonly operation: {
    readonly effect: OperationEffect
    readonly completion: OperationCompletion
  }
  readonly runtime_dependencies: readonly ManifestRuntimeDependency[]
  readonly credential: 'none' | 'evm_private_key' | 'telegram_bot_token' | 'discord_bot_token'
  readonly annotations: {
    readonly readOnlyHint: boolean
    readonly destructiveHint: boolean
    readonly idempotentHint: boolean
    readonly openWorldHint: boolean
  }
}

export interface DependencyManifest {
  readonly schema_version: 'tas-manifest/v1'
  readonly manifest_id: DependencySourceProfile
  readonly kind: 'dependency'
  readonly source_profile: DependencySourceProfile
  readonly source: {
    readonly package: '@trustless-ai/agent-sdk' | 'viem' | 'grammy' | 'discord.js'
    readonly version: string
    readonly package_integrity: string
    readonly entrypoint_digest: `sha256:${string}`
    readonly entrypoints: readonly string[]
  }
  readonly generator: {
    readonly name: '@trustless-ai/tas-manifest'
    readonly version: string
    readonly typescript_version: '7.0.2'
  }
  readonly tools: readonly GeneratedToolEntry[]
}

const exactVersion = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z]+(?:\.[0-9A-Za-z]+)*)?(?:\+[0-9A-Za-z]+(?:\.[0-9A-Za-z]+)*)?$/
const sha256Digest = /^sha256:[0-9a-f]{64}$/
const sha512Integrity = /^sha512-([A-Za-z0-9+/]+={0,2})$/
const sourceMember = /^[A-Za-z_$][A-Za-z0-9_$]*$/
const namespaceSegment = '[a-z][a-z0-9]*(?:_[a-z0-9]+)*'
const publicNamespace = new RegExp(`^workflow\\.chain\\.public\\.${namespaceSegment}$`)
const walletNamespace = new RegExp(`^workflow\\.chain\\.wallet\\.${namespaceSegment}$`)
const agentSdkNamespace = new RegExp(`^workflow(?:\\.${namespaceSegment})+$`)
const telegramNamespace = new RegExp(`^chat\\.telegram\\.api\\.${namespaceSegment}$`)
const discordNamespace = new RegExp(`^chat\\.discord\\.message_manager\\.${namespaceSegment}$`)
const entrypoint = /^(?:\.|\.\/[^\\\s]+)$/
const canonicalArrayIndex = /^(?:0|[1-9][0-9]*)$/

const manifestFields = ['schema_version', 'manifest_id', 'kind', 'source_profile', 'source', 'generator', 'tools'] as const
const manifestSourceFields = ['package', 'version', 'package_integrity', 'entrypoint_digest', 'entrypoints'] as const
const generatorFields = ['name', 'version', 'typescript_version'] as const
const toolFields = ['name', 'description', 'source', 'binding', 'input_schema', 'output_schema', 'operation', 'runtime_dependencies', 'credential', 'annotations'] as const
const toolSourceFields = ['entrypoint', 'export', 'member'] as const
const bindingFields = ['kind', 'target', 'arguments'] as const
const invocationArgumentFields = ['kind', 'name', 'source'] as const
const operationFields = ['effect', 'completion'] as const
const annotationFields = ['readOnlyHint', 'destructiveHint', 'idempotentHint', 'openWorldHint'] as const
const structuredOutputFields = [
  ...manifestFields,
  ...manifestSourceFields,
  ...generatorFields,
  ...toolFields,
  ...toolSourceFields,
  ...bindingFields,
  ...invocationArgumentFields,
  ...operationFields,
  ...annotationFields,
] as const

function isSafeEntrypoint(value: string): boolean {
  return value === '.' || value.slice(2).split('/').every((segment) => segment !== '' && segment !== '.' && segment !== '..')
}

function isSha512Integrity(value: string): boolean {
  const match = sha512Integrity.exec(value)
  if (match === null) return false
  const encoded = match[1] as string
  const decoded = Buffer.from(encoded, 'base64')
  return decoded.length === 64 && decoded.toString('base64') === encoded
}

function inspectStrictObject(
  value: unknown,
  allowedFields: readonly string[],
  context: z.RefinementCtx,
  path: PropertyKey[],
  requiredFields: readonly string[] = allowedFields,
): ReadonlyMap<string, unknown> | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  if (utilTypes.isProxy(value)) {
    context.addIssue({ code: 'custom', path, message: 'Manifest objects cannot be proxies' })
    return undefined
  }
  let prototype: object | null
  let keys: readonly PropertyKey[]
  try {
    prototype = Object.getPrototypeOf(value)
    keys = Reflect.ownKeys(value)
  } catch {
    context.addIssue({ code: 'custom', path, message: 'Manifest objects must be inspectable plain records' })
    return undefined
  }
  if (prototype !== Object.prototype && prototype !== null) {
    context.addIssue({ code: 'custom', path, message: 'Manifest objects must use a plain prototype' })
    return undefined
  }

  const allowed = new Set(allowedFields)
  const fields = new Map<string, unknown>()
  for (const key of keys) {
    if (typeof key !== 'string') {
      context.addIssue({ code: 'custom', path, message: 'Manifest objects cannot contain symbol fields' })
      continue
    }
    let descriptor: PropertyDescriptor | undefined
    try {
      descriptor = Object.getOwnPropertyDescriptor(value, key)
    } catch {
      context.addIssue({ code: 'custom', path: [...path, key], message: 'Manifest fields must be inspectable' })
      continue
    }
    if (descriptor === undefined || !('value' in descriptor) || !descriptor.enumerable) {
      context.addIssue({ code: 'custom', path: [...path, key], message: 'Manifest fields must be enumerable data properties' })
      continue
    }
    if (!allowed.has(key)) {
      context.addIssue({ code: 'custom', path: [...path, key], message: 'Unknown Manifest field' })
      continue
    }
    fields.set(key, descriptor.value)
  }
  for (const field of requiredFields) {
    if (!fields.has(field)) {
      context.addIssue({ code: 'custom', path: [...path, field], message: 'Required Manifest field must be an own data property' })
    }
  }
  return fields
}

function inspectArrayItems(value: unknown, context: z.RefinementCtx, path: PropertyKey[]): readonly unknown[] | undefined {
  if (!Array.isArray(value)) return undefined
  if (utilTypes.isProxy(value)) {
    context.addIssue({ code: 'custom', path, message: 'Manifest arrays cannot be proxies' })
    return undefined
  }
  let keys: readonly PropertyKey[]
  let prototype: object | null
  try {
    keys = Reflect.ownKeys(value)
    prototype = Object.getPrototypeOf(value)
  } catch {
    context.addIssue({ code: 'custom', path, message: 'Manifest arrays must be inspectable' })
    return undefined
  }
  if (prototype !== Array.prototype) {
    context.addIssue({ code: 'custom', path, message: 'Manifest arrays must use the Array prototype' })
    return undefined
  }

  const lengthDescriptor = Object.getOwnPropertyDescriptor(value, 'length')
  const length = lengthDescriptor?.value
  if (typeof length !== 'number' || !Number.isSafeInteger(length) || length < 0 || keys.length !== length + 1) {
    context.addIssue({ code: 'custom', path, message: 'Manifest arrays must be dense' })
    return undefined
  }
  const items: unknown[] = []
  for (let index = 0; index < length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index))
    if (descriptor === undefined || !('value' in descriptor) || !descriptor.enumerable) {
      context.addIssue({ code: 'custom', path: [...path, index], message: 'Manifest array items must be enumerable data properties' })
      return undefined
    }
    items.push(descriptor.value)
  }
  return items
}

function validateManifestStructure(value: unknown, context: z.RefinementCtx): void {
  for (const key of Reflect.ownKeys(Array.prototype)) {
    if (typeof key === 'string' && canonicalArrayIndex.test(key)) {
      throw new TypeError('TAS Manifest schema cannot run with an unsafe projection prototype.')
    }
  }
  for (const field of structuredOutputFields) {
    if (Object.getOwnPropertyDescriptor(Object.prototype, field) !== undefined) {
      context.addIssue({ code: 'custom', path: [], message: 'Object prototype conflicts with Manifest projection fields' })
      return
    }
  }
  const root = inspectStrictObject(value, manifestFields, context, [])
  if (root === undefined) return
  const source = inspectStrictObject(root.get('source'), manifestSourceFields, context, ['source'])
  if (source !== undefined) inspectArrayItems(source.get('entrypoints'), context, ['source', 'entrypoints'])
  inspectStrictObject(root.get('generator'), generatorFields, context, ['generator'])
  const tools = inspectArrayItems(root.get('tools'), context, ['tools'])
  tools?.forEach((tool, index) => {
    const path = ['tools', index]
    const fields = inspectStrictObject(tool, toolFields, context, path)
    if (fields === undefined) return
    inspectStrictObject(fields.get('source'), toolSourceFields, context, [...path, 'source'])
    const binding = inspectStrictObject(
      fields.get('binding'),
      bindingFields,
      context,
      [...path, 'binding'],
      ['kind', 'target'],
    )
    const arguments_ = binding === undefined || !binding.has('arguments')
      ? undefined
      : inspectArrayItems(binding.get('arguments'), context, [...path, 'binding', 'arguments'])
    arguments_?.forEach((argument, argumentIndex) => {
      inspectStrictObject(
        argument,
        invocationArgumentFields,
        context,
        [...path, 'binding', 'arguments', argumentIndex],
        ['kind'],
      )
    })
    inspectStrictObject(fields.get('operation'), operationFields, context, [...path, 'operation'])
    inspectStrictObject(fields.get('annotations'), annotationFields, context, [...path, 'annotations'])
    inspectArrayItems(fields.get('runtime_dependencies'), context, [...path, 'runtime_dependencies'])
  })
}

export function viemMemberToToolSegment(member: string): string {
  return member
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/([A-Z])([A-Z][a-z])/g, '$1_$2')
    .toLowerCase()
}

const toolSourceSchema = z.object({
  entrypoint: z.string().regex(entrypoint).refine(isSafeEntrypoint),
  export: z.string().regex(sourceMember),
  member: z.string().regex(sourceMember),
}).strict()

const invocationArgumentSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('input'), name: z.string().regex(sourceMember) }).strict(),
  z.object({ kind: z.literal('runtime'), source: z.literal('chain_config') }).strict(),
])

const bindingSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('client_action'), target: z.string().min(1) }).strict(),
  z.object({ kind: z.literal('chat_operation'), target: z.string().min(1) }).strict(),
  z.object({
    kind: z.enum(['function', 'class_method']),
    target: z.string().min(1),
    arguments: z.array(invocationArgumentSchema),
  }).strict(),
])

const operationSchema = z.object({
  effect: z.enum(['read', 'side_effect']),
  completion: z.enum(['synchronous', 'bounded_wait', 'external_handle']),
}).strict()

const annotationsSchema = z.object({
  readOnlyHint: z.boolean(),
  destructiveHint: z.boolean(),
  idempotentHint: z.boolean(),
  openWorldHint: z.boolean(),
}).strict()

const jsonSchemaObject = z.unknown().transform((value, context): Readonly<Record<string, unknown>> => {
  let clone
  try {
    clone = clonePlainJson(value)
  } catch {
    context.addIssue({ code: 'custom', message: 'JSON Schema must be a bounded plain JSON tree' })
    return z.NEVER
  }
  if (clone === null || typeof clone !== 'object' || Array.isArray(clone)) {
    context.addIssue({ code: 'custom', message: 'JSON Schema root must be an object' })
    return z.NEVER
  }
  return clone
})

export const generatedToolEntrySchema: z.ZodType<GeneratedToolEntry> = z.object({
  name: z.string().min(1),
  description: z.string().min(1),
  source: toolSourceSchema,
  binding: bindingSchema,
  input_schema: jsonSchemaObject,
  output_schema: jsonSchemaObject,
  operation: operationSchema,
  runtime_dependencies: z.array(z.enum([
    'chain_client', 'contract_address', 'account', 'chat_source', 'chat_target', 'chat_context',
  ])),
  credential: z.enum(['none', 'evm_private_key', 'telegram_bot_token', 'discord_bot_token']),
  annotations: annotationsSchema,
}).strict()

const dependencyManifestBaseSchema: z.ZodType<DependencyManifest> = z.object({
  schema_version: z.literal('tas-manifest/v1'),
  manifest_id: z.enum(['agent-sdk', 'viem-public', 'viem-wallet', 'telegram', 'discord']),
  kind: z.literal('dependency'),
  source_profile: z.enum(['agent-sdk', 'viem-public', 'viem-wallet', 'telegram', 'discord']),
  source: z.object({
    package: z.enum(['@trustless-ai/agent-sdk', 'viem', 'grammy', 'discord.js']),
    version: z.string().regex(exactVersion),
    package_integrity: z.string().refine(isSha512Integrity),
    entrypoint_digest: z.templateLiteral(['sha256:', z.string()]).refine((value) => sha256Digest.test(value)),
    entrypoints: z.array(z.string().regex(entrypoint).refine(isSafeEntrypoint)).min(1),
  }).strict(),
  generator: z.object({
    name: z.literal('@trustless-ai/tas-manifest'),
    version: z.string().regex(exactVersion),
    typescript_version: z.literal('7.0.2'),
  }).strict(),
  tools: z.array(generatedToolEntrySchema),
}).strict()

function addIssue(context: z.RefinementCtx, path: PropertyKey[], message: string): void {
  context.addIssue({ code: 'custom', path, message })
}

function isStrictlySortedUnique(values: readonly string[]): boolean {
  return values.every((value, index) => index === 0 || (values[index - 1] as string) < value)
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index])
}

function schemaPropertyNames(tool: GeneratedToolEntry, context: z.RefinementCtx, path: PropertyKey[]): readonly string[] {
  const properties = tool.input_schema.properties
  if (properties === null || typeof properties !== 'object' || Array.isArray(properties)) {
    addIssue(context, path, 'agent-sdk input_schema must expose an object properties map')
    return []
  }
  return Object.keys(properties).filter((name) => name !== 'credential').toSorted()
}

function credentialSecretMaxLength(properties: Record<string, unknown>): unknown {
  const credential = properties.credential
  if (credential === null || typeof credential !== 'object' || Array.isArray(credential)) return undefined
  const credentialProperties = (credential as Record<string, unknown>).properties
  if (credentialProperties === null || typeof credentialProperties !== 'object' || Array.isArray(credentialProperties)) {
    return undefined
  }
  const secret = (credentialProperties as Record<string, unknown>).secret
  if (secret === null || typeof secret !== 'object' || Array.isArray(secret)) return undefined
  return (secret as Record<string, unknown>).maxLength
}

const inlineCredentialSchema = clonePlainJson({
  additionalProperties: false,
  properties: {
    secret: { maxLength: 4_096, minLength: 1, type: 'string', writeOnly: true },
    type: { const: 'inline' },
  },
  required: ['secret', 'type'],
  type: 'object',
})

function hasExactInlineCredentialSchema(tool: GeneratedToolEntry): boolean {
  const properties = tool.input_schema.properties
  if (properties === null || typeof properties !== 'object' || Array.isArray(properties)) return false
  const actual = (properties as Record<string, unknown>).credential
  return isDeepStrictEqual(actual, inlineCredentialSchema)
}

function agentSdkToolName(tool: GeneratedToolEntry): string {
  const path = tool.source.entrypoint === '.'
    ? []
    : tool.source.entrypoint.slice(2).split('/').map(viemMemberToToolSegment)
  const callable = tool.binding.kind === 'class_method'
    ? [viemMemberToToolSegment(tool.source.export.replace(/Client$/, '')), viemMemberToToolSegment(tool.source.member)]
    : [viemMemberToToolSegment(tool.source.member)]
  return ['workflow', ...path, ...callable].join('.')
}

const dependencyManifestSemanticSchema: z.ZodType<DependencyManifest> = dependencyManifestBaseSchema.superRefine((manifest, context) => {
  if (manifest.manifest_id !== manifest.source_profile) {
    addIssue(context, ['manifest_id'], 'manifest_id must match source_profile')
  }
  if (!isStrictlySortedUnique(manifest.source.entrypoints)) {
    addIssue(context, ['source', 'entrypoints'], 'entrypoints must be sorted and unique')
  }
  const expectedPackage = manifest.source_profile === 'agent-sdk'
    ? '@trustless-ai/agent-sdk'
    : manifest.source_profile === 'telegram'
      ? 'grammy'
      : manifest.source_profile === 'discord'
        ? 'discord.js'
        : 'viem'
  if (manifest.source.package !== expectedPackage) {
    addIssue(context, ['source', 'package'], 'source package does not match the source profile')
  }
  const names = new Set<string>()

  if (!isStrictlySortedUnique(manifest.tools.map(({ name }) => name))) {
    addIssue(context, ['tools'], 'tools must be sorted by name and unique')
  }

  manifest.tools.forEach((tool, index) => {
    const path = ['tools', index]
    if (names.has(tool.name)) addIssue(context, [...path, 'name'], 'tool names must be unique')
    names.add(tool.name)
    if (!manifest.source.entrypoints.includes(tool.source.entrypoint)) {
      addIssue(context, [...path, 'source', 'entrypoint'], 'tool source entrypoint is not claimed by the Manifest')
    }
    const inputProperties = tool.input_schema.properties
    const hasInputProperties = inputProperties !== null
      && typeof inputProperties === 'object'
      && !Array.isArray(inputProperties)
    const hasCredentialProperty = hasInputProperties && Object.hasOwn(inputProperties, 'credential')
    if (tool.credential === 'none' && hasCredentialProperty) {
      addIssue(context, [...path, 'input_schema', 'properties', 'credential'], 'credential-free tools cannot expose a credential input')
    }
    if (tool.credential !== 'none'
      && (!hasCredentialProperty
        || credentialSecretMaxLength(inputProperties as Record<string, unknown>) !== 4_096)) {
      addIssue(
        context,
        [...path, 'input_schema', 'properties', 'credential'],
        'credential inputs must bound the common secret schema to 4096 characters',
      )
    }

    if (manifest.source_profile === 'agent-sdk') {
      if (!agentSdkNamespace.test(tool.name) || tool.name.startsWith('workflow.chain.')) {
        addIssue(context, [...path, 'name'], 'tool name does not match the agent-sdk namespace')
      }
      if (tool.binding.kind !== 'function' && tool.binding.kind !== 'class_method') {
        addIssue(context, [...path, 'binding', 'kind'], 'agent-sdk binding must be a function or class method')
        return
      }
      if (tool.name !== agentSdkToolName(tool)) {
        addIssue(context, [...path, 'name'], 'tool name must be derived from the agent-sdk entrypoint and callable')
      }
      const expectedTarget = tool.binding.kind === 'class_method'
        ? `${tool.source.export}.${tool.source.member}`
        : tool.source.export
      if (tool.binding.target !== expectedTarget) {
        addIssue(context, [...path, 'binding', 'target'], 'binding target must identify the agent-sdk callable')
      }
      if (tool.binding.kind === 'function' && tool.source.export !== tool.source.member) {
        addIssue(context, [...path, 'source', 'member'], 'function source export and member must match')
      }
      if (tool.binding.kind === 'function' && tool.operation.effect === 'side_effect') {
        addIssue(
          context,
          [...path, 'operation', 'effect'],
          'agent-sdk side effects must use a reviewed Client class method',
        )
      }
      const inputArguments = tool.binding.arguments.filter((argument) => argument.kind === 'input')
      const inputNames = inputArguments.map(({ name }) => name)
      const expectedInputNames = schemaPropertyNames(tool, context, [...path, 'input_schema', 'properties'])
      if (new Set(inputNames).size !== inputNames.length
        || !sameStrings(inputNames.toSorted(), expectedInputNames)) {
        addIssue(
          context,
          [...path, 'binding', 'arguments'],
          'input invocation slots must cover input_schema properties other than credential exactly once',
        )
      }
      const runtimeArguments = tool.binding.arguments.filter((argument) => argument.kind === 'runtime')
      const expectedDependencies: readonly ManifestRuntimeDependency[] = tool.binding.kind === 'class_method'
        ? ['chain_client', 'contract_address', 'account']
        : runtimeArguments.length === 0 ? [] : ['chain_client', 'contract_address']
      if (tool.binding.kind === 'class_method' && runtimeArguments.length !== 0) {
        addIssue(context, [...path, 'binding', 'arguments'], 'class method call arguments cannot inject constructor runtime values')
      }
      if (tool.binding.kind === 'function'
        && (runtimeArguments.length > 1
          || runtimeArguments.some(({ source }) => source !== 'chain_config'))) {
        addIssue(context, [...path, 'binding', 'arguments'], 'function runtime arguments must contain at most one chain_config slot')
      }
      if (!sameStrings(tool.runtime_dependencies, expectedDependencies)) {
        addIssue(context, [...path, 'runtime_dependencies'], 'runtime dependencies do not match the agent-sdk binding')
      }
      const expectedCredential = tool.operation.effect === 'side_effect' && tool.binding.kind === 'class_method'
        ? 'evm_private_key'
        : 'none'
      if (tool.credential !== expectedCredential) {
        addIssue(context, [...path, 'credential'], 'credential does not match the agent-sdk operation')
      }
      return
    }

    if (manifest.source_profile === 'telegram' || manifest.source_profile === 'discord') {
      const telegram = manifest.source_profile === 'telegram'
      const expectedExport = telegram ? 'Api' : 'MessageManager'
      const expectedNamespace = telegram ? telegramNamespace : discordNamespace
      const expectedDependencies: readonly ManifestRuntimeDependency[] = telegram
        ? ['chat_source', 'chat_target']
        : ['chat_source', 'chat_target', 'chat_context']
      const expectedCredential = telegram ? 'telegram_bot_token' : 'discord_bot_token'
      if (manifest.source.entrypoints.length !== 1 || manifest.source.entrypoints[0] !== '.') {
        addIssue(context, ['source', 'entrypoints'], 'chat source must own only the root entrypoint')
      }
      if (!expectedNamespace.test(tool.name)
        || tool.name !== `chat.${manifest.source_profile}.${telegram ? 'api' : 'message_manager'}.${viemMemberToToolSegment(tool.source.member)}`) {
        addIssue(context, [...path, 'name'], 'tool name does not match the chat source profile')
      }
      if (tool.source.entrypoint !== '.' || tool.source.export !== expectedExport) {
        addIssue(context, [...path, 'source'], 'tool source does not match the chat source profile')
      }
      if (tool.binding.kind !== 'chat_operation'
        || tool.binding.target !== `${expectedExport}.${tool.source.member}`) {
        addIssue(context, [...path, 'binding'], 'chat binding must identify the owned platform operation')
      }
      if (!sameStrings(tool.runtime_dependencies, expectedDependencies)) {
        addIssue(context, [...path, 'runtime_dependencies'], 'runtime dependencies do not match the chat source profile')
      }
      if (tool.credential !== expectedCredential) {
        addIssue(context, [...path, 'credential'], 'credential does not match the chat source profile')
      }
      if (!hasExactInlineCredentialSchema(tool)) {
        addIssue(context, [...path, 'input_schema', 'properties', 'credential'], 'chat credential schema must match the bounded inline credential contract')
      }
      if (tool.operation.effect !== 'side_effect' || tool.operation.completion !== 'synchronous') {
        addIssue(context, [...path, 'operation'], 'chat operations must use the reviewed side-effect contract')
      }
      if (tool.annotations.readOnlyHint
        || !tool.annotations.destructiveHint
        || tool.annotations.idempotentHint
        || !tool.annotations.openWorldHint) {
        addIssue(context, [...path, 'annotations'], 'chat annotations do not match the reviewed side-effect contract')
      }
      return
    }

    const publicProfile = manifest.source_profile === 'viem-public'
    const expectedExport = publicProfile ? 'PublicActions' : 'WalletActions'
    const expectedNamespace = publicProfile ? publicNamespace : walletNamespace
    const namespace = publicProfile ? 'workflow.chain.public' : 'workflow.chain.wallet'
    const expectedDependencies: readonly ManifestRuntimeDependency[] = publicProfile
      ? ['chain_client']
      : ['chain_client', 'account']
    const expectedCredential = publicProfile ? 'none' : 'evm_private_key'
    if (!expectedNamespace.test(tool.name)) {
      addIssue(context, [...path, 'name'], 'tool name does not match the source profile namespace')
    }
    if (tool.name !== `${namespace}.${viemMemberToToolSegment(tool.source.member)}`) {
      addIssue(context, [...path, 'name'], 'tool name must be derived from the source member')
    }
    if (tool.source.export !== expectedExport) {
      addIssue(context, [...path, 'source', 'export'], 'source export does not match the source profile')
    }
    if (tool.binding.kind !== 'client_action'
      || tool.binding.target !== `${tool.source.export}.${tool.source.member}`) {
      addIssue(context, [...path, 'binding', 'target'], 'binding target must identify the source export and member')
    }
    if (!sameStrings(tool.runtime_dependencies, expectedDependencies)) {
      addIssue(context, [...path, 'runtime_dependencies'], 'runtime dependencies do not match the source profile')
    }
    if (tool.credential !== expectedCredential) {
      addIssue(context, [...path, 'credential'], 'credential does not match the source profile')
    }
  })
})

const dependencyManifestInputSchema = z.unknown().superRefine(validateManifestStructure)

export const dependencyManifestSchema: z.ZodType<DependencyManifest> = dependencyManifestInputSchema.pipe(dependencyManifestSemanticSchema)

export function parseDependencyManifest(value: unknown): DependencyManifest {
  return dependencyManifestSchema.parse(value)
}
