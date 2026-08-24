import { createHash } from 'node:crypto'
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

import {
  API,
  ModifierFlags,
  SignatureKind,
  SymbolFlags,
  TypeFlags,
  type Checker,
  type Signature,
  type Symbol as TypeScriptSymbol,
  type Type,
} from 'typescript/unstable/sync'
import {
  isCallExpression,
  isBinaryExpression,
  isClassDeclaration,
  isClassStaticBlockDeclaration,
  isConstructorDeclaration,
  isComputedPropertyName,
  isElementAccessExpression,
  isExportDeclaration,
  isFunctionDeclaration,
  isGetAccessorDeclaration,
  isIdentifier,
  isImportDeclaration,
  isNamedImports,
  isMethodDeclaration,
  isNewExpression,
  isPostfixUnaryExpression,
  isPrefixUnaryExpression,
  isPropertyAccessExpression,
  isPropertyDeclaration,
  isSetAccessorDeclaration,
  isTaggedTemplateExpression,
  isVariableDeclaration,
  SyntaxKind,
  type ClassDeclaration,
  type Node,
  type SourceFile,
} from 'typescript/unstable/ast'

import type { OperationCompletion, OperationEffect } from '../../src/mcp/manifest/types.js'
import {
  closeCompilerSession,
  resolveLockedPackage,
  resolveReviewedProgramPackage,
  type ReviewedDeclarationMetadata,
  type ReviewedPackageMetadata,
  type TrustedDependencyMetadata,
} from './analyzeViem.js'
import type { JsonSchema } from './schemaEncoder.js'

export type AgentSdkProjection = {
  readonly input_schema: JsonSchema
  readonly output_schema: JsonSchema
}

export interface AgentSdkIncludedCallable {
  readonly entrypoint: string
  readonly exportName: string
  readonly member?: string
  readonly toolName: string
  readonly bindingKind: 'function' | 'class_method'
  readonly signature: string
  readonly projection: AgentSdkProjection
  readonly effect: OperationEffect
  readonly completion: OperationCompletion
  readonly runtimeDependencies: readonly ('chain_client' | 'contract_address' | 'account')[]
  readonly credential: 'none' | 'evm_private_key'
  readonly invocationArguments: readonly AgentSdkInvocationArgument[]
}

export type AgentSdkInvocationArgument =
  | { readonly kind: 'input'; readonly name: string }
  | { readonly kind: 'runtime'; readonly source: 'chain_config' }

export interface ReviewedRuntimeFileMetadata {
  readonly packageName: string
  readonly packageVersion: string
  readonly packageRelativePath: string
  readonly sha256: `sha256:${string}`
}

export interface ReviewedAgentSdkEntrypoint {
  readonly entrypoint: string
  readonly typesPackageRelativePath: string
  readonly runtimePackageRelativePath: string
}

export type AgentSdkExclusionReasonCode =
  | 'non_callable_export'
  | 'provider_reserved'
  | 'shadowed_by_canonical_entrypoint'

export interface AgentSdkExcludedCallable {
  readonly entrypoint: string
  readonly exportName: string
  readonly member?: string
  readonly reasonCode: AgentSdkExclusionReasonCode
  readonly reason: string
}

export interface AgentSdkAnalysis {
  readonly packageName: string
  readonly packageVersion: string
  readonly packageIntegrity: string
  readonly entrypoints: readonly string[]
  readonly reviewedEntrypoints: readonly ReviewedAgentSdkEntrypoint[]
  readonly trustedDependencies: readonly TrustedDependencyMetadata[]
  readonly reviewedPackages: readonly ReviewedPackageMetadata[]
  readonly reviewedDeclarations: readonly ReviewedDeclarationMetadata[]
  readonly reviewedRuntimeFiles: readonly ReviewedRuntimeFileMetadata[]
  readonly included: readonly AgentSdkIncludedCallable[]
  readonly excluded: readonly AgentSdkExcludedCallable[]
}

export interface AnalyzeAgentSdkInput {
  readonly cwd?: string
  /** Declaration-only package assembled by focused tests. */
  readonly fixture?: {
    readonly packageRoot: string
    readonly packageName: string
    readonly packageVersion: string
    readonly packageIntegrity: string
  }
}

interface PublicEntrypoint {
  readonly entrypoint: string
  readonly typesPath: string
  readonly moduleSpecifier: string
  readonly runtimePath: string
}

interface SourceMetadata {
  readonly packageRoot: string
  readonly packageName: string
  readonly packageVersion: string
  readonly packageIntegrity: string
  readonly entrypoints: readonly PublicEntrypoint[]
  readonly lockRoot?: string
  readonly lockPackages?: Record<string, unknown>
  readonly fixture: boolean
}

interface Candidate {
  readonly entrypoint: string
  readonly exportName: string
  readonly member?: string
  readonly symbol: TypeScriptSymbol
  readonly classSymbol?: TypeScriptSymbol
  readonly kind: 'function' | 'class_method'
}

interface RuntimeCallableEvidence {
  readonly key: string
  readonly localCalls: readonly string[]
  readonly hasWrite: boolean
  readonly hasRead: boolean
  readonly hasUnknownCall: boolean
  readonly hasNeutralCall: boolean
  readonly isLocalComputation: boolean
}

type RuntimePrimitiveEffect = 'read' | 'write' | 'neutral' | 'unknown'
type RuntimeAnalyzedEffect = 'read' | 'write' | 'unsafe'

interface SchemaState {
  readonly checker: Checker
  readonly active: Set<number>
  readonly defaultLibraryPaths: ReadonlySet<string>
  nodes: number
}

const schemaVersion = 'https://json-schema.org/draft/2020-12/schema'
const providerReservedEntrypoint = './governance/InvinoVeritas'
const maximumSchemaNodes = 10_000
const maximumBigintLength = 79
const bigintPattern = '^(?:0|-?[1-9][0-9]*)$'
const maximumReviewedDeclarations = 10_000
const maximumReviewedBytes = 64 * 1_024 * 1_024
const maximumRuntimeTreeDirectories = 2_048
const maximumRuntimeTreeEntries = 50_000
const maximumRuntimeTreeDepth = 64

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be a JSON object`)
  }
  return value as Record<string, unknown>
}

function requiredString(record: Record<string, unknown>, key: string, label: string): string {
  const value = record[key]
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${label}.${key} must be a non-empty string`)
  return value
}

function stableCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function canonicalCompilerPath(path: string): string {
  const absolute = resolve(path)
  return process.platform === 'darwin' || process.platform === 'win32' ? absolute.toLowerCase() : absolute
}

function findPackageLock(start: string): string {
  let current = resolve(start)
  while (true) {
    const candidate = join(current, 'package-lock.json')
    if (existsSync(candidate)) return candidate
    const parent = dirname(current)
    if (parent === current) throw new Error(`package-lock.json not found from ${start}`)
    current = parent
  }
}

function resolveInstalledPackageJson(require: NodeRequire, packageName: string): string {
  let current = dirname(require.resolve(packageName))
  for (let depth = 0; depth < 16; depth += 1) {
    const candidate = join(current, 'package.json')
    if (existsSync(candidate)) {
      const record = asRecord(JSON.parse(readFileSync(candidate, 'utf8')) as unknown, `${packageName} package.json`)
      if (record.name === packageName) return candidate
    }
    const parent = dirname(current)
    if (parent === current) break
    current = parent
  }
  throw new Error(`cannot resolve installed package.json for ${packageName}`)
}

function isWithin(path: string, root: string): boolean {
  const pathFromRoot = relative(resolve(root), resolve(path))
  return pathFromRoot === '' || (pathFromRoot !== '..' && !pathFromRoot.startsWith(`..${sep}`) && !isAbsolute(pathFromRoot))
}

function safePackageRelativePath(packageRoot: string, path: string, label: string): string {
  const relativePath = relative(packageRoot, path).split(sep).join('/')
  if (relativePath === '' || relativePath.startsWith('../') || isAbsolute(relativePath)) {
    throw new Error(`${label} has an unsafe package-relative path`)
  }
  return relativePath
}

function publicEntrypoints(packageRoot: string, packageName: string, fixture: boolean): readonly PublicEntrypoint[] {
  const packageJson = asRecord(JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8')) as unknown, 'agent-sdk package.json')
  const exportsMap = asRecord(packageJson.exports, 'agent-sdk package.json exports')
  return Object.entries(exportsMap).map(([entrypoint, conditions]) => {
    if (entrypoint !== '.' && (!entrypoint.startsWith('./') || entrypoint.includes('*'))) {
      throw new Error(`agent-sdk public export path is unsupported: ${entrypoint}`)
    }
    const conditionMap = asRecord(conditions, `agent-sdk exports[${JSON.stringify(entrypoint)}]`)
    const relativeTypesPath = requiredString(conditionMap, 'types', `agent-sdk exports[${JSON.stringify(entrypoint)}]`)
    const typesPath = resolve(packageRoot, relativeTypesPath)
    if (!isWithin(typesPath, packageRoot) || !existsSync(typesPath)) {
      throw new Error(`agent-sdk types export escapes or is missing: ${entrypoint}`)
    }
    const status = lstatSync(typesPath)
    if (status.isSymbolicLink() || !status.isFile() || !isWithin(realpathSync(typesPath), realpathSync(packageRoot))) {
      throw new Error(`agent-sdk types export must be a regular in-package file: ${entrypoint}`)
    }
    const relativeRuntimePath = requiredString(conditionMap, 'default', `agent-sdk exports[${JSON.stringify(entrypoint)}]`)
    const runtimePath = resolve(packageRoot, relativeRuntimePath)
    if (!isWithin(runtimePath, packageRoot) || !existsSync(runtimePath)) {
      throw new Error(`agent-sdk runtime export escapes or is missing: ${entrypoint}`)
    }
    const runtimeStatus = lstatSync(runtimePath)
    if (runtimeStatus.isSymbolicLink() || !runtimeStatus.isFile()
      || !isWithin(realpathSync(runtimePath), realpathSync(packageRoot))) {
      throw new Error(`agent-sdk runtime export must be a regular in-package file: ${entrypoint}`)
    }
    const moduleSpecifier = fixture
      ? relativeTypesPath
          .replace(/\.d\.mts$/i, '.mjs')
          .replace(/\.d\.cts$/i, '.cjs')
          .replace(/\.d\.ts$/i, '.js')
      : entrypoint === '.' ? packageName : `${packageName}${entrypoint.slice(1)}`
    return { entrypoint, typesPath, moduleSpecifier, runtimePath }
  }).toSorted((left, right) => stableCompare(left.entrypoint, right.entrypoint))
}

function resolveMetadata(input: AnalyzeAgentSdkInput): SourceMetadata {
  const cwd = resolve(input.cwd ?? process.cwd())
  if (input.fixture !== undefined) {
    const packageRoot = realpathSync(resolve(input.fixture.packageRoot))
    const lockPath = join(packageRoot, 'package-lock.json')
    const lock = existsSync(lockPath)
      ? asRecord(JSON.parse(readFileSync(lockPath, 'utf8')) as unknown, 'fixture package-lock.json')
      : undefined
    if (lock !== undefined && lock.lockfileVersion !== 3) throw new Error('fixture package-lock.json must use lockfileVersion 3')
    return {
      ...input.fixture,
      packageRoot,
      entrypoints: publicEntrypoints(packageRoot, input.fixture.packageName, true),
      ...(lock === undefined ? {} : { lockRoot: packageRoot, lockPackages: asRecord(lock.packages, 'fixture package-lock.json packages') }),
      fixture: true,
    }
  }
  const require = createRequire(join(cwd, 'package.json'))
  const packageJsonPath = resolveInstalledPackageJson(require, '@trustless-ai/agent-sdk')
  const packageRoot = dirname(packageJsonPath)
  const packageJson = asRecord(JSON.parse(readFileSync(packageJsonPath, 'utf8')) as unknown, 'agent-sdk package.json')
  const packageName = requiredString(packageJson, 'name', 'agent-sdk package.json')
  const packageVersion = requiredString(packageJson, 'version', 'agent-sdk package.json')
  const lockPath = findPackageLock(cwd)
  const lockRoot = dirname(lockPath)
  const lock = asRecord(JSON.parse(readFileSync(lockPath, 'utf8')) as unknown, 'package-lock.json')
  if (lock.lockfileVersion !== 3) throw new Error('package-lock.json must use lockfileVersion 3')
  const lockPackages = asRecord(lock.packages, 'package-lock.json packages')
  const locked = resolveLockedPackage(packageName, packageJsonPath, lockRoot, lockPackages)
  if (locked.packageVersion !== packageVersion) throw new Error('installed agent-sdk identity is inconsistent')
  return {
    packageRoot,
    packageName,
    packageVersion,
    packageIntegrity: locked.packageIntegrity,
    entrypoints: publicEntrypoints(packageRoot, packageName, false),
    lockRoot,
    lockPackages,
    fixture: false,
  }
}

function snakeCase(value: string): string {
  const result = value
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/([A-Z])([A-Z][a-z])/g, '$1_$2')
    .replace(/[^A-Za-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toLowerCase()
  if (!/^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/.test(result)) {
    throw new Error(`agent-sdk name cannot be mapped to one snake_case segment: ${value}`)
  }
  return result
}

function entrypointSegments(entrypoint: string): readonly string[] {
  return entrypoint === '.' ? [] : entrypoint.slice(2).split('/').map(snakeCase)
}

function toolName(candidate: Candidate): string {
  const segments = ['workflow', ...entrypointSegments(candidate.entrypoint)]
  if (candidate.kind === 'class_method') {
    const className = candidate.exportName.endsWith('Client')
      ? candidate.exportName.slice(0, -'Client'.length)
      : candidate.exportName
    segments.push(snakeCase(className))
  }
  segments.push(snakeCase(candidate.member ?? candidate.exportName))
  return segments.join('.')
}

function canonicalSymbol(symbol: TypeScriptSymbol, checker: Checker): TypeScriptSymbol {
  return (symbol.flags & SymbolFlags.Alias) !== 0 ? checker.getAliasedSymbol(symbol) : symbol
}

function isPublicInstanceMethod(symbol: TypeScriptSymbol): boolean {
  return symbol.declarations.every((declaration) => {
    const node = declaration.resolve() as unknown as { readonly modifierFlags?: ModifierFlags }
    const flags = node.modifierFlags ?? ModifierFlags.None
    return (flags & (ModifierFlags.Private | ModifierFlags.Protected)) === 0
  })
}

function candidateIdentity(candidate: Candidate): TypeScriptSymbol {
  return candidate.symbol
}

function typeName(type: Type): string | undefined {
  return type.getAliasSymbol()?.name ?? type.getSymbol()?.name
}

function requiredSymbolType(symbol: TypeScriptSymbol, checker: Checker, label: string): Type {
  const type = checker.getTypeOfSymbol(symbol)
  if (type === undefined) throw new Error(`${label} type is unresolved`)
  return type
}

function declarationPath(declaration: unknown): string | undefined {
  const handle = declaration as { readonly path?: string } | undefined
  return handle?.path === undefined ? undefined : canonicalCompilerPath(handle.path)
}

function declarationSourceFileName(declaration: TypeScriptSymbol['declarations'][number]): string | undefined {
  return declaration.resolve()?.getSourceFile().fileName
}

function runtimeCallableKey(path: string, className: string | undefined, member: string): string {
  return `${resolve(path)}\0${className ?? ''}\0${member}`
}

function visitDescendants(node: Node, visitor: (child: Node) => void): void {
  node.forEachChild((child) => {
    visitor(child)
    visitDescendants(child, visitor)
  })
}

function assertNoUnsupportedRuntimeDispatch(sourceFile: SourceFile): void {
  visitDescendants(sourceFile, (node) => {
    if (isClassDeclaration(node)) {
      for (const member of node.members) {
        const memberName = (member as unknown as { readonly name?: Node }).name
        if (memberName !== undefined && isComputedPropertyName(memberName)) {
          throw new Error(`computed class member is unsupported in reviewed runtime source ${sourceFile.fileName}`)
        }
      }
    }
    if (isTaggedTemplateExpression(node)) {
      throw new Error(`tagged template dispatch is unsupported in reviewed runtime source ${sourceFile.fileName}`)
    }
    if (isIdentifier(node) && (node.text === 'require' || node.text === 'eval' || node.text === 'Function')) {
      throw new Error(`dynamic code identifier ${node.text} is unsupported in reviewed runtime source ${sourceFile.fileName}`)
    }
    if (isPropertyAccessExpression(node)
      && isIdentifier(node.expression)
      && ((node.expression.text === 'module' && node.name.text === 'require')
        || (node.expression.text === 'process' && node.name.text === 'getBuiltinModule'))) {
      throw new Error(`dynamic module access ${node.expression.text}.${node.name.text} is unsupported in reviewed runtime source ${sourceFile.fileName}`)
    }
    if (!isCallExpression(node)) return
    if (node.expression.kind === SyntaxKind.ImportKeyword) {
      throw new Error(`dynamic import() is unsupported in reviewed runtime source ${sourceFile.fileName}`)
    }
    if (isIdentifier(node.expression) && node.expression.text === 'require') {
      throw new Error(`CommonJS require() is unsupported in reviewed runtime source ${sourceFile.fileName}`)
    }
    if (isElementAccessExpression(node.expression)) {
      throw new Error(`computed-member invocation is unsupported in reviewed runtime source ${sourceFile.fileName}`)
    }
  })
}

function callableDefinitions(sourceFile: SourceFile): ReadonlyMap<string, Node> {
  const definitions = new Map<string, Node>()
  for (const statement of sourceFile.statements) {
    if (isFunctionDeclaration(statement) && statement.name !== undefined) {
      definitions.set(runtimeCallableKey(sourceFile.fileName, undefined, statement.name.text), statement)
      continue
    }
    if (!isClassDeclaration(statement) || statement.name === undefined) continue
    for (const member of statement.members) {
      if (isMethodDeclaration(member) && member.name !== undefined && isIdentifier(member.name)) {
        definitions.set(runtimeCallableKey(sourceFile.fileName, statement.name.text, member.name.text), member)
      }
    }
  }
  return definitions
}

function classConstructionDefinitions(sourceFile: SourceFile): {
  readonly definitions: ReadonlyMap<string, Node>
  readonly keysByClass: ReadonlyMap<string, readonly string[]>
} {
  const definitions = new Map<string, Node>()
  const keysByClass = new Map<string, readonly string[]>()
  for (const statement of sourceFile.statements) {
    if (!isClassDeclaration(statement) || statement.name === undefined) continue
    const keys: string[] = []
    let fieldIndex = 0
    for (const member of statement.members) {
      if (isConstructorDeclaration(member)) {
        const key = runtimeCallableKey(sourceFile.fileName, statement.name.text, '#constructor')
        definitions.set(key, member)
        keys.push(key)
      } else if (isPropertyDeclaration(member) && member.initializer !== undefined) {
        const key = runtimeCallableKey(sourceFile.fileName, statement.name.text, `#field_${fieldIndex}`)
        fieldIndex += 1
        definitions.set(key, member)
        keys.push(key)
      }
    }
    keysByClass.set(`${resolve(sourceFile.fileName)}\0${statement.name.text}`, keys)
  }
  return { definitions, keysByClass }
}

function viemImportEffects(
  sourceFile: SourceFile,
  checker: Checker,
  viemRoot: string | undefined,
): ReadonlyMap<TypeScriptSymbol, RuntimePrimitiveEffect> {
  const effects = new Map<TypeScriptSymbol, RuntimePrimitiveEffect>()
  for (const statement of sourceFile.statements) {
    if (!isImportDeclaration(statement) || !('text' in statement.moduleSpecifier)
      || typeof statement.moduleSpecifier.text !== 'string'
      || (statement.moduleSpecifier.text !== 'viem' && !statement.moduleSpecifier.text.startsWith('viem/'))) continue
    const bindings = statement.importClause?.namedBindings
    if (bindings === undefined || !isNamedImports(bindings)) continue
    for (const element of bindings.elements) {
      const importedName = element.propertyName?.text ?? element.name.text
      const effect: RuntimePrimitiveEffect = viemWritePrimitives.has(importedName)
        ? 'write'
        : viemReadPrimitives.has(importedName)
          ? 'read'
          : viemNeutralPrimitives.has(importedName) ? 'neutral' : 'unknown'
      const symbol = checker.getSymbolAtLocation(element.name)
      if (symbol === undefined) continue
      effects.set(symbol, effect)
      const target = canonicalSymbol(symbol, checker)
      if (viemRoot !== undefined && symbolDeclarationsWithin(target, viemRoot)) effects.set(target, effect)
    }
  }
  return effects
}

const viemReadPrimitives = new Set([
  'parseEventLogs',
  'readContract',
  'simulateContract',
  'waitForTransactionReceipt',
])
const viemWritePrimitives = new Set(['sendRawTransaction', 'sendTransaction', 'writeContract'])
const viemNeutralPrimitives = new Set([
  'concat',
  'createPublicClient',
  'createWalletClient',
  'encodeAbiParameters',
  'http',
  'keccak256',
  'sha256',
  'stringToBytes',
  'stringToHex',
  'toHex',
])
const standardPurePrimitives = new Set([
  'BigInt',
  'Error',
  'join',
  'map',
  'round',
  'slice',
  'sort',
  'stringify',
])

function symbolDeclarationsWithin(
  symbol: TypeScriptSymbol,
  root: string,
): boolean {
  return symbol.declarations.length > 0 && symbol.declarations.every((declaration) => {
    const fileName = declarationSourceFileName(declaration)
    return fileName !== undefined && isWithin(fileName, root)
  })
}

function symbolDeclarationsInDefaultLibrary(
  symbol: TypeScriptSymbol,
  defaultLibraryPaths: ReadonlySet<string>,
): boolean {
  return symbol.declarations.length > 0 && symbol.declarations.every((declaration) => {
    const fileName = declarationSourceFileName(declaration)
    return fileName !== undefined && defaultLibraryPaths.has(canonicalCompilerPath(fileName))
  })
}

function primitiveEffect(
  node: Node,
  checker: Checker,
  viemRoot: string | undefined,
  defaultLibraryPaths: ReadonlySet<string>,
): RuntimePrimitiveEffect {
  const symbol = checker.getSymbolAtLocation(node)
  if (symbol === undefined) return 'unknown'
  const target = canonicalSymbol(symbol, checker)
  if (viemRoot !== undefined && symbolDeclarationsWithin(target, viemRoot)) {
    if (viemWritePrimitives.has(target.name)) return 'write'
    if (viemReadPrimitives.has(target.name)) return 'read'
    if (viemNeutralPrimitives.has(target.name)) return 'neutral'
    return 'unknown'
  }
  if (symbolDeclarationsInDefaultLibrary(target, defaultLibraryPaths)
    && standardPurePrimitives.has(target.name)) return 'neutral'
  return 'unknown'
}

function runtimeEvidence(
  sourceFile: SourceFile,
  checker: Checker,
  key: string,
  node: Node,
  definitions: ReadonlyMap<string, Node>,
  viemRoot: string | undefined,
  defaultLibraryPaths: ReadonlySet<string>,
): RuntimeCallableEvidence {
  const [, className = ''] = key.split('\0')
  const localCalls = new Set<string>()
  let hasWrite = false
  let hasRead = false
  let hasUnknownCall = false
  let hasNeutralCall = false
  let calls = 0
  const importedViemEffects = viemImportEffects(sourceFile, checker, viemRoot)
  const localSymbols = new Set<TypeScriptSymbol>()
  const parameters = (node as unknown as { readonly parameters?: readonly Node[] }).parameters ?? []
  for (const parameter of parameters) {
    const name = (parameter as unknown as { readonly name?: Node }).name
    if (name !== undefined && isIdentifier(name)) {
      const symbol = checker.getSymbolAtLocation(name)
      if (symbol !== undefined) localSymbols.add(symbol)
    }
  }
  visitDescendants(node, (child) => {
    if (!isVariableDeclaration(child) || !isIdentifier(child.name)) return
    const symbol = checker.getSymbolAtLocation(child.name)
    if (symbol !== undefined) localSymbols.add(symbol)
  })
  const isAllowedMutationTarget = (target: Node): boolean => {
    if (isIdentifier(target)) {
      const symbol = checker.getSymbolAtLocation(target)
      return symbol !== undefined && localSymbols.has(symbol)
    }
    return key.endsWith('\0#constructor') && isPropertyAccessExpression(target)
      && target.expression.kind === SyntaxKind.ThisKeyword
  }
  visitDescendants(node, (child) => {
    if (isBinaryExpression(child)
      && child.operatorToken.kind >= SyntaxKind.FirstAssignment
      && child.operatorToken.kind <= SyntaxKind.LastAssignment) {
      if (!isAllowedMutationTarget(child.left)) hasUnknownCall = true
      return
    }
    if (isPrefixUnaryExpression(child) || isPostfixUnaryExpression(child)) {
      if ((child.operator === SyntaxKind.PlusPlusToken || child.operator === SyntaxKind.MinusMinusToken)
        && !isAllowedMutationTarget(child.operand)) hasUnknownCall = true
      return
    }
    if (child.kind === SyntaxKind.DeleteExpression) {
      hasUnknownCall = true
      return
    }
    if (isNewExpression(child)) {
      calls += 1
      if (!isIdentifier(child.expression)) {
        hasUnknownCall = true
        return
      }
      const primitive = primitiveEffect(child.expression, checker, viemRoot, defaultLibraryPaths)
      if (primitive === 'neutral') hasNeutralCall = true
      else hasUnknownCall = true
      return
    }
    if (!isCallExpression(child)) return
    calls += 1
    const expression = child.expression
    if (isPropertyAccessExpression(expression)) {
      const member = expression.name.text
      if (isPropertyAccessExpression(expression.expression)
        && expression.expression.expression.kind === SyntaxKind.ThisKeyword) {
        const target = runtimeCallableKey(sourceFile.fileName, className || undefined, member)
        if (definitions.has(target)) {
          localCalls.add(target)
          return
        }
      }
      if (expression.expression.kind === SyntaxKind.ThisKeyword) {
        const target = runtimeCallableKey(sourceFile.fileName, className || undefined, member)
        if (definitions.has(target)) {
          localCalls.add(target)
          return
        }
      }
      const primitive = primitiveEffect(expression.name, checker, viemRoot, defaultLibraryPaths)
      if (primitive === 'write') hasWrite = true
      else if (primitive === 'read') hasRead = true
      else if (primitive === 'neutral') hasNeutralCall = true
      else if (primitive === 'unknown') hasUnknownCall = true
      return
    }
    if (isIdentifier(expression)) {
      const calledSymbol = checker.getSymbolAtLocation(expression)
      const importedViemEffect = calledSymbol === undefined
        ? undefined
        : importedViemEffects.get(calledSymbol) ?? importedViemEffects.get(canonicalSymbol(calledSymbol, checker))
      if (importedViemEffect !== undefined) {
        if (importedViemEffect === 'write') hasWrite = true
        else if (importedViemEffect === 'read') hasRead = true
        else if (importedViemEffect === 'neutral') hasNeutralCall = true
        else if (importedViemEffect === 'unknown') hasUnknownCall = true
        return
      }
      const target = runtimeCallableKey(sourceFile.fileName, undefined, expression.text)
      if (definitions.has(target)) {
        localCalls.add(target)
        return
      }
      if (calledSymbol !== undefined) {
        const called = canonicalSymbol(calledSymbol, checker)
        const paths = [...new Set(called.declarations.flatMap((declaration) => {
          const path = declarationSourceFileName(declaration)
          return path === undefined ? [] : [path]
        }))]
        if (paths.length === 1 && paths[0] !== undefined) {
          const importedTarget = runtimeCallableKey(paths[0], undefined, called.name)
          if (definitions.has(importedTarget)) {
            localCalls.add(importedTarget)
            return
          }
        }
      }
      const primitive = primitiveEffect(expression, checker, viemRoot, defaultLibraryPaths)
      if (primitive === 'write') hasWrite = true
      else if (primitive === 'read') hasRead = true
      else if (primitive === 'neutral') hasNeutralCall = true
      else if (primitive === 'unknown') hasUnknownCall = true
      return
    }
    hasUnknownCall = true
  })
  return {
    key,
    localCalls: [...localCalls],
    hasWrite,
    hasRead,
    hasUnknownCall,
    hasNeutralCall,
    isLocalComputation: calls === 0,
  }
}

function isCompilerGeneratedNumericEnumInitialization(statement: Node, sourceFile: SourceFile): boolean {
  const text = statement.getText(sourceFile).trim()
  const match = /^\(function \(([A-Za-z_$][A-Za-z0-9_$]*)\) \{([\s\S]*)\}\)\(\1 \|\| \(\1 = \{\}\)\);$/.exec(text)
  if (match === null || match[1] === undefined || match[2] === undefined) return false
  const name = match[1].replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const assignment = new RegExp(`^${name}\\[${name}\\["[^"]+"\\] = -?[0-9]+\\] = "[^"]+";$`)
  const lines = match[2].split(';').map((line) => line.trim()).filter(Boolean).map((line) => `${line};`)
  return lines.length > 0 && lines.every((line) => assignment.test(line))
}

function moduleInitializationIsUnsafe(
  sourceFile: SourceFile,
  checker: Checker,
  definitions: ReadonlyMap<string, Node>,
  evidence: ReadonlyMap<string, RuntimeCallableEvidence>,
  viemRoot: string | undefined,
  defaultLibraryPaths: ReadonlySet<string>,
): boolean {
  let initializationIndex = 0
  const nodeIsUnsafe = (node: Node): boolean => {
    const key = runtimeCallableKey(sourceFile.fileName, '#module', `#init_${initializationIndex}`)
    initializationIndex += 1
    const initialization = runtimeEvidence(
      sourceFile,
      checker,
      key,
      node,
      definitions,
      viemRoot,
      defaultLibraryPaths,
    )
    const combined = new Map(evidence)
    combined.set(key, initialization)
    return resolveRuntimeEffect(key, combined) !== 'read'
  }
  for (const statement of sourceFile.statements) {
    if (isImportDeclaration(statement) || isExportDeclaration(statement) || isFunctionDeclaration(statement)) continue
    if (isClassDeclaration(statement)) {
      const classNode = statement as unknown as { readonly heritageClauses?: readonly unknown[] }
      if ((classNode.heritageClauses?.length ?? 0) > 0) return true
      for (const member of statement.members) {
        if (isClassStaticBlockDeclaration(member)) return true
        const flags = (member as unknown as { readonly modifierFlags?: ModifierFlags }).modifierFlags ?? ModifierFlags.None
        if ((flags & ModifierFlags.Static) === 0) continue
        if (isConstructorDeclaration(member) || isMethodDeclaration(member)) continue
        if (!isPropertyDeclaration(member) || member.initializer === undefined || nodeIsUnsafe(member)) return true
      }
      continue
    }
    if (statement.kind === SyntaxKind.VariableStatement) {
      if (nodeIsUnsafe(statement)) return true
      continue
    }
    if (statement.kind === SyntaxKind.ExpressionStatement
      && isCompilerGeneratedNumericEnumInitialization(statement, sourceFile)) continue
    // Arbitrary top-level statements execute during module import. Treat them
    // as unsafe instead of trying to infer whether their external effects matter.
    return true
  }
  return false
}

function resolveRuntimeEffect(
  key: string,
  evidence: ReadonlyMap<string, RuntimeCallableEvidence>,
  active: Set<string> = new Set(),
): RuntimeAnalyzedEffect {
  if (active.has(key)) return 'unsafe'
  const current = evidence.get(key)
  if (current === undefined || current.hasUnknownCall) return 'unsafe'
  active.add(key)
  try {
    const localEffects = current.localCalls.map((callee) => resolveRuntimeEffect(callee, evidence, active))
    if (localEffects.includes('unsafe')) return 'unsafe'
    if (current.hasWrite || localEffects.includes('write')) return 'write'
    if (current.hasRead || current.hasNeutralCall || current.isLocalComputation
      || (!current.hasUnknownCall && current.localCalls.length > 0)) return 'read'
    return 'unsafe'
  } finally {
    active.delete(key)
  }
}

function runtimeSourcePath(symbol: TypeScriptSymbol, label: string): string {
  const paths = [...new Set(symbol.declarations.flatMap((declaration) => {
    const fileName = declarationSourceFileName(declaration)
    return fileName === undefined ? [] : [resolve(fileName)]
  }))]
  if (paths.length !== 1 || paths[0] === undefined) {
    throw new Error(`${label} does not resolve to one runtime source`)
  }
  return paths[0]
}

function runtimeSignatures(symbol: TypeScriptSymbol, checker: Checker, label: string): readonly Signature[] {
  const signatures = checker.getSignaturesOfType(requiredSymbolType(symbol, checker, label), SignatureKind.Call)
  if (signatures.length !== 1 || signatures[0] === undefined) {
    throw new Error(`${label} is not one unambiguous runtime callable`)
  }
  return signatures
}

function validateRuntimeParameterBinding(
  label: string,
  declarationSignature: Signature,
  runtimeSignature: Signature,
): void {
  const declarationParameters = declarationSignature.getParameters()
  const runtimeParameters = runtimeSignature.getParameters()
  if (runtimeParameters.length !== declarationParameters.length) {
    throw new Error(`${label} runtime parameter count does not match its declaration`)
  }
  if ([...declarationParameters, ...runtimeParameters].some((parameter) => parameter.declarations.some((declaration) =>
    (declaration.resolve() as unknown as { readonly dotDotDotToken?: unknown }).dotDotDotToken !== undefined))) {
    throw new Error(`${label} uses an unsupported rest parameter`)
  }
  if (runtimeParameters.some((parameter, index) => parameter.name !== declarationParameters[index]?.name)) {
    throw new Error(`${label} runtime parameter order does not match its declaration`)
  }
}

function relativeRuntimeModule(sourcePath: string, specifier: string, packageRoot: string): string {
  if (!specifier.startsWith('.')) throw new Error(`runtime public export points outside agent-sdk: ${specifier}`)
  const path = resolve(dirname(sourcePath), specifier)
  if (!isWithin(path, packageRoot) || !/\.[cm]?js$/i.test(path)) {
    throw new Error(`runtime public export has an unsupported target: ${specifier}`)
  }
  return path
}

function inspectRuntimeSurface(
  candidates: readonly Candidate[],
  metadata: SourceMetadata,
  declarationChecker: Checker,
): {
  readonly effects: ReadonlyMap<Candidate, OperationEffect>
  readonly reviewedRuntimeFiles: readonly ReviewedRuntimeFileMetadata[]
  readonly viemRoot: string | undefined
  readonly trustedRuntimePackages: readonly ReviewedPackageMetadata[]
} {
  const virtualRoot = join(metadata.packageRoot, '.tas-runtime-review-virtual')
  if (existsSync(virtualRoot)) throw new Error(`reserved runtime review path exists: ${virtualRoot}`)
  const virtualFiles = new Map<string, string>()
  const virtualToReal = new Map<string, string>()
  const virtualDirectories = new Set<string>([virtualRoot])
  let discoveredFiles = 0
  let discoveredBytes = 0
  const pendingDirectories: { readonly directory: string; readonly depth: number }[] = [
    { directory: metadata.packageRoot, depth: 0 },
  ]
  const visitedDirectories = new Set<string>()
  let discoveredEntries = 0
  while (pendingDirectories.length > 0) {
    const current = pendingDirectories.pop() as { readonly directory: string; readonly depth: number }
    if (current.depth > maximumRuntimeTreeDepth) throw new Error('agent-sdk runtime package tree exceeds its directory depth budget')
    const canonicalDirectory = realpathSync(current.directory)
    if (visitedDirectories.has(canonicalDirectory)) throw new Error('agent-sdk runtime package tree contains a directory cycle')
    visitedDirectories.add(canonicalDirectory)
    if (visitedDirectories.size > maximumRuntimeTreeDirectories) {
      throw new Error('agent-sdk runtime package tree exceeds its directory budget')
    }
    const entries = readdirSync(current.directory, { withFileTypes: true })
    discoveredEntries += entries.length
    if (discoveredEntries > maximumRuntimeTreeEntries) throw new Error('agent-sdk runtime package tree exceeds its entry budget')
    for (const entry of entries) {
      const path = join(current.directory, entry.name)
      if (entry.isSymbolicLink()) continue
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules') continue
        pendingDirectories.push({ directory: path, depth: current.depth + 1 })
        continue
      }
      if (!entry.isFile() || !/\.[cm]?js$/i.test(entry.name)) continue
      const content = readFileSync(path, 'utf8')
      discoveredFiles += 1
      discoveredBytes += Buffer.byteLength(content, 'utf8')
      if (discoveredFiles > maximumReviewedDeclarations || discoveredBytes > maximumReviewedBytes) {
        throw new Error('agent-sdk runtime package tree exceeds its bounded budget')
      }
      const relativePath = relative(metadata.packageRoot, path)
      const virtualPath = join(virtualRoot, relativePath)
      virtualFiles.set(virtualPath, content)
      virtualToReal.set(virtualPath, path)
      let parent = dirname(virtualPath)
      while (isWithin(parent, virtualRoot)) {
        virtualDirectories.add(parent)
        if (parent === virtualRoot) break
        parent = dirname(parent)
      }
    }
  }
  const runtimePaths = [...new Set(metadata.entrypoints.map(({ runtimePath }) => {
    const virtualPath = join(virtualRoot, relative(metadata.packageRoot, runtimePath))
    if (!virtualFiles.has(virtualPath)) throw new Error(`runtime entrypoint is absent from the reviewed package tree: ${runtimePath}`)
    return virtualPath
  }))]
  const api = new API({
    cwd: virtualRoot,
    fs: {
      readFile: (path) => virtualFiles.get(path),
      fileExists: (path) => virtualFiles.has(path) ? true : undefined,
      directoryExists: (path) => virtualDirectories.has(path) ? true : undefined,
      getAccessibleEntries: (_path) => undefined,
      realpath: (path) => virtualFiles.has(path) || virtualDirectories.has(path) ? path : undefined,
    },
  })
  let viemRoot: string | undefined
  let trustedViemPackage: ReviewedPackageMetadata | undefined
  let viemResolutionError: string | undefined
  try {
    const viemPackageJsonPath = resolveInstalledPackageJson(createRequire(join(metadata.packageRoot, 'package.json')), 'viem')
    viemRoot = dirname(viemPackageJsonPath)
    if (metadata.lockRoot === undefined || metadata.lockPackages === undefined) {
      throw new Error('viem runtime provenance has no lock metadata')
    }
    const packageJson = asRecord(JSON.parse(readFileSync(viemPackageJsonPath, 'utf8')) as unknown, 'viem package.json')
    const locked = resolveLockedPackage('viem', viemPackageJsonPath, metadata.lockRoot, metadata.lockPackages)
    if (locked.packageVersion !== requiredString(packageJson, 'version', 'viem package.json')) {
      throw new Error('installed viem runtime identity is inconsistent')
    }
    trustedViemPackage = {
      packageName: locked.packageName,
      packageVersion: locked.packageVersion,
      packageIntegrity: locked.packageIntegrity,
    }
  } catch (error) {
    viemRoot = undefined
    viemResolutionError = error instanceof Error ? error.message : String(error)
  }
  let snapshot: ReturnType<API['updateSnapshot']> | undefined
  try {
    snapshot = api.updateSnapshot({ openFiles: [...virtualFiles.keys()] })
    const definitions = new Map<string, Node>()
    const constructionKeys = new Map<string, readonly string[]>()
    const sources = new Map<string, {
      readonly sourceFile: SourceFile
      readonly checker: Checker
      readonly defaultLibraryPaths: ReadonlySet<string>
    }>()
    const entrypointSources = new Map<string, {
      readonly sourceFile: SourceFile
      readonly checker: Checker
    }>()
    for (const runtimePath of virtualFiles.keys()) {
      const project = snapshot.getDefaultProjectForFile(runtimePath)
      const sourceFile = project?.program.getSourceFile(runtimePath)
      if (project === undefined || sourceFile === undefined) throw new Error(`TypeScript did not parse reviewed runtime file ${runtimePath}`)
      const entrypoint = metadata.entrypoints.find((item) =>
        join(virtualRoot, relative(metadata.packageRoot, item.runtimePath)) === runtimePath)
      if (entrypoint !== undefined) entrypointSources.set(entrypoint.entrypoint, { sourceFile, checker: project.checker })
      const defaultLibraryPaths = new Set(project.program.getSourceFileNames().flatMap((fileName) => {
        const file = project.program.getSourceFile(fileName)
        return file !== undefined && project.program.isSourceFileDefaultLibrary(file)
          ? [canonicalCompilerPath(file.fileName)]
          : []
      }))
      for (const fileName of project.program.getSourceFileNames()) {
        const absolute = resolve(fileName)
        if (!isWithin(absolute, virtualRoot) || !/\.(?:[cm]?js)$/i.test(absolute)) continue
        const runtimeSource = project.program.getSourceFile(fileName)
        if (runtimeSource === undefined) throw new Error(`runtime source disappeared from the TypeScript Program: ${absolute}`)
        sources.set(absolute, { sourceFile: runtimeSource, checker: project.checker, defaultLibraryPaths })
      }
    }
    const reachablePaths = new Set<string>()
    let usesViemRuntime = false
    const pendingPaths = [...runtimePaths]
    while (pendingPaths.length > 0) {
      const runtimePath = pendingPaths.pop() as string
      if (reachablePaths.has(runtimePath)) continue
      const source = sources.get(runtimePath)
      if (source === undefined) throw new Error(`runtime export closure is not parsed: ${runtimePath}`)
      reachablePaths.add(runtimePath)
      for (const statement of source.sourceFile.statements) {
        if (!isImportDeclaration(statement) && !isExportDeclaration(statement)) continue
        const moduleSpecifier = statement.moduleSpecifier
        if (moduleSpecifier === undefined || !('text' in moduleSpecifier) || typeof moduleSpecifier.text !== 'string') continue
        if (!moduleSpecifier.text.startsWith('.')) {
          const specifier = moduleSpecifier.text
          if ((specifier !== 'viem' && !specifier.startsWith('viem/')) || viemRoot === undefined) {
            throw new Error(`unsupported external runtime import ${JSON.stringify(specifier)}${viemResolutionError === undefined ? '' : `: ${viemResolutionError}`}`)
          }
          usesViemRuntime = true
          const realSourcePath = virtualToReal.get(runtimePath)
          if (realSourcePath === undefined) throw new Error(`runtime source has no reviewed package file: ${runtimePath}`)
          let resolvedImport: string
          try {
            resolvedImport = createRequire(realSourcePath).resolve(specifier)
          } catch {
            throw new Error(`allowed viem runtime import is unresolved: ${specifier}`)
          }
          if (!isWithin(realpathSync(resolvedImport), realpathSync(viemRoot))) {
            throw new Error(`runtime import ${JSON.stringify(specifier)} does not resolve to the reviewed viem package`)
          }
          continue
        }
        const target = relativeRuntimeModule(runtimePath, moduleSpecifier.text, virtualRoot)
        if (!virtualFiles.has(target)) throw new Error(`runtime module is missing: ${target}`)
        pendingPaths.push(target)
      }
    }
    for (const runtimePath of [...sources.keys()]) {
      if (!reachablePaths.has(runtimePath)) sources.delete(runtimePath)
    }
    for (const [runtimePath, source] of sources) {
      assertNoUnsupportedRuntimeDispatch(source.sourceFile)
      for (const [key, node] of callableDefinitions(source.sourceFile)) definitions.set(key, node)
      const construction = classConstructionDefinitions(source.sourceFile)
      for (const [key, node] of construction.definitions) definitions.set(key, node)
      for (const [key, values] of construction.keysByClass) constructionKeys.set(key, values)
    }
    const evidence = new Map<string, RuntimeCallableEvidence>()
    for (const [key, node] of definitions) {
      const runtimePath = key.split('\0')[0] as string
      const source = sources.get(runtimePath)
      if (source === undefined) throw new Error('reviewed runtime source lookup is inconsistent')
      evidence.set(key, runtimeEvidence(
        source.sourceFile,
        source.checker,
        key,
        node,
        definitions,
        viemRoot,
        source.defaultLibraryPaths,
      ))
    }
    const unsafeModuleInitialization = [...sources.values()].some((source) => moduleInitializationIsUnsafe(
      source.sourceFile,
      source.checker,
      definitions,
      evidence,
      viemRoot,
      source.defaultLibraryPaths,
    ))
    if (unsafeModuleInitialization) {
      throw new Error('agent-sdk runtime closure has unsafe module initialization')
    }
    const effects = new Map<Candidate, OperationEffect>()
    for (const candidate of candidates) {
      const entrypointSource = entrypointSources.get(candidate.entrypoint)
      if (entrypointSource === undefined) throw new Error(`runtime entrypoint is missing: ${candidate.entrypoint}`)
      const moduleSymbol = entrypointSource.checker.getSymbolAtLocation(entrypointSource.sourceFile)
      const exported = moduleSymbol?.getExports().get(candidate.exportName as never)
      if (exported === undefined) {
        throw new Error(`${candidate.exportName} is declared but missing from runtime export ${candidate.entrypoint}`)
      }
      const runtimeChecker = entrypointSource.checker
      const runtimeExport = canonicalSymbol(exported, runtimeChecker)
      const declarationSignature = runtimeSignatures(
        candidate.symbol,
        declarationChecker,
        `${candidate.exportName}${candidate.member === undefined ? '' : `.${candidate.member}`} declaration`,
      )[0] as Signature
      let runtimeSymbol = runtimeExport
      let className: string | undefined
      if (candidate.kind === 'class_method') {
        if ((runtimeExport.flags & SymbolFlags.Class) === 0 || candidate.member === undefined) {
          throw new Error(`${candidate.exportName} is not a runtime class matching its declaration`)
        }
        className = runtimeExport.name
        const runtimeClassDeclarations: ClassDeclaration[] = runtimeExport.declarations.flatMap((declaration) => {
          const node = declaration.resolve()
          return node !== undefined && isClassDeclaration(node) ? [node] : []
        })
        if (runtimeClassDeclarations.length !== 1 || runtimeClassDeclarations[0] === undefined) {
          throw new Error(`${candidate.exportName} runtime class declaration is ambiguous`)
        }
        const runtimeClassDeclaration = runtimeClassDeclarations[0]
        if ((runtimeClassDeclaration.heritageClauses?.length ?? 0) > 0) {
          throw new Error(`${candidate.exportName} runtime class heritage is unsupported in v0.1`)
        }
        for (const member of runtimeClassDeclaration.members) {
          if (isGetAccessorDeclaration(member) || isSetAccessorDeclaration(member)) {
            throw new Error(`${candidate.exportName} runtime accessor is unsupported in v0.1`)
          }
          const memberName = (member as unknown as { readonly name?: Node }).name
          if (memberName !== undefined && !isIdentifier(memberName)) {
            throw new Error(`${candidate.exportName} runtime computed member is unsupported in v0.1`)
          }
        }
        const declarationConstructors = declarationChecker.getSignaturesOfType(
          requiredSymbolType(candidate.classSymbol as TypeScriptSymbol, declarationChecker, `${candidate.exportName} declaration class`),
          SignatureKind.Construct,
        )
        const runtimeConstructors = runtimeChecker.getSignaturesOfType(
          requiredSymbolType(runtimeExport, runtimeChecker, `${candidate.exportName} runtime class`),
          SignatureKind.Construct,
        )
        if (declarationConstructors.length !== 1 || declarationConstructors[0] === undefined
          || runtimeConstructors.length !== 1 || runtimeConstructors[0] === undefined) {
          throw new Error(`${candidate.exportName} has no unambiguous declaration/runtime constructor binding`)
        }
        validateRuntimeParameterBinding(
          `${candidate.exportName} constructor`,
          declarationConstructors[0],
          runtimeConstructors[0],
        )
        const member = runtimeChecker.getPropertyOfType(
          runtimeChecker.getDeclaredTypeOfSymbol(runtimeExport),
          candidate.member,
        )
        if (member === undefined || (member.flags & SymbolFlags.Method) === 0) {
          throw new Error(`${candidate.exportName}.${candidate.member} is missing from the runtime class`)
        }
        runtimeSymbol = canonicalSymbol(member, runtimeChecker)
      }
      const runtimeSignature = runtimeSignatures(
        runtimeSymbol,
        runtimeChecker,
        `${candidate.exportName}${candidate.member === undefined ? '' : `.${candidate.member}`} runtime`,
      )[0] as Signature
      validateRuntimeParameterBinding(
        `${candidate.exportName}${candidate.member === undefined ? '' : `.${candidate.member}`}`,
        declarationSignature,
        runtimeSignature,
      )
      const path = runtimeSourcePath(runtimeSymbol, `${candidate.exportName} runtime`)
      if (!sources.has(path)) throw new Error(`${candidate.exportName} runtime binding is outside the reviewed export closure`)
      const key = runtimeCallableKey(path, className, runtimeSymbol.name)
      if (!definitions.has(key)) throw new Error(`${candidate.exportName} runtime implementation is not statically analyzable`)
      const analyzedEffect = resolveRuntimeEffect(key, evidence)
      if (analyzedEffect === 'unsafe') {
        throw new Error(`${candidate.exportName}${candidate.member === undefined ? '' : `.${candidate.member}`} has unsafe or unproven runtime behavior`)
      }
      if (className !== undefined) {
        const classPath = runtimeSourcePath(runtimeExport, `${candidate.exportName} runtime class`)
        const constructorEffects = (constructionKeys.get(`${classPath}\0${className}`) ?? [])
          .map((constructionKey) => resolveRuntimeEffect(constructionKey, evidence))
        if (constructorEffects.includes('unsafe')) {
          throw new Error(`${candidate.exportName} has unsafe or unproven runtime construction`)
        }
        if (constructorEffects.includes('write')) {
          throw new Error(`${candidate.exportName} runtime constructor performs a chain write`)
        }
      }
      const effect: OperationEffect = analyzedEffect === 'write' ? 'side_effect' : 'read'
      effects.set(candidate, effect)
    }
    const before = new Map<string, Buffer>()
    let bytes = 0
    for (const runtimePath of sources.keys()) {
      const realPath = virtualToReal.get(runtimePath)
      if (realPath === undefined) throw new Error(`runtime source has no reviewed package file: ${runtimePath}`)
      const content = readFileSync(realPath)
      bytes += content.byteLength
      if (before.size + 1 > maximumReviewedDeclarations || bytes > maximumReviewedBytes) {
        throw new Error('agent-sdk reviewed runtime closure exceeds its bounded budget')
      }
      const sourceText = sources.get(runtimePath)?.sourceFile.text
      if (sourceText === undefined || content.toString('utf8') !== sourceText
        || !Buffer.from(sourceText, 'utf8').equals(content)) {
        throw new Error(`reviewed runtime source is not stable UTF-8: ${runtimePath}`)
      }
      before.set(realPath, content)
    }
    const reviewedRuntimeFiles = [...before.entries()].map(([realPath, content]) => {
      if (!readFileSync(realPath).equals(content)) {
        throw new Error(`reviewed runtime source changed during analysis: ${realPath}`)
      }
      const relativePath = relative(metadata.packageRoot, realPath).split(sep).join('/')
      if (relativePath === '' || relativePath.startsWith('../') || isAbsolute(relativePath)) {
        throw new Error('reviewed runtime source has an unsafe package-relative path')
      }
      return {
        packageName: metadata.packageName,
        packageVersion: metadata.packageVersion,
        packageRelativePath: relativePath,
        sha256: `sha256:${createHash('sha256').update(content).digest('hex')}` as const,
      }
    }).toSorted((left, right) => stableCompare(left.packageRelativePath, right.packageRelativePath))
    return {
      effects,
      reviewedRuntimeFiles,
      viemRoot,
      trustedRuntimePackages: usesViemRuntime && trustedViemPackage !== undefined ? [trustedViemPackage] : [],
    }
  } finally {
    closeCompilerSession(snapshot, api)
  }
}

function isProvenByteArray(type: Type, state: SchemaState): boolean {
  const symbol = type.getSymbol()
  if (symbol?.name !== 'Uint8Array') return false
  const paths = symbol.declarations.map(declarationPath)
  return paths.length > 0 && paths.every((path) => path !== undefined && state.defaultLibraryPaths.has(path))
}

function bigintSchema(): JsonSchema {
  return { type: 'string', format: 'bigint', pattern: bigintPattern, maxLength: maximumBigintLength }
}

function bytesSchema(): JsonSchema {
  return {
    type: 'object',
    'x-tas-type': 'bytes',
    properties: {
      encoding: { type: 'string', const: 'hex' },
      value: { type: 'string', format: 'hex' },
    },
    required: ['encoding', 'value'],
    additionalProperties: false,
  }
}

function charge(state: SchemaState): void {
  state.nodes += 1
  if (state.nodes > maximumSchemaNodes) throw new Error(`schema type graph exceeds ${maximumSchemaNodes} nodes`)
}

function withoutUndefined(type: Type): readonly Type[] {
  const parts = type.isUnionType() ? type.getTypes() : [type]
  return parts.filter((part) => (part.flags & (TypeFlags.Undefined | TypeFlags.Never)) === 0)
}

function stringSchemasOverlap(left: JsonSchema, right: JsonSchema): boolean {
  if (left.type !== 'string' || right.type !== 'string') return false
  if (left.const === undefined || right.const === undefined) return true
  return left.const === right.const
}

function equivalentOverlappingStringUnion(schemas: readonly JsonSchema[]): boolean {
  if (schemas.length < 2 || !schemas.every((schema) => schema.type === 'string')) return false
  return schemas.some((left, index) => schemas.some((right, otherIndex) =>
    index < otherIndex && stringSchemasOverlap(left, right)))
}

function encodeType(type: Type, state: SchemaState, position: 'input' | 'output'): JsonSchema {
  charge(state)
  const checker = state.checker
  if ((type.flags & (TypeFlags.Any | TypeFlags.Unknown | TypeFlags.ESSymbol | TypeFlags.Never)) !== 0 || type.isErrorType()) {
    throw new Error(`type ${checker.typeToString(type)} is not a finite JSON boundary`)
  }
  if ((type.flags & TypeFlags.Void) !== 0) return { type: 'null' }
  if (type.isTypeParameter()) {
    throw new Error(`type parameter ${checker.typeToString(type)} is unsupported at the JSON boundary`)
  }
  if (type.isUnionType()) {
    const parts = withoutUndefined(type)
    if (parts.length === 0) throw new Error(`type ${checker.typeToString(type)} has no JSON value`)
    if (parts.length === 1) return encodeType(parts[0] as Type, state, position)
    const booleanLiterals = new Set(parts
      .filter((part) => part.isBooleanLiteralType())
      .map((part) => checker.typeToString(part)))
    if (parts.length === 2 && booleanLiterals.size === 2
      && booleanLiterals.has('false') && booleanLiterals.has('true')) return { type: 'boolean' }
    const schemas = parts.map((part) => encodeType(part, state, position))
    return equivalentOverlappingStringUnion(schemas) ? { anyOf: schemas } : { oneOf: schemas }
  }
  if (checker.getSignaturesOfType(type, SignatureKind.Call).length > 0) {
    throw new Error(`callback type ${checker.typeToString(type)} is unsupported at the JSON boundary`)
  }
  if (isProvenByteArray(type, state)) return bytesSchema()
  if ((type.flags & TypeFlags.Null) !== 0) return { type: 'null' }
  if (type.isStringLiteralType()) return { type: 'string', const: type.value }
  if (type.isNumberLiteralType()) return { type: 'number', const: type.value }
  if (type.isBigIntLiteralType()) {
    const value = type.value.toString(10)
    if (value.length > maximumBigintLength) throw new Error('bigint literal exceeds the finite wire limit')
    return { ...bigintSchema(), const: value }
  }
  if (type.isBooleanLiteralType()) return { type: 'boolean', const: checker.typeToString(type) === 'true' }
  if ((type.flags & TypeFlags.String) !== 0) return { type: 'string' }
  if ((type.flags & TypeFlags.Boolean) !== 0) return { type: 'boolean' }
  if ((type.flags & TypeFlags.Number) !== 0 || (type.flags & TypeFlags.EnumLiteral) !== 0) return { type: 'number' }
  if ((type.flags & TypeFlags.BigInt) !== 0) return bigintSchema()
  if ((type.flags & TypeFlags.TemplateLiteral) !== 0 || checker.isTypeAssignableTo(type, checker.getStringType())) {
    const name = typeName(type)
    const rendered = checker.typeToString(type)
    if (name === 'Address' || rendered === 'Address') return { type: 'string', format: 'evm-address' }
    return /0x/.test(rendered) || name === 'Hex'
      ? { type: 'string', format: 'hex' }
      : { type: 'string' }
  }
  if (checker.isTupleType(type)) {
    const elements = type.isTypeReference() ? checker.getTypeArguments(type) : []
    return {
      type: 'array',
      prefixItems: elements.map((element) => encodeType(element, state, position)),
      minItems: elements.length,
      maxItems: elements.length,
      items: false,
    }
  }
  if (checker.isArrayLikeType(type)) {
    const arguments_ = type.isTypeReference() ? checker.getTypeArguments(type) : []
    if (arguments_.length !== 1 || arguments_[0] === undefined) {
      throw new Error(`array type ${checker.typeToString(type)} has no finite element type`)
    }
    return { type: 'array', items: encodeType(arguments_[0], state, position) }
  }
  if (state.active.has(type.id)) throw new Error(`recursive type ${checker.typeToString(type)} is not finite`)
  state.active.add(type.id)
  try {
    const properties = checker.getPropertiesOfType(type).toSorted((left, right) => stableCompare(left.name, right.name))
    const indexes = checker.getIndexInfosOfType(type)
    if (properties.length === 0 && indexes.length === 1 && indexes[0] !== undefined) {
      if ((indexes[0].keyType.flags & TypeFlags.String) === 0) throw new Error('only string-keyed maps are supported')
      return { type: 'object', additionalProperties: encodeType(indexes[0].valueType, state, position) }
    }
    if (indexes.length > 0) throw new Error(`type ${checker.typeToString(type)} has unsupported index signatures`)
    if (properties.length === 0) throw new Error(`type ${checker.typeToString(type)} has no finite JSON properties`)
    const encodedProperties: Record<string, JsonSchema> = Object.create(null) as Record<string, JsonSchema>
    const required: string[] = []
    for (const property of properties) {
      const propertyType = requiredSymbolType(property, checker, `property ${property.name}`)
      const parts = withoutUndefined(propertyType)
      if (parts.length === 0) continue
      encodedProperties[property.name] = encodeType(
        parts.length === 1 ? parts[0] as Type : propertyType,
        state,
        position,
      )
      if ((property.flags & SymbolFlags.Optional) === 0) required.push(property.name)
    }
    return { type: 'object', properties: encodedProperties, required, additionalProperties: false }
  } finally {
    state.active.delete(type.id)
  }
}

function unwrapPromise(type: Type, checker: Checker): Type {
  if (typeName(type) === 'Promise' && type.isTypeReference()) {
    return checker.getTypeArguments(type)[0] ?? type
  }
  return type
}

function schemaState(checker: Checker, defaultLibraryPaths: ReadonlySet<string>): SchemaState {
  return { checker, active: new Set(), defaultLibraryPaths, nodes: 0 }
}

function isInjectedRuntimeConfig(type: Type, checker: Checker, packageRoot: string): boolean {
  const name = typeName(type)
  if (name !== 'AgentVerifiableConfig' && (name === undefined || !name.endsWith('ClientConfig'))) return false
  const properties = checker.getPropertiesOfType(type)
  if (properties.length !== 2) return false
  const byName = new Map(properties.map((property) => [property.name, property]))
  const rpcUrl = byName.get('rpcUrl')
  const address = byName.get('address')
  if (rpcUrl === undefined || address === undefined
    || (rpcUrl.flags & SymbolFlags.Optional) !== 0
    || (address.flags & SymbolFlags.Optional) !== 0) return false
  if (![rpcUrl, address].every((property) => property.declarations.length > 0
    && property.declarations.every((declaration) => {
      const path = declarationPath(declaration)
      return path !== undefined && isWithin(path, canonicalCompilerPath(packageRoot))
    }))) return false
  const rpcUrlType = requiredSymbolType(rpcUrl, checker, 'runtime config rpcUrl')
  const addressType = requiredSymbolType(address, checker, 'runtime config address')
  return checker.isTypeAssignableTo(rpcUrlType, checker.getStringType())
    && checker.isTypeAssignableTo(addressType, checker.getStringType())
}

function typeIsDeclaredWithin(type: Type, checker: Checker, root: string): boolean {
  const symbols = [type.getAliasSymbol(), type.getSymbol()].filter((symbol): symbol is TypeScriptSymbol => symbol !== undefined)
  return symbols.some((symbol) => {
    const target = canonicalSymbol(symbol, checker)
    return target.declarations.length > 0 && target.declarations.every((declaration) => {
      const path = declarationPath(declaration)
      return path !== undefined && isWithin(path, canonicalCompilerPath(root))
    })
  })
}

function injectedFunctionParameters(
  candidate: Candidate,
  signature: Signature,
  checker: Checker,
  packageRoot: string,
): ReadonlySet<TypeScriptSymbol> {
  if (candidate.kind !== 'function') return new Set()
  const injected = new Set(signature.getParameters().filter((parameter) => parameter.name === 'config'
    && isInjectedRuntimeConfig(
      requiredSymbolType(parameter, checker, `parameter ${parameter.name}`),
      checker,
      packageRoot,
    )))
  if (injected.size > 1) throw new Error(`${candidate.exportName} has multiple injectable runtime config parameters`)
  return injected
}

function parameterIsOptional(parameter: TypeScriptSymbol, type: Type): boolean {
  if ((parameter.flags & SymbolFlags.Optional) !== 0) return true
  if (type.isUnionType() && type.getTypes().some((part) => (part.flags & TypeFlags.Undefined) !== 0)) return true
  return parameter.declarations.some((declaration) => {
    const node = declaration.resolve() as unknown as {
      readonly questionToken?: unknown
      readonly initializer?: unknown
    } | undefined
    return node?.questionToken !== undefined || node?.initializer !== undefined
  })
}

function projectSignature(
  candidate: Candidate,
  signature: Signature,
  checker: Checker,
  defaultLibraryPaths: ReadonlySet<string>,
  injectedParameters: ReadonlySet<TypeScriptSymbol>,
): AgentSdkProjection {
  if ((signature.typeParameters?.length ?? 0) > 0) {
    throw new Error(`${candidate.exportName}${candidate.member === undefined ? '' : `.${candidate.member}`} has an unsupported type parameter`)
  }
  const properties: Record<string, JsonSchema> = Object.create(null) as Record<string, JsonSchema>
  const required: string[] = []
  const state = schemaState(checker, defaultLibraryPaths)
  for (const parameter of signature.getParameters()) {
    if (injectedParameters.has(parameter)) continue
    const parameterType = requiredSymbolType(parameter, checker, `parameter ${parameter.name}`)
    try {
      properties[parameter.name] = encodeType(parameterType, state, 'input')
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      throw new Error(`${candidate.exportName}${candidate.member === undefined ? '' : `.${candidate.member}`} input ${parameter.name}: ${detail}`)
    }
    if (!parameterIsOptional(parameter, parameterType)) {
      required.push(parameter.name)
    }
  }
  const rawReturnType = checker.getReturnTypeOfSignature(signature)
  if (rawReturnType === undefined) throw new Error(`${candidate.exportName} return type is unresolved`)
  const returnType = unwrapPromise(rawReturnType, checker)
  let outputSchema: JsonSchema
  try {
    outputSchema = encodeType(returnType, schemaState(checker, defaultLibraryPaths), 'output')
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    throw new Error(`${candidate.exportName}${candidate.member === undefined ? '' : `.${candidate.member}`} output: ${detail}`)
  }
  return {
    input_schema: {
      $schema: schemaVersion,
      type: 'object',
      properties: Object.fromEntries(Object.entries(properties).toSorted(([left], [right]) => stableCompare(left, right))),
      required,
      additionalProperties: false,
    },
    output_schema: { $schema: schemaVersion, ...outputSchema },
  }
}

function classRuntimeBinding(
  classSymbol: TypeScriptSymbol,
  checker: Checker,
  effect: OperationEffect,
  packageRoot: string,
  fixture: boolean,
  viemRoot: string | undefined,
): {
  readonly runtimeDependencies: readonly ('chain_client' | 'contract_address' | 'account')[]
  readonly credential: 'none' | 'evm_private_key'
} {
  const constructors = checker.getSignaturesOfType(
    requiredSymbolType(classSymbol, checker, `class ${classSymbol.name}`),
    SignatureKind.Construct,
  )
  if (constructors.length === 0) {
    throw new Error(`${classSymbol.name} has no supported config-and-account constructor binding`)
  }
  if (constructors.length !== 1 || constructors[0] === undefined) {
    throw new Error(`${classSymbol.name} has no unambiguous constructor binding`)
  }
  const parameters = constructors[0].getParameters()
  if (parameters.length !== 2 || parameters[0] === undefined || parameters[1] === undefined) {
    throw new Error(`${classSymbol.name} constructor is not the supported config-and-account shape`)
  }
  if (parameters[0].name !== 'config' || parameters[1].name !== 'account') {
    throw new Error(`${classSymbol.name} constructor parameters must be named config and account`)
  }
  const config = requiredSymbolType(parameters[0], checker, `${classSymbol.name} config`)
  const account = requiredSymbolType(parameters[1], checker, `${classSymbol.name} account`)
  const accountAddress = checker.getPropertyOfType(account, 'address')
  const structurallyValid = checker.getPropertyOfType(config, 'rpcUrl') !== undefined
    && checker.getPropertyOfType(config, 'address') !== undefined
    && accountAddress !== undefined
    && checker.isTypeAssignableTo(requiredSymbolType(accountAddress, checker, `${classSymbol.name} account address`), checker.getStringType())
  const provenanceValid = fixture || (isInjectedRuntimeConfig(config, checker, packageRoot)
    && typeName(account) === 'Account'
    && viemRoot !== undefined
    && typeIsDeclaredWithin(account, checker, viemRoot))
  if (!structurallyValid || !provenanceValid) {
    throw new Error(`${classSymbol.name} constructor does not structurally expose chain, contract, and Account injection`)
  }
  return {
    // The installed SDK requires an Account for every Client constructor.
    // Reads receive an address-only Account; only writes require its secret.
    runtimeDependencies: ['chain_client', 'contract_address', 'account'],
    credential: effect === 'read' ? 'none' : 'evm_private_key',
  }
}

function exclusion(candidate: Pick<Candidate, 'entrypoint' | 'exportName' | 'member'>, reasonCode: AgentSdkExclusionReasonCode, reason: string): AgentSdkExcludedCallable {
  return { ...candidate, reasonCode, reason }
}

function classifyCandidate(
  candidate: Candidate,
  checker: Checker,
  defaultLibraryPaths: ReadonlySet<string>,
  runtimeEffect: OperationEffect | undefined,
  packageRoot: string,
  fixture: boolean,
  viemRoot: string | undefined,
): AgentSdkIncludedCallable {
  const callableType = requiredSymbolType(candidate.symbol, checker, `${candidate.exportName} callable`)
  const signatures = checker.getSignaturesOfType(callableType, SignatureKind.Call)
  if (signatures.length !== 1 || signatures[0] === undefined) {
    throw new Error(`${candidate.exportName}${candidate.member === undefined ? '' : `.${candidate.member}`} is not one unambiguous callable`)
  }
  if (runtimeEffect === undefined) {
    throw new Error(`${candidate.exportName}${candidate.member === undefined ? '' : `.${candidate.member}`} has no proven runtime binding`)
  }
  const effect = runtimeEffect
  if (candidate.kind === 'function' && effect === 'side_effect') {
    throw new Error(`${candidate.exportName} is a side-effect function; v0.1 requires side effects to use a config-and-account Client method`)
  }
  const injectedParameters = injectedFunctionParameters(candidate, signatures[0], checker, packageRoot)
  const binding = candidate.classSymbol === undefined
    ? {
        runtimeDependencies: injectedParameters.size === 0
          ? [] as const
          : ['chain_client', 'contract_address'] as const,
        credential: 'none' as const,
      }
    : classRuntimeBinding(candidate.classSymbol, checker, effect, packageRoot, fixture, viemRoot)
  return {
    entrypoint: candidate.entrypoint,
    exportName: candidate.exportName,
    ...(candidate.member === undefined ? {} : { member: candidate.member }),
    toolName: toolName(candidate),
    bindingKind: candidate.kind,
    signature: checker.typeToString(callableType),
    projection: projectSignature(candidate, signatures[0], checker, defaultLibraryPaths, injectedParameters),
    effect,
    completion: effect === 'read' ? 'synchronous' : 'external_handle',
    runtimeDependencies: binding.runtimeDependencies,
    credential: binding.credential,
    invocationArguments: signatures[0].getParameters().map((parameter) => injectedParameters.has(parameter)
      ? { kind: 'runtime' as const, source: 'chain_config' as const }
      : { kind: 'input' as const, name: parameter.name }),
  }
}

function discoverCandidates(
  moduleExports: ReadonlyMap<unknown, TypeScriptSymbol>,
  entrypoint: string,
  checker: Checker,
): { readonly candidates: readonly Candidate[]; readonly excluded: readonly AgentSdkExcludedCallable[] } {
  const candidates: Candidate[] = []
  const excluded: AgentSdkExcludedCallable[] = []
  for (const exported of [...moduleExports.values()].toSorted((left, right) => stableCompare(left.name, right.name))) {
    const symbol = canonicalSymbol(exported, checker)
    if ((symbol.flags & SymbolFlags.Class) !== 0) {
      const instance = checker.getDeclaredTypeOfSymbol(symbol)
      const methods = checker.getPropertiesOfType(instance)
        .filter((member) => (member.flags & SymbolFlags.Method) !== 0 && isPublicInstanceMethod(member))
        .toSorted((left, right) => stableCompare(left.name, right.name))
      if (methods.length === 0) {
        excluded.push(exclusion({ entrypoint, exportName: exported.name }, 'non_callable_export', 'exported class has no public instance methods'))
      }
      for (const member of methods) {
        candidates.push({
          entrypoint,
          exportName: exported.name,
          member: member.name,
          symbol: canonicalSymbol(member, checker),
          classSymbol: symbol,
          kind: 'class_method',
        })
      }
      continue
    }
    const callSignatures = checker.getSignaturesOfType(
      requiredSymbolType(symbol, checker, `export ${exported.name}`),
      SignatureKind.Call,
    )
    if ((symbol.flags & SymbolFlags.Function) !== 0 || callSignatures.length > 0) {
      candidates.push({ entrypoint, exportName: exported.name, symbol, kind: 'function' })
    } else {
      excluded.push(exclusion({ entrypoint, exportName: exported.name }, 'non_callable_export', 'public export is not a callable function or class instance method'))
    }
  }
  return { candidates, excluded }
}

function reviewedClosure(
  program: { readonly getSourceFileNames: () => readonly string[]; readonly getSourceFile: (path: string) => { readonly text: string } | undefined },
  probePath: string,
  metadata: SourceMetadata,
  defaultLibraryPaths: ReadonlySet<string>,
): { readonly reviewedPackages: readonly ReviewedPackageMetadata[]; readonly reviewedDeclarations: readonly ReviewedDeclarationMetadata[] } {
  const packages = new Map<string, ReviewedPackageMetadata>()
  const declarations: ReviewedDeclarationMetadata[] = []
  let bytes = 0
  for (const fileName of program.getSourceFileNames()) {
    const absolute = resolve(fileName)
    if (absolute === resolve(probePath) || defaultLibraryPaths.has(canonicalCompilerPath(absolute))) continue
    const source = program.getSourceFile(fileName)
    if (source === undefined) throw new Error('reviewed declaration disappeared from the TypeScript Program')
    let package_: ReviewedPackageMetadata & { readonly packageRoot: string }
    if (metadata.fixture && isWithin(absolute, metadata.packageRoot)) {
      package_ = {
        packageName: metadata.packageName,
        packageVersion: metadata.packageVersion,
        packageIntegrity: metadata.packageIntegrity,
        packageRoot: metadata.packageRoot,
      }
    } else {
      if (metadata.lockRoot === undefined || metadata.lockPackages === undefined) {
        throw new Error(`reviewed declaration is outside the fixture package: ${fileName}`)
      }
      package_ = resolveReviewedProgramPackage(absolute, metadata.lockRoot, metadata.lockPackages)
    }
    const relativePath = relative(package_.packageRoot, absolute).split(sep).join('/')
    if (relativePath === '' || relativePath.startsWith('../') || isAbsolute(relativePath)) {
      throw new Error('reviewed declaration has an unsafe package-relative path')
    }
    bytes += Buffer.byteLength(source.text, 'utf8')
    if (declarations.length + 1 > maximumReviewedDeclarations || bytes > maximumReviewedBytes) {
      throw new Error('agent-sdk reviewed declaration closure exceeds its bounded budget')
    }
    packages.set(package_.packageName, {
      packageName: package_.packageName,
      packageVersion: package_.packageVersion,
      packageIntegrity: package_.packageIntegrity,
    })
    declarations.push({
      packageName: package_.packageName,
      packageVersion: package_.packageVersion,
      packageRelativePath: relativePath,
      sha256: `sha256:${createHash('sha256').update(source.text, 'utf8').digest('hex')}`,
    })
  }
  const sortedDeclarations = declarations.toSorted((left, right) => stableCompare(
    `${left.packageName}:${left.packageRelativePath}`,
    `${right.packageName}:${right.packageRelativePath}`,
  ))
  const keys = sortedDeclarations.map(({ packageName, packageRelativePath }) => `${packageName}:${packageRelativePath}`)
  if (keys.length === 0 || new Set(keys).size !== keys.length) throw new Error('reviewed declaration closure is empty or duplicated')
  return {
    reviewedPackages: [...packages.values()].toSorted((left, right) => stableCompare(left.packageName, right.packageName)),
    reviewedDeclarations: sortedDeclarations,
  }
}

export function analyzeAgentSdk(input: AnalyzeAgentSdkInput = {}): AgentSdkAnalysis {
  const metadata = resolveMetadata(input)
  const cwd = resolve(input.cwd ?? process.cwd())
  const probeDirectory = metadata.fixture ? metadata.packageRoot : cwd
  const probePath = resolve(probeDirectory, '.tas-agent-sdk-manifest-probe.ts')
  const probeSource = metadata.entrypoints.map((entrypoint, index) =>
    `import * as TASAgentSdkEntrypoint${index} from ${JSON.stringify(entrypoint.moduleSpecifier)}\nexport { TASAgentSdkEntrypoint${index} }`)
    .join('\n') + '\n'
  const ownedFiles = new Map([[probePath, probeSource]])
  const api = new API({
    cwd: probeDirectory,
    fs: {
      readFile: (path) => ownedFiles.get(path),
      fileExists: (path) => ownedFiles.has(path) ? true : undefined,
      directoryExists: (_path) => undefined,
      getAccessibleEntries: (_path) => undefined,
      realpath: (_path) => undefined,
    },
  })
  let snapshot: ReturnType<API['updateSnapshot']> | undefined
  try {
    snapshot = api.updateSnapshot({ openFiles: [probePath] })
    const project = snapshot.getDefaultProjectForFile(probePath)
    const sourceFile = project?.program.getSourceFile(probePath)
    if (project === undefined || sourceFile === undefined) throw new Error('TypeScript did not resolve the agent-sdk analyzer probe')
    const diagnostics = project.program.getSemanticDiagnostics(probePath)
    if (diagnostics.length > 0) {
      throw new Error(`agent-sdk analyzer probe has semantic diagnostics: ${diagnostics.map(({ text }) => text).join('; ')}`)
    }
    const probeExports = project.checker.getSymbolAtLocation(sourceFile)?.getExports()
    if (probeExports === undefined) throw new Error('agent-sdk analyzer probe has no exports')
    const defaultLibraryPaths = new Set(project.program.getSourceFileNames().flatMap((fileName) => {
      const file = project.program.getSourceFile(fileName)
      return file !== undefined && project.program.isSourceFileDefaultLibrary(file) ? [canonicalCompilerPath(file.fileName)] : []
    }))

    const candidates: Candidate[] = []
    const excluded: AgentSdkExcludedCallable[] = []
    const reservedSymbols = new Set<TypeScriptSymbol>()
    metadata.entrypoints.forEach((entrypoint, index) => {
      const namespace = [...probeExports.values()].find((symbol) => symbol.name === `TASAgentSdkEntrypoint${index}`)
      if (namespace === undefined) throw new Error(`agent-sdk probe export is unresolved: ${entrypoint.entrypoint}`)
      const module = canonicalSymbol(namespace, project.checker)
      const discovered = discoverCandidates(module.getExports(), entrypoint.entrypoint, project.checker)
      if (entrypoint.entrypoint === providerReservedEntrypoint) {
        for (const candidate of discovered.candidates) reservedSymbols.add(candidateIdentity(candidate))
        excluded.push(...discovered.candidates.map((candidate) => exclusion(
          candidate,
          'provider_reserved',
          'exact source module is reserved for a reviewed Proof Provider Adapter',
        )))
        excluded.push(...discovered.excluded.map((entry) => ({
          ...entry,
          reasonCode: 'provider_reserved' as const,
          reason: 'exact source module is reserved for a reviewed Proof Provider Adapter',
        })))
      } else {
        candidates.push(...discovered.candidates)
        excluded.push(...discovered.excluded)
      }
    })

    const genericCandidates: Candidate[] = []
    for (const candidate of candidates) {
      if (reservedSymbols.has(candidateIdentity(candidate))) {
        excluded.push(exclusion(
          candidate,
          'provider_reserved',
          `callable aliases a source claimed by ${providerReservedEntrypoint}`,
        ))
      } else {
        genericCandidates.push(candidate)
      }
    }

    const byIdentity = new Map<TypeScriptSymbol, Candidate[]>()
    for (const candidate of genericCandidates) {
      const variants = byIdentity.get(candidateIdentity(candidate)) ?? []
      variants.push(candidate)
      byIdentity.set(candidateIdentity(candidate), variants)
    }
    const canonical: Candidate[] = []
    for (const variants of byIdentity.values()) {
      const sorted = variants.toSorted((left, right) => {
        const leftRecompute = entrypointSegments(left.entrypoint).at(-1) === 'recompute' ? 0 : 1
        const rightRecompute = entrypointSegments(right.entrypoint).at(-1) === 'recompute' ? 0 : 1
        return leftRecompute - rightRecompute || stableCompare(
          `${left.entrypoint}:${left.exportName}:${left.member ?? ''}`,
          `${right.entrypoint}:${right.exportName}:${right.member ?? ''}`,
        )
      })
      const selected = sorted[0] as Candidate
      canonical.push(selected)
      excluded.push(...sorted.slice(1).map((candidate) => exclusion(
        candidate,
        'shadowed_by_canonical_entrypoint',
        `same public callable is canonically exposed from ${selected.entrypoint}`,
      )))
    }
    const candidateNames = new Map<string, Candidate>()
    for (const candidate of canonical) {
      const name = toolName(candidate)
      const previous = candidateNames.get(name)
      if (previous !== undefined) {
        throw new Error(`duplicate generated agent-sdk tool name ${name}: ${previous.exportName} and ${candidate.exportName}`)
      }
      candidateNames.set(name, candidate)
    }
    const runtimeSurface = inspectRuntimeSurface(canonical, metadata, project.checker)
    if (!metadata.fixture) {
      for (const candidate of canonical) {
        const declarationOrigin = candidate.symbol.declarations[0] === undefined
          ? ''
          : declarationSourceFileName(candidate.symbol.declarations[0]) ?? ''
        const recomputeConvention = entrypointSegments(candidate.entrypoint).at(-1) === 'recompute'
          || /(?:^|[/\\])recompute(?:l4)?\.d\.[cm]?ts$/i.test(declarationOrigin)
        if (recomputeConvention && runtimeSurface.effects.get(candidate) !== 'read') {
          throw new Error(`${candidate.exportName}${candidate.member === undefined ? '' : `.${candidate.member}`} is exposed as recompute but its runtime is not proven read-only`)
        }
      }
    }
    const included = canonical.map((candidate) => classifyCandidate(
      candidate,
      project.checker,
      defaultLibraryPaths,
      runtimeSurface.effects.get(candidate),
      metadata.packageRoot,
      metadata.fixture,
      runtimeSurface.viemRoot,
    ))
    const names = new Map<string, AgentSdkIncludedCallable>()
    for (const entry of included) {
      const previous = names.get(entry.toolName)
      if (previous !== undefined) {
        throw new Error(`duplicate generated agent-sdk tool name ${entry.toolName}: ${previous.exportName} and ${entry.exportName}`)
      }
      names.set(entry.toolName, entry)
    }
    included.sort((left, right) => stableCompare(left.toolName, right.toolName))
    excluded.sort((left, right) => stableCompare(
      `${left.entrypoint}:${left.exportName}:${left.member ?? ''}`,
      `${right.entrypoint}:${right.exportName}:${right.member ?? ''}`,
    ))
    const closure = reviewedClosure(project.program, probePath, metadata, defaultLibraryPaths)
    const reviewedPackageMap = new Map<string, ReviewedPackageMetadata>()
    for (const package_ of [...closure.reviewedPackages, ...runtimeSurface.trustedRuntimePackages]) {
      const previous = reviewedPackageMap.get(package_.packageName)
      if (previous !== undefined && (previous.packageVersion !== package_.packageVersion
        || previous.packageIntegrity !== package_.packageIntegrity)) {
        throw new Error(`reviewed package identity is inconsistent for ${package_.packageName}`)
      }
      reviewedPackageMap.set(package_.packageName, package_)
    }
    const reviewedPackages = [...reviewedPackageMap.values()]
      .toSorted((left, right) => stableCompare(left.packageName, right.packageName))
    return {
      packageName: metadata.packageName,
      packageVersion: metadata.packageVersion,
      packageIntegrity: metadata.packageIntegrity,
      entrypoints: metadata.entrypoints.map(({ entrypoint }) => entrypoint),
      reviewedEntrypoints: metadata.entrypoints.map((entrypoint) => ({
        entrypoint: entrypoint.entrypoint,
        typesPackageRelativePath: safePackageRelativePath(metadata.packageRoot, entrypoint.typesPath, 'agent-sdk types export'),
        runtimePackageRelativePath: safePackageRelativePath(metadata.packageRoot, entrypoint.runtimePath, 'agent-sdk runtime export'),
      })),
      trustedDependencies: reviewedPackages.filter(({ packageName }) => packageName !== metadata.packageName),
      reviewedPackages,
      reviewedDeclarations: closure.reviewedDeclarations,
      reviewedRuntimeFiles: runtimeSurface.reviewedRuntimeFiles,
      included,
      excluded,
    }
  } finally {
    closeCompilerSession(snapshot, api)
  }
}
