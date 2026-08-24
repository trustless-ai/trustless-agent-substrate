import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import {
  API,
  SignatureKind,
  SymbolFlags,
  TypeFlags,
  type Checker,
  type Signature,
  type Symbol as TypeScriptSymbol,
  type Type,
} from 'typescript/unstable/sync'
import { viemMemberToToolSegment, type OperationCompletion } from '../../src/mcp/manifest/types.js'
import { canonicalJson } from './canonicalJson.js'

export type ViemSourceProfile = 'viem-public' | 'viem-wallet'

export type ViemProjection = null | boolean | number | string | readonly ViemProjection[] | {
  readonly [key: string]: ViemProjection
}

export interface ViemActionProjectionContext {
  readonly sourceProfile: ViemSourceProfile
  readonly sourceName: string
  readonly toolName: string
  readonly signature: string
  readonly completion: OperationCompletion
  readonly boundary: ViemBoundaryDirectives
  readonly checker: Checker
  readonly inputType: Type
  readonly outputType: Type
}

export interface ViemBoundaryDirectives {
  readonly omittedInputProperties: readonly string[]
  readonly addressInputProperties: readonly string[]
  readonly dynamicJsonInputProperties: readonly string[]
  readonly dynamicJsonOutput: boolean
}

export interface IncludedAction<Projection extends ViemProjection | undefined = undefined> {
  readonly sourceProfile: ViemSourceProfile
  readonly sourceName: string
  readonly toolName: string
  readonly signature: string
  readonly projection: Projection
  readonly completion: OperationCompletion
}

export type ExclusionReasonCode =
  | 'callback_input'
  | 'callback_output'
  | 'subscription'
  | 'opaque_runtime_object'
  | 'non_finite_request'
  | 'non_finite_response'
  | 'account_not_injectable'
  | 'authenticated_write_not_bound'

export interface ExcludedAction {
  readonly sourceProfile: ViemSourceProfile
  readonly sourceName: string
  readonly reasonCode: ExclusionReasonCode
  readonly reason: string
}

export interface ViemAnalysis<Projection extends ViemProjection | undefined = undefined> {
  readonly packageVersion: string
  readonly packageIntegrity: string
  readonly trustedDependencies: readonly TrustedDependencyMetadata[]
  readonly reviewedPackages: readonly ReviewedPackageMetadata[]
  readonly reviewedDeclarations: readonly ReviewedDeclarationMetadata[]
  readonly included: readonly IncludedAction<Projection>[]
  readonly excluded: readonly ExcludedAction[]
}

export interface TrustedDependencyMetadata {
  readonly packageName: string
  readonly packageVersion: string
  readonly packageIntegrity: string
}

export interface ReviewedDeclarationMetadata {
  readonly packageName: string
  readonly packageVersion: string
  readonly packageRelativePath: string
  readonly sha256: `sha256:${string}`
}

export interface ReviewedPackageMetadata {
  readonly packageName: string
  readonly packageVersion: string
  readonly packageIntegrity: string
}

export interface AnalyzeViemActionsInput<Projection extends ViemProjection | undefined = undefined> {
  readonly cwd?: string
  /** Runs synchronously while the TypeScript session is live. Its result is cloned as plain JSON before return. */
  readonly project?: (context: ViemActionProjectionContext) => Projection
  /** A declaration-only source used by focused analyzer tests. */
  readonly fixture?: {
    readonly moduleSpecifier: string
    readonly packageVersion: string
    readonly packageIntegrity: string
  }
}

interface SourceMetadata {
  readonly moduleSpecifier: string
  readonly packageVersion: string
  readonly packageIntegrity: string
  readonly trustedDeclarationRoots: readonly string[]
  readonly trustedDependencies: readonly TrustedDependencyMetadata[]
  readonly packageLock?: PackageLockMetadata
  readonly fixturePackage?: ResolvedProgramPackage
}

interface PackageLockMetadata {
  readonly lockRoot: string
  readonly packages: Record<string, unknown>
}

interface ResolvedProgramPackage extends ReviewedPackageMetadata {
  readonly packageName: string
  readonly packageVersion: string
  readonly packageRoot: string
}

interface BoundaryFailure {
  readonly kind: 'callback' | 'opaque' | 'non_finite'
  readonly detail: string
}

interface WalkState {
  readonly checker: Checker
  readonly active: Set<number>
  nodes: number
  readonly allowDynamicJson: boolean
  readonly abiInputRoot: boolean
  readonly trustedDeclarationRoots: readonly string[]
  readonly standardLibraryFiles: ReadonlySet<string>
}

const maximumTypeDepth = 64
const maximumTypeNodes = 10_000
const maximumReviewedDeclarationFiles = 10_000
const maximumReviewedDeclarationBytes = 64 * 1_024 * 1_024
const rawTransactionRpcMethod = /\beth_sendRawTransaction\b/i
const signedTransactionClaim = /\bsigned\W{0,12}transaction\b/i
const runtimeObjectName = /^(?:Account|ArrayBuffer|Buffer|Client|DataView|EIP1193RequestFn|LocalAccount|OpaqueClient|PrivateKeyAccount|Transport|WebSocket|ReadableStream|WritableStream|Map|Set|WeakMap|WeakSet|Date|RegExp)$/
const dependencyPropertyNames = new Set(['chain', 'client', 'transport'])

export function isCanonicalSha512Integrity(value: string): boolean {
  const match = /^sha512-([A-Za-z0-9+/]+={0,2})$/.exec(value)
  if (match?.[1] === undefined) return false
  const decoded = Buffer.from(match[1], 'base64')
  return decoded.length === 64 && decoded.toString('base64') === match[1]
}

export function closeCompilerSession(
  snapshot: { readonly dispose: () => void } | undefined,
  api: { readonly close: () => void },
): void {
  try {
    snapshot?.dispose()
  } finally {
    api.close()
  }
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8')) as unknown
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be a JSON object`)
  }
  return value as Record<string, unknown>
}

function requireString(record: Record<string, unknown>, key: string, label: string): string {
  const value = record[key]
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${label}.${key} must be a non-empty string`)
  return value
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

export function packageNameFromLockKey(packageKey: string): string {
  if (packageKey.length === 0 || packageKey.startsWith('/') || packageKey.includes('\\')) {
    throw new Error('package-lock key must be a non-empty normalized relative path')
  }
  const segments = packageKey.split('/')
  const nodeModulesIndex = segments.findLastIndex((segment) => segment === 'node_modules')
  const packageSegments = segments.slice(nodeModulesIndex + 1)
  const safeSegment = (segment: string): boolean => segment.length > 0 && segment !== '.' && segment !== '..'
  if (nodeModulesIndex < 0 || packageSegments.some((segment) => !safeSegment(segment))) {
    throw new Error(`package-lock key does not identify an npm package root: ${packageKey}`)
  }
  if (packageSegments.length === 1 && !packageSegments[0]?.startsWith('@')) return packageSegments[0] as string
  if (packageSegments.length === 2 && packageSegments[0]?.startsWith('@') && packageSegments[0].length > 1) {
    return `${packageSegments[0]}/${packageSegments[1]}`
  }
  throw new Error(`package-lock key does not identify an npm package root: ${packageKey}`)
}

function validatePackageBoundary(packageRoot: string, packageJsonPath: string, lockRoot: string): void {
  const rootStatus = lstatSync(packageRoot)
  const jsonStatus = lstatSync(packageJsonPath)
  if (rootStatus.isSymbolicLink() || !rootStatus.isDirectory()
    || jsonStatus.isSymbolicLink() || !jsonStatus.isFile()) {
    throw new Error('reviewed package root and package.json must be regular non-symlink paths')
  }
  if (!isPathWithin(packageRoot, lockRoot)) throw new Error('reviewed package root is outside package-lock ownership')
  const realLockRoot = realpathSync(lockRoot)
  const realPackageRoot = realpathSync(packageRoot)
  const realPackageJson = realpathSync(packageJsonPath)
  if (!isPathWithin(realPackageRoot, realLockRoot) || !isPathWithin(realPackageJson, realPackageRoot)) {
    throw new Error('reviewed package boundary resolves outside package-lock ownership')
  }
}

export function resolveLockedPackage(
  packageName: string,
  packageJsonPath: string,
  lockRoot: string,
  packages: Record<string, unknown>,
): TrustedDependencyMetadata & { readonly packageRoot: string } {
  const packageRoot = dirname(packageJsonPath)
  validatePackageBoundary(packageRoot, packageJsonPath, lockRoot)
  const packageJson = asRecord(readJson(packageJsonPath), `${packageName} package.json`)
  const installedName = requireString(packageJson, 'name', `${packageName} package.json`)
  const packageVersion = requireString(packageJson, 'version', `${packageName} package.json`)
  const packageKey = relative(lockRoot, packageRoot).split(sep).join('/')
  const lockKeyName = packageNameFromLockKey(packageKey)
  if (lockKeyName !== packageName) {
    throw new Error(`package-lock key name ${lockKeyName} does not match expected package name ${packageName}`)
  }
  if (installedName !== packageName) {
    throw new Error(`installed package name ${installedName} does not match expected package name ${packageName}`)
  }
  const lockEntry = asRecord(packages[packageKey], `package-lock.json packages[${JSON.stringify(packageKey)}]`)
  const lockedVersion = requireString(lockEntry, 'version', `${packageName} lock entry`)
  const packageIntegrity = requireString(lockEntry, 'integrity', `${packageName} lock entry`)
  if (Object.hasOwn(lockEntry, 'name')) {
    const lockedName = requireString(lockEntry, 'name', `${packageName} lock entry`)
    if (lockedName !== packageName) {
      throw new Error(`lock entry name ${lockedName} does not match package-lock key name ${packageName}`)
    }
  }
  if (lockedVersion !== packageVersion) {
    throw new Error(`installed ${packageName} ${packageVersion} does not match package-lock ${lockedVersion}`)
  }
  if (!isCanonicalSha512Integrity(packageIntegrity)) {
    throw new Error(`${packageName} lock entry must contain canonical 64-byte sha512 integrity`)
  }
  return { packageName, packageVersion, packageIntegrity, packageRoot }
}

function resolveInstalledViem(cwd: string): SourceMetadata {
  const require = createRequire(join(cwd, 'package.json'))
  const packageJsonPath = require.resolve('viem/package.json')
  const packageRoot = dirname(packageJsonPath)
  const packageJson = asRecord(readJson(packageJsonPath), 'viem package.json')
  const version = requireString(packageJson, 'version', 'viem package.json')
  const exportsField = asRecord(packageJson.exports, 'viem package.json exports')
  const mainExport = asRecord(exportsField['.'], 'viem package.json exports["."]')
  const typesEntrypoint = requireString(mainExport, 'types', 'viem package.json exports["."]')
  const entrypointPath = resolve(packageRoot, typesEntrypoint)
  const packageRelative = relative(packageRoot, entrypointPath)
  if (packageRelative.startsWith(`..${sep}`) || isAbsolute(packageRelative) || !existsSync(entrypointPath)) {
    throw new Error('viem public types export does not resolve inside the installed package')
  }

  const packageLockPath = findPackageLock(cwd)
  const lockRoot = dirname(packageLockPath)
  const lock = asRecord(readJson(packageLockPath), 'package-lock.json')
  if (lock.lockfileVersion !== 3) throw new Error('package-lock.json must use lockfileVersion 3')
  const packages = asRecord(lock.packages, 'package-lock.json packages')
  const viem = resolveLockedPackage('viem', packageJsonPath, lockRoot, packages)
  if (viem.packageVersion !== version) throw new Error('resolved viem package metadata is inconsistent')
  const viemRequire = createRequire(packageJsonPath)
  const abitype = resolveLockedPackage(
    'abitype',
    viemRequire.resolve('abitype/package.json'),
    lockRoot,
    packages,
  )

  return {
    moduleSpecifier: 'viem',
    packageVersion: version,
    packageIntegrity: viem.packageIntegrity,
    trustedDeclarationRoots: [packageRoot, abitype.packageRoot],
    trustedDependencies: [{
      packageName: abitype.packageName,
      packageVersion: abitype.packageVersion,
      packageIntegrity: abitype.packageIntegrity,
    }],
    packageLock: { lockRoot, packages },
  }
}

function stableCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function nearestPackageRoot(fileName: string, lock: PackageLockMetadata): string {
  let current = dirname(resolve(fileName))
  const boundary = resolve(lock.lockRoot)
  while (isPathWithin(current, boundary)) {
    const packageJsonPath = join(current, 'package.json')
    if (existsSync(packageJsonPath)) {
      const rootStatus = lstatSync(current)
      const jsonStatus = lstatSync(packageJsonPath)
      if (rootStatus.isSymbolicLink() || !rootStatus.isDirectory()
        || jsonStatus.isSymbolicLink() || !jsonStatus.isFile()) {
        throw new Error('reviewed package root and package.json must be regular non-symlink paths')
      }
      const packageJson = asRecord(readJson(packageJsonPath), 'reviewed package.json')
      const declaresName = Object.hasOwn(packageJson, 'name')
      const declaresVersion = Object.hasOwn(packageJson, 'version')
      // Packages commonly contain nested package.json files used only as module or export markers.
      // They are not npm package manifests. A manifest that declares either identity field is a hard boundary.
      if (declaresName !== declaresVersion) {
        throw new Error('npm package manifest must declare both name and version')
      }
      if (declaresName) return current
    }
    if (current === boundary) break
    const parent = dirname(current)
    if (parent === current) break
    current = parent
  }
  throw new Error(`reviewed declaration is not owned by a locked npm package: ${basename(fileName)}`)
}

function lockedProgramPackage(fileName: string, lock: PackageLockMetadata): ResolvedProgramPackage {
  const sourceStatus = lstatSync(fileName)
  if (sourceStatus.isSymbolicLink() || !sourceStatus.isFile()) {
    throw new Error(`reviewed declaration is not a regular non-symlink file: ${basename(fileName)}`)
  }
  const packageRoot = nearestPackageRoot(fileName, lock)
  const packageKey = relative(lock.lockRoot, packageRoot).split(sep).join('/')
  if (packageKey === '' || packageKey === '..' || packageKey.startsWith('../')) {
    throw new Error('reviewed package is outside package-lock ownership')
  }
  if (!Object.hasOwn(lock.packages, packageKey)) {
    throw new Error(`nearest package boundary has no exact package-lock entry: ${packageKey}`)
  }
  const packageName = packageNameFromLockKey(packageKey)
  const resolvedPackage = resolveLockedPackage(
    packageName,
    join(packageRoot, 'package.json'),
    lock.lockRoot,
    lock.packages,
  )
  const realFile = realpathSync(fileName)
  const realRoot = realpathSync(packageRoot)
  if (!isPathWithin(realFile, realRoot)) {
    throw new Error(`reviewed declaration resolves outside package root: ${packageName}/${basename(fileName)}`)
  }
  return resolvedPackage
}

export function resolveReviewedProgramPackage(
  fileName: string,
  lockRoot: string,
  packages: Record<string, unknown>,
): ResolvedProgramPackage {
  return lockedProgramPackage(fileName, { lockRoot, packages })
}

function resolveProgramPackage(fileName: string, metadata: SourceMetadata): ResolvedProgramPackage {
  if (metadata.fixturePackage !== undefined && isPathWithin(fileName, metadata.fixturePackage.packageRoot)) {
    const realFile = realpathSync(fileName)
    const realRoot = realpathSync(metadata.fixturePackage.packageRoot)
    if (!isPathWithin(realFile, realRoot)) throw new Error('fixture declaration resolves outside its reviewed package root')
    return metadata.fixturePackage
  }
  if (metadata.packageLock === undefined) {
    throw new Error(`reviewed declaration has no locked npm package identity: ${basename(fileName)}`)
  }
  return lockedProgramPackage(fileName, metadata.packageLock)
}

function reviewedDeclarationClosure(
  program: { readonly getSourceFileNames: () => readonly string[]; readonly getSourceFile: (path: string) => { readonly text: string } | undefined },
  probePath: string,
  metadata: SourceMetadata,
  standardLibraryFiles: ReadonlySet<string>,
): {
  readonly reviewedPackages: readonly ReviewedPackageMetadata[]
  readonly reviewedDeclarations: readonly ReviewedDeclarationMetadata[]
} {
  const declarations: ReviewedDeclarationMetadata[] = []
  const packagesByName = new Map<string, ResolvedProgramPackage>()
  let totalBytes = 0
  for (const fileName of program.getSourceFileNames()) {
    if (resolve(fileName) === resolve(probePath) || standardLibraryFiles.has(canonicalSourcePath(fileName))) continue
    const status = lstatSync(fileName)
    if (status.isSymbolicLink() || !status.isFile()) {
      throw new Error(`reviewed declaration is not a regular non-symlink file: ${basename(fileName)}`)
    }
    const package_ = resolveProgramPackage(fileName, metadata)
    const previous = packagesByName.get(package_.packageName)
    if (previous !== undefined && resolve(previous.packageRoot) !== resolve(package_.packageRoot)) {
      throw new Error(`reviewed package ${package_.packageName} resolves from multiple package roots`)
    }
    packagesByName.set(package_.packageName, package_)
    const realFile = realpathSync(fileName)
    const realRoot = realpathSync(package_.packageRoot)
    const relativePath = relative(realRoot, realFile)
    if (relativePath === '' || relativePath === '..' || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) {
      throw new Error(`reviewed declaration has an unsafe package-relative path: ${package_.packageName}/${basename(fileName)}`)
    }
    const sourceFile = program.getSourceFile(fileName)
    if (sourceFile === undefined) throw new Error('reviewed declaration disappeared from the live TypeScript Program')
    const bytes = Buffer.byteLength(sourceFile.text, 'utf8')
    totalBytes += bytes
    if (declarations.length + 1 > maximumReviewedDeclarationFiles || totalBytes > maximumReviewedDeclarationBytes) {
      throw new Error('reviewed declaration closure exceeds the bounded file or byte budget')
    }
    declarations.push({
      packageName: package_.packageName,
      packageVersion: package_.packageVersion,
      packageRelativePath: relativePath.split(sep).join('/'),
      sha256: `sha256:${createHash('sha256').update(sourceFile.text, 'utf8').digest('hex')}`,
    })
  }
  declarations.sort((left, right) => stableCompare(
    `${left.packageName}:${left.packageRelativePath}`,
    `${right.packageName}:${right.packageRelativePath}`,
  ))
  const keys = declarations.map(({ packageName, packageRelativePath }) => `${packageName}:${packageRelativePath}`)
  if (keys.length === 0 || new Set(keys).size !== keys.length) {
    throw new Error('reviewed declaration closure is empty or contains duplicate package paths')
  }
  const reviewedPackages = [...packagesByName.values()]
    .map(({ packageName, packageVersion, packageIntegrity }) => ({ packageName, packageVersion, packageIntegrity }))
    .toSorted((left, right) => stableCompare(left.packageName, right.packageName))
  return { reviewedPackages, reviewedDeclarations: declarations }
}

function isPrimitiveBoundary(type: Type): boolean {
  const primitiveFlags = TypeFlags.String
    | TypeFlags.Number
    | TypeFlags.BigInt
    | TypeFlags.Boolean
    | TypeFlags.Null
    | TypeFlags.StringLiteral
    | TypeFlags.NumberLiteral
    | TypeFlags.BigIntLiteral
    | TypeFlags.BooleanLiteral
    | TypeFlags.TemplateLiteral
  return (type.flags & primitiveFlags) !== 0
}

function symbolName(type: Type): string | undefined {
  return type.getAliasSymbol()?.name ?? type.getSymbol()?.name
}

function isPathWithin(path: string, root: string): boolean {
  const child = relative(resolve(root), resolve(path))
  return child === '' || (!child.startsWith(`..${sep}`) && child !== '..' && !isAbsolute(child))
}

function symbolHasTrustedDeclaration(
  symbol: TypeScriptSymbol | undefined,
  trustedDeclarationRoots: readonly string[],
): boolean {
  return symbol !== undefined && symbol.declarations.some((declaration) => {
    const sourcePath = declaration.resolve()?.getSourceFile().fileName
    return sourcePath !== undefined && trustedDeclarationRoots.some((root) => isPathWithin(sourcePath, root))
  })
}

function isTrustedNamedType(
  type: Type,
  expected: string,
  checker: Checker,
  trustedDeclarationRoots: readonly string[],
  seen = new Set<number>(),
): boolean {
  if (seen.has(type.id)) return false
  seen.add(type.id)
  if ((type.flags & (TypeFlags.Null | TypeFlags.Undefined)) !== 0) return true
  const alias = type.getAliasSymbol()
  const symbol = type.getSymbol()
  if ((alias?.name === expected && symbolHasTrustedDeclaration(alias, trustedDeclarationRoots))
    || (symbol?.name === expected && symbolHasTrustedDeclaration(symbol, trustedDeclarationRoots))) return true
  if (type.isUnionType() || type.isIntersectionType()) {
    return type.getTypes().every((part) => isTrustedNamedType(
      part,
      expected,
      checker,
      trustedDeclarationRoots,
      new Set(seen),
    ))
  }
  if (type.isTypeParameter()) {
    const constraint = checker.getBaseConstraintOfType(type)
    return constraint !== undefined
      && isTrustedNamedType(constraint, expected, checker, trustedDeclarationRoots, seen)
  }
  return false
}

function canonicalSourcePath(path: string): string {
  return resolve(path).toLowerCase()
}

function isTrustedByteArray(
  type: Type,
  trustedDeclarationRoots: readonly string[],
  standardLibraryFiles: ReadonlySet<string>,
): boolean {
  const alias = type.getAliasSymbol()
  if (alias?.name === 'ByteArray' && symbolHasTrustedDeclaration(alias, trustedDeclarationRoots)) return true
  const symbol = type.getSymbol()
  return symbol?.name === 'Uint8Array'
    && symbol.declarations.length > 0
    && symbol.declarations.every((declaration) => {
      const sourcePath = declaration.resolve()?.getSourceFile().fileName
      return sourcePath !== undefined && standardLibraryFiles.has(canonicalSourcePath(sourcePath))
    })
}

function isRuntimeDependencyProperty(
  name: string,
  type: Type,
  checker: Checker,
  trustedDeclarationRoots: readonly string[],
): boolean {
  if (!dependencyPropertyNames.has(name)) return false
  const expected = `${name[0]?.toUpperCase()}${name.slice(1)}`
  return isTrustedNamedType(type, expected, checker, trustedDeclarationRoots)
}

function isTrustedAccountOrAddress(
  type: Type,
  checker: Checker,
  trustedDeclarationRoots: readonly string[],
  seen = new Set<number>(),
): boolean {
  if (seen.has(type.id)) return false
  seen.add(type.id)
  if ((type.flags & (TypeFlags.Null | TypeFlags.Undefined)) !== 0) return true
  if (type.isUnionType() || type.isIntersectionType()) {
    return type.getTypes().every((part) => isTrustedAccountOrAddress(
      part,
      checker,
      trustedDeclarationRoots,
      new Set(seen),
    ))
  }
  if (type.isTypeParameter()) {
    const constraint = checker.getBaseConstraintOfType(type)
    return constraint !== undefined
      && isTrustedAccountOrAddress(constraint, checker, trustedDeclarationRoots, seen)
  }
  const rendered = checker.typeToString(type)
  const isAddress = checker.isTypeAssignableTo(type, checker.getStringType())
    && (/`0x\$\{string\}`/.test(rendered)
      || isTrustedNamedType(type, 'Address', checker, trustedDeclarationRoots))
  if (isAddress || isTrustedNamedType(type, 'Account', checker, trustedDeclarationRoots)) return true
  const declarationSymbol = type.getAliasSymbol() ?? type.getSymbol()
  const address = checker.getPropertyOfType(type, 'address')
  const addressType = address === undefined ? undefined : checker.getTypeOfSymbol(address)
  return symbolHasTrustedDeclaration(declarationSymbol, trustedDeclarationRoots)
    && addressType !== undefined
    && checker.isTypeAssignableTo(addressType, checker.getStringType())
    && /0x|Address/.test(checker.typeToString(addressType))
}

function containsTrustedAbiMarker(
  type: Type,
  checker: Checker,
  trustedDeclarationRoots: readonly string[],
  seen = new Set<number>(),
): boolean {
  if (seen.has(type.id)) return false
  seen.add(type.id)
  const alias = type.getAliasSymbol()
  const symbol = type.getSymbol()
  const markerName = alias?.name ?? symbol?.name
  const markerSymbol = alias ?? symbol
  if (markerName !== undefined
    && /^(?:Abi|AbiParameter|AbiConstructor|AbiError|AbiEvent|AbiFallback|AbiFunction|AbiReceive)$/.test(markerName)
    && symbolHasTrustedDeclaration(markerSymbol, trustedDeclarationRoots)) return true
  if (type.isUnionType() || type.isIntersectionType()) {
    return type.getTypes().some((part) => containsTrustedAbiMarker(
      part,
      checker,
      trustedDeclarationRoots,
      new Set(seen),
    ))
  }
  if (type.isTypeReference()) {
    return checker.getTypeArguments(type).some((part) => containsTrustedAbiMarker(
      part,
      checker,
      trustedDeclarationRoots,
      seen,
    ))
  }
  return false
}

function isTrustedAbiInput(type: Type, checker: Checker, trustedDeclarationRoots: readonly string[]): boolean {
  if (type.isTypeParameter()) {
    const constraint = checker.getBaseConstraintOfType(type)
    return symbolHasTrustedDeclaration(type.getSymbol(), trustedDeclarationRoots)
      && constraint !== undefined
      && containsTrustedAbiMarker(constraint, checker, trustedDeclarationRoots)
  }
  return containsTrustedAbiMarker(type, checker, trustedDeclarationRoots)
}

function isResolvedKzgProvider(type: Type, checker: Checker, trustedDeclarationRoots: readonly string[]): boolean {
  const candidates = (type.isUnionType() ? type.getTypes() : [type])
    .filter((candidate) => (candidate.flags & (TypeFlags.Null | TypeFlags.Undefined)) === 0)
  return candidates.length > 0 && candidates.every((candidate) => {
    if (!isTrustedNamedType(candidate, 'Kzg', checker, trustedDeclarationRoots)) return false
    if (checker.getSignaturesOfType(candidate, SignatureKind.Call).length > 0) return false
    const properties = checker.getPropertiesOfType(candidate)
    return properties.length > 0 && properties.every((property) => {
      const propertyType = checker.getTypeOfSymbol(property)
      return propertyType !== undefined && checker.getSignaturesOfType(propertyType, SignatureKind.Call).length > 0
    })
  })
}

function isAbiFunctionReturn(type: Type, checker: Checker, trustedDeclarationRoots: readonly string[]): boolean {
  const unwrapped = unwrapPromise(type, checker).type
  return isTrustedNamedType(unwrapped, 'ContractFunctionReturnType', checker, trustedDeclarationRoots)
    || isTrustedNamedType(unwrapped, 'ReadContractReturnType', checker, trustedDeclarationRoots)
}

function resolveBoundaryDirectives(
  sourceProfile: ViemSourceProfile,
  inputType: Type,
  outputType: Type,
  checker: Checker,
  trustedDeclarationRoots: readonly string[],
): ViemBoundaryDirectives {
  const omittedInputProperties: string[] = []
  const addressInputProperties: string[] = []
  const dynamicJsonInputProperties: string[] = []
  const preclassified = new Set<string>()
  const commonAbi = checker.getPropertyOfType(inputType, 'abi')
  const commonAbiType = commonAbi === undefined ? undefined : checker.getTypeOfSymbol(commonAbi)
  const commonAbiDependent = commonAbiType !== undefined
    && isTrustedAbiInput(commonAbiType, checker, trustedDeclarationRoots)
  for (const property of checker.getPropertiesOfType(inputType)) {
    const type = checker.getTypeOfSymbol(property)
    if (type === undefined) continue
    if (sourceProfile === 'viem-wallet' && property.name === 'account') {
      omittedInputProperties.push(property.name)
      preclassified.add(property.name)
    } else if (isRuntimeDependencyProperty(property.name, type, checker, trustedDeclarationRoots)
      || (property.name === 'kzg'
        && (property.flags & SymbolFlags.Optional) !== 0
        && isResolvedKzgProvider(type, checker, trustedDeclarationRoots))) {
      omittedInputProperties.push(property.name)
      preclassified.add(property.name)
    } else if (sourceProfile === 'viem-public' && property.name === 'account'
      && isTrustedAccountOrAddress(type, checker, trustedDeclarationRoots)) {
      addressInputProperties.push(property.name)
      preclassified.add(property.name)
    } else if (commonAbiDependent && (property.name === 'abi' || property.name === 'args')) {
      dynamicJsonInputProperties.push(property.name)
      preclassified.add(property.name)
    }
  }
  const branches = inputType.isUnionType()
    ? inputType.getTypes().filter((type) => (type.flags & (TypeFlags.Null | TypeFlags.Undefined)) === 0)
    : [inputType]
  const occurrences = new Map<string, {
    readonly property: TypeScriptSymbol
    readonly type: Type
    readonly abiDependent: boolean
  }[]>()
  let abiDependent = false
  for (const branch of branches) {
    const abiProperty = checker.getPropertyOfType(branch, 'abi')
    const abiType = abiProperty === undefined ? undefined : checker.getTypeOfSymbol(abiProperty)
    const branchAbiDependent = abiType !== undefined && isTrustedAbiInput(abiType, checker, trustedDeclarationRoots)
    abiDependent ||= branchAbiDependent
    for (const property of checker.getPropertiesOfType(branch)) {
      const propertyType = checker.getTypeOfSymbol(property)
      if (propertyType === undefined) continue
      const entries = occurrences.get(property.name) ?? []
      entries.push({ property, type: propertyType, abiDependent: branchAbiDependent })
      occurrences.set(property.name, entries)
    }
  }

  for (const [name, entries] of [...occurrences.entries()].toSorted(([left], [right]) => left.localeCompare(right))) {
    if (preclassified.has(name)) continue
    if (sourceProfile === 'viem-wallet' && name === 'account') {
      omittedInputProperties.push(name)
      continue
    }
    if (entries.every(({ property, type }) =>
      isRuntimeDependencyProperty(name, type, checker, trustedDeclarationRoots)
      || (name === 'kzg'
        && (property.flags & SymbolFlags.Optional) !== 0
        && isResolvedKzgProvider(type, checker, trustedDeclarationRoots)))) {
      omittedInputProperties.push(name)
      continue
    }
    if (sourceProfile === 'viem-public' && name === 'account'
      && entries.every(({ type }) => isTrustedAccountOrAddress(type, checker, trustedDeclarationRoots))) {
      addressInputProperties.push(name)
      continue
    }
    if ((name === 'abi' || name === 'args') && entries.every(({ abiDependent: dependent }) => dependent)) {
      dynamicJsonInputProperties.push(name)
    }
  }

  return {
    omittedInputProperties,
    addressInputProperties,
    dynamicJsonInputProperties,
    dynamicJsonOutput: abiDependent && isAbiFunctionReturn(outputType, checker, trustedDeclarationRoots),
  }
}

function unwrapPromise(type: Type, checker: Checker): { readonly type: Type; readonly unwrapped: boolean } {
  if (symbolName(type) !== 'Promise' || !type.isTypeReference()) return { type, unwrapped: false }
  const arguments_ = checker.getTypeArguments(type)
  return arguments_.length === 1 && arguments_[0] !== undefined
    ? { type: arguments_[0], unwrapped: true }
    : { type, unwrapped: false }
}

function callableFailure(type: Type, state: WalkState, position: 'input' | 'output'): BoundaryFailure | undefined {
  const signatures = state.checker.getSignaturesOfType(type, SignatureKind.Call)
  if (signatures.length === 0) return undefined
  return { kind: 'callback', detail: `${position} boundary contains a callable value` }
}

function walkBoundary(
  type: Type,
  state: WalkState,
  depth: number,
  position: 'input' | 'output',
  skipRootProperties: ReadonlySet<string> = new Set(),
  allowUndefined = false,
  propertyPath: readonly string[] = [],
): BoundaryFailure | undefined {
  if (isPrimitiveBoundary(type)) return undefined
  if ((type.flags & TypeFlags.Undefined) !== 0) return position === 'input' || allowUndefined ? undefined : {
    kind: 'non_finite', detail: 'output boundary may be undefined',
  }
  if ((type.flags & TypeFlags.Any) !== 0 || (type.flags & TypeFlags.Unknown) !== 0) {
    if (state.allowDynamicJson) return undefined
    return { kind: 'non_finite', detail: 'boundary contains any or unknown' }
  }
  if ((type.flags & TypeFlags.ESSymbol) !== 0) return { kind: 'non_finite', detail: 'boundary contains a symbol' }
  if ((type.flags & (TypeFlags.Void | TypeFlags.Never)) !== 0 || type.isErrorType()) {
    return { kind: 'non_finite', detail: `boundary contains ${state.checker.typeToString(type)}` }
  }
  if (state.checker.isTypeAssignableTo(type, state.checker.getStringType())
    || state.checker.isTypeAssignableTo(type, state.checker.getNumberType())
    || state.checker.isTypeAssignableTo(type, state.checker.getBigIntType())
    || state.checker.isTypeAssignableTo(type, state.checker.getBooleanType())) {
    return undefined
  }
  if (isTrustedByteArray(type, state.trustedDeclarationRoots, state.standardLibraryFiles)) return undefined
  if (depth > maximumTypeDepth) return { kind: 'non_finite', detail: `type depth exceeds ${maximumTypeDepth}` }
  state.nodes += 1
  if (state.nodes > maximumTypeNodes) return { kind: 'non_finite', detail: `type graph exceeds ${maximumTypeNodes} nodes` }

  if (type.isTypeParameter()) {
    const constraint = state.checker.getBaseConstraintOfType(type)
    return constraint === undefined
      ? { kind: 'non_finite', detail: `unbounded type parameter ${state.checker.typeToString(type)}` }
      : walkBoundary(constraint, state, depth + 1, position, skipRootProperties, allowUndefined, propertyPath)
  }

  if (type.isUnionType()) {
    const failures: BoundaryFailure[] = []
    for (const part of type.getTypes()) {
      const failure = walkBoundary(part, state, depth + 1, position, skipRootProperties, allowUndefined, propertyPath)
      if (failure !== undefined) failures.push(failure)
    }
    if (failures.length === 0) return undefined
    return failures[0]
  }

  if (type.isIntersectionType()) {
    const parts = type.getTypes()
    if (parts.some(isPrimitiveBoundary)) return undefined
    for (const part of parts) {
      const failure = walkBoundary(part, state, depth + 1, position, skipRootProperties, allowUndefined, propertyPath)
      if (failure !== undefined) return failure
    }
    return undefined
  }

  const callable = callableFailure(type, state, position)
  if (callable !== undefined) return callable

  const name = symbolName(type)
  if (name !== undefined && runtimeObjectName.test(name)) {
    return { kind: 'opaque', detail: `boundary contains runtime object ${name}` }
  }

  if (state.checker.isTupleType(type) || state.checker.isArrayLikeType(type)) {
    if (!type.isTypeReference()) return { kind: 'non_finite', detail: 'array element type is unresolved' }
    for (const element of state.checker.getTypeArguments(type)) {
      const failure = walkBoundary(element, state, depth + 1, position, new Set(), false, [...propertyPath, '*'])
      if (failure !== undefined) return failure
    }
    return undefined
  }

  if (state.active.has(type.id)) {
    return state.allowDynamicJson ? undefined : { kind: 'non_finite', detail: 'boundary contains a recursive type' }
  }
  state.active.add(type.id)
  try {
    const properties = state.checker.getPropertiesOfType(type)
    const indexInfos = state.checker.getIndexInfosOfType(type)
    if (properties.length === 0 && indexInfos.length === 0) {
      const apparent = state.checker.getApparentType(type)
      if (apparent !== undefined && apparent.id !== type.id) {
        return walkBoundary(apparent, state, depth + 1, position, skipRootProperties, allowUndefined, propertyPath)
      }
      return { kind: 'opaque', detail: `boundary object ${state.checker.typeToString(type)} has no finite JSON shape` }
    }

    for (const property of properties) {
      const nextPath = [...propertyPath, property.name]
      const isRootProperty = propertyPath.length === 0
      if (isRootProperty && skipRootProperties.has(property.name)) continue
      const propertyType = state.checker.getTypeOfSymbol(property)
      if (propertyType === undefined) return { kind: 'non_finite', detail: `property ${property.name} has no resolved type` }
      if (isRootProperty && isRuntimeDependencyProperty(
        property.name,
        propertyType,
        state.checker,
        state.trustedDeclarationRoots,
      )) continue
      if (position === 'input'
        && isRootProperty
        && property.name === 'account'
        && isTrustedAccountOrAddress(propertyType, state.checker, state.trustedDeclarationRoots)) continue
      if (position === 'input'
        && isRootProperty
        && property.name === 'kzg'
        && (property.flags & SymbolFlags.Optional) !== 0
        && isResolvedKzgProvider(propertyType, state.checker, state.trustedDeclarationRoots)) continue
      const propertyAllowsUndefined = (property.flags & SymbolFlags.Optional) !== 0 || position === 'output'
      const isAbiJsonPath = position === 'input'
        && state.abiInputRoot
        && isRootProperty
        && (property.name === 'abi' || property.name === 'args')
      const failure = isAbiJsonPath
        ? walk(propertyType, state.checker, position, undefined, true, false)
        : walkBoundary(propertyType, state, depth + 1, position, new Set(), propertyAllowsUndefined, nextPath)
      if (failure !== undefined) return { ...failure, detail: `property ${property.name}: ${failure.detail}` }
    }
    for (const indexInfo of indexInfos) {
      if ((indexInfo.keyType.flags & (TypeFlags.String | TypeFlags.Number)) === 0) {
        return { kind: 'non_finite', detail: 'boundary has a non-string JSON object index' }
      }
      const failure = walkBoundary(indexInfo.valueType, state, depth + 1, position, new Set(), false, [...propertyPath, '*'])
      if (failure !== undefined) return failure
    }
    return undefined
  } finally {
    state.active.delete(type.id)
  }
}

function walk(
  type: Type,
  checker: Checker,
  position: 'input' | 'output',
  skipRootProperties?: ReadonlySet<string>,
  allowDynamicJson = false,
  abiInputRoot = false,
  trustedDeclarationRoots: readonly string[] = [],
  standardLibraryFiles: ReadonlySet<string> = new Set(),
): BoundaryFailure | undefined {
  return walkBoundary(type, {
    checker,
    active: new Set(),
    nodes: 0,
    allowDynamicJson,
    abiInputRoot,
    trustedDeclarationRoots,
    standardLibraryFiles,
  }, 0, position, skipRootProperties)
}

function exclusion(
  sourceProfile: ViemSourceProfile,
  sourceName: string,
  reasonCode: ExclusionReasonCode,
  reason: string,
): ExcludedAction {
  return { sourceProfile, sourceName, reasonCode, reason }
}

function boundaryExclusion(
  sourceProfile: ViemSourceProfile,
  sourceName: string,
  position: 'input' | 'output',
  failure: BoundaryFailure,
): ExcludedAction {
  const reasonCode = failure.kind === 'callback'
    ? position === 'input' ? 'callback_input' : 'callback_output'
    : failure.kind === 'opaque'
      ? 'opaque_runtime_object'
      : position === 'input' ? 'non_finite_request' : 'non_finite_response'
  return exclusion(sourceProfile, sourceName, reasonCode, failure.detail)
}

function directSubscription(signature: Signature, checker: Checker): boolean {
  const returnType = checker.getReturnTypeOfSignature(signature)
  if (returnType === undefined || unwrapPromise(returnType, checker).unwrapped) return false
  const callbacks = checker.getSignaturesOfType(returnType, SignatureKind.Call)
  if (callbacks.length !== 1) return false
  const callback = callbacks[0]
  if (callback === undefined || callback.getParameters().length !== 0) return false
  const callbackReturn = checker.getReturnTypeOfSignature(callback)
  return callbackReturn !== undefined && (callbackReturn.flags & TypeFlags.Void) !== 0
}

interface RawTransactionScanState {
  readonly active: Set<number>
  readonly visited: Set<number>
  nodes: number
}

interface RawTransactionScanContext {
  readonly checker: Checker
  readonly trustedDeclarationRoots: readonly string[]
  readonly standardLibraryFiles: ReadonlySet<string>
  readonly byteSubmissionSemantics: boolean
}

const rawTransactionSemanticName = /^(?:raw|serialized|signed)(?:transaction|tx)(?:bytes|data)?$/
const transactionSubmissionName = /^(?:send|submit|broadcast|relay|publish|write|post|push|forward)/i
function hasTrustedRawTransactionAlias(type: Type, trustedDeclarationRoots: readonly string[]): boolean {
  const symbol = type.getAliasSymbol() ?? type.getSymbol()
  return symbol !== undefined
    && /(?:Transaction.*Serialized|Serialized.*Transaction|Signed.*Transaction)/i.test(symbol.name)
    && symbolHasTrustedDeclaration(symbol, trustedDeclarationRoots)
}

function isHexOrBytePayload(type: Type, context: RawTransactionScanContext): boolean {
  if (isTrustedByteArray(type, context.trustedDeclarationRoots, context.standardLibraryFiles)) return true
  const symbol = type.getAliasSymbol() ?? type.getSymbol()
  if (symbol?.name === 'Hex' && symbolHasTrustedDeclaration(symbol, context.trustedDeclarationRoots)) return true
  return (type.flags & TypeFlags.TemplateLiteral) !== 0 && /0x/.test(context.checker.typeToString(type))
}

function rawSignedTransactionRequest(
  type: Type,
  context: RawTransactionScanContext,
  state: RawTransactionScanState = { active: new Set(), visited: new Set(), nodes: 0 },
  depth = 0,
): boolean {
  if (depth > maximumTypeDepth) return true
  if (state.active.has(type.id) || state.visited.has(type.id)) return false
  if (hasTrustedRawTransactionAlias(type, context.trustedDeclarationRoots)
    || (context.byteSubmissionSemantics && isHexOrBytePayload(type, context))) return true
  if (isPrimitiveBoundary(type)) return false
  state.nodes += 1
  if (state.nodes > maximumTypeNodes) return true
  state.active.add(type.id)
  try {
    if (type.isUnionType() || type.isIntersectionType()) {
      return type.getTypes().some((part) => rawSignedTransactionRequest(part, context, state, depth + 1))
    }
    if (type.isTypeParameter()) {
      const constraint = context.checker.getBaseConstraintOfType(type)
      return constraint === undefined || rawSignedTransactionRequest(constraint, context, state, depth + 1)
    }
    if (type.isTypeReference()) {
      for (const argument of context.checker.getTypeArguments(type)) {
        if (rawSignedTransactionRequest(argument, context, state, depth + 1)) return true
      }
    }
    for (const property of context.checker.getPropertiesOfType(type)) {
      const semanticName = property.name.replace(/[^A-Za-z0-9]/g, '').toLowerCase()
      if (rawTransactionSemanticName.test(semanticName)) return true
      const propertyType = context.checker.getTypeOfSymbol(property)
      if (propertyType === undefined || rawSignedTransactionRequest(propertyType, context, state, depth + 1)) return true
    }
    state.visited.add(type.id)
    return false
  } finally {
    state.active.delete(type.id)
  }
}

function signedPublicWrite(
  symbol: TypeScriptSymbol,
  checker: Checker,
  inputType: Type,
  signature: Signature,
  trustedDeclarationRoots: readonly string[],
  standardLibraryFiles: ReadonlySet<string>,
): { readonly matches: boolean; readonly reason: string } {
  const parameterName = signature.getParameters()[0]?.name.replace(/[^A-Za-z0-9]/g, '').toLowerCase() ?? ''
  const sourceSemantic = symbol.name.replace(/[^A-Za-z0-9]/g, '')
  const byteSubmissionSemantics = transactionSubmissionName.test(sourceSemantic)
    || rawTransactionSemanticName.test(parameterName)
  if (rawSignedTransactionRequest(inputType, {
    checker,
    trustedDeclarationRoots,
    standardLibraryFiles,
    byteSubmissionSemantics,
  })) {
    return { matches: true, reason: 'request contains raw or serialized signed transaction bytes without Agent-wallet binding' }
  }
  const documentation = symbol.getDocumentationComment(checker)
  const rpc = rawTransactionRpcMethod.test(documentation)
  const signed = signedTransactionClaim.test(documentation)
  if (!rpc && !signed) return { matches: false, reason: '' }
  if (rpc && /\bread[- ]only\b/i.test(documentation)) {
    return { matches: true, reason: 'declaration semantics conflict: eth_sendRawTransaction is described as read-only' }
  }
  if (!rpc) {
    return { matches: true, reason: 'declaration claims signed transaction submission without authoritative JSON-RPC method metadata' }
  }
  return { matches: true, reason: 'eth_sendRawTransaction submits caller-authenticated bytes without Agent-wallet binding' }
}

function operationCompletion(
  sourceProfile: ViemSourceProfile,
  sourceName: string,
  symbol: TypeScriptSymbol,
  checker: Checker,
): OperationCompletion {
  if (/Sync$/.test(sourceName) || /^waitFor/.test(sourceName)) return 'bounded_wait'
  const documentation = symbol.getDocumentationComment(checker)
  if (sourceProfile === 'viem-wallet') {
    const submitsExternalWork = /\b(?:sends?|submits?|broadcasts?|deploys?|executes?)\b[^.]{0,100}\b(?:transaction|contract|calls?|write)\b/i
      .test(documentation)
    if (submitsExternalWork) return 'external_handle'
    return /\b(?:signs?|signature|prepares?|fills?)\b/i.test(documentation) ? 'synchronous' : 'external_handle'
  }
  return /\b(?:eth_sendTransaction|wallet_sendCalls)\b/i.test(documentation)
    || /\b(?:sends|submits|broadcasts|deploys)\b[^.]{0,100}\b(?:transaction|contract|calls?)\b/i.test(documentation)
    || /\bexecutes a write function\b/i.test(documentation)
    ? 'external_handle'
    : 'synchronous'
}

function signatureInput(signature: Signature, checker: Checker): Type | undefined {
  const parameters = signature.getParameters()
  if (parameters.length === 0) return checker.getVoidType()
  if (parameters.length !== 1 || parameters[0] === undefined) return undefined
  return checker.getTypeOfSymbol(parameters[0])
}

function projectAction<Projection extends ViemProjection | undefined>(
  project: ((context: ViemActionProjectionContext) => Projection) | undefined,
  context: ViemActionProjectionContext,
): Projection {
  if (project === undefined) return undefined as Projection
  const projected = project(context)
  return projected === undefined
    ? projected
    : JSON.parse(canonicalJson(projected)) as Projection
}

function analyzeMember<Projection extends ViemProjection | undefined>(
  sourceProfile: ViemSourceProfile,
  member: TypeScriptSymbol,
  checker: Checker,
  privateKeyAccount: Type,
  trustedDeclarationRoots: readonly string[],
  standardLibraryFiles: ReadonlySet<string>,
  project: ((context: ViemActionProjectionContext) => Projection) | undefined,
): IncludedAction<Projection> | ExcludedAction {
  const sourceName = member.name
  const memberType = checker.getTypeOfSymbol(member)
  if (memberType === undefined) return exclusion(sourceProfile, sourceName, 'opaque_runtime_object', 'member type is unresolved')
  const signatures = checker.getSignaturesOfType(memberType, SignatureKind.Call)
  if (signatures.length !== 1 || signatures[0] === undefined) {
    return exclusion(sourceProfile, sourceName, 'opaque_runtime_object', 'member is not one unambiguous callable action')
  }
  const signature = signatures[0]
  const hasInput = signature.getParameters().length !== 0
  const inputType = signatureInput(signature, checker)
  const outputType = checker.getReturnTypeOfSignature(signature)
  if (inputType === undefined) {
    return exclusion(sourceProfile, sourceName, 'non_finite_request', 'action must expose zero or one request object')
  }
  if (outputType === undefined) return exclusion(sourceProfile, sourceName, 'non_finite_response', 'action return type is unresolved')

  if (sourceProfile === 'viem-public') {
    const write = signedPublicWrite(
      member,
      checker,
      inputType,
      signature,
      trustedDeclarationRoots,
      standardLibraryFiles,
    )
    if (write.matches) return exclusion(sourceProfile, sourceName, 'authenticated_write_not_bound', write.reason)
  }
  if (directSubscription(signature, checker)) {
    return exclusion(sourceProfile, sourceName, 'subscription', 'action returns a runtime unsubscribe function')
  }

  let skipInputProperties: ReadonlySet<string> | undefined
  if (sourceProfile === 'viem-wallet') {
    const account = checker.getPropertyOfType(inputType, 'account')
    if (account === undefined) {
      return exclusion(sourceProfile, sourceName, 'account_not_injectable', 'Wallet request has no injectable account property')
    }
    const accountType = checker.getTypeOfSymbol(account)
    if (accountType === undefined || !checker.isTypeAssignableTo(privateKeyAccount, accountType)) {
      return exclusion(sourceProfile, sourceName, 'account_not_injectable', 'PrivateKeyAccount is not assignable to the Wallet request account property')
    }
    skipInputProperties = new Set(['account'])
  }

  const boundary = resolveBoundaryDirectives(
    sourceProfile,
    inputType,
    outputType,
    checker,
    trustedDeclarationRoots,
  )
  skipInputProperties = new Set([
    ...boundary.omittedInputProperties,
    ...boundary.addressInputProperties,
  ])
  const abiDependent = boundary.dynamicJsonInputProperties.length > 0
  if (hasInput) {
    const inputFailure = walk(
      inputType,
      checker,
      'input',
      skipInputProperties,
      false,
      abiDependent,
      trustedDeclarationRoots,
      standardLibraryFiles,
    )
    if (inputFailure !== undefined) return boundaryExclusion(sourceProfile, sourceName, 'input', inputFailure)
  }
  const outputBoundaryType = unwrapPromise(outputType, checker).type
  const outputFailure = walk(
    outputBoundaryType,
    checker,
    'output',
    undefined,
    boundary.dynamicJsonOutput,
    false,
    trustedDeclarationRoots,
    standardLibraryFiles,
  )
  if (outputFailure !== undefined) return boundaryExclusion(sourceProfile, sourceName, 'output', outputFailure)

  const namespace = sourceProfile === 'viem-public' ? 'public' : 'wallet'
  const toolName = `workflow.chain.${namespace}.${viemMemberToToolSegment(sourceName)}`
  const renderedSignature = checker.typeToString(memberType)
  const completion = operationCompletion(sourceProfile, sourceName, member, checker)
  return {
    sourceProfile,
    sourceName,
    toolName,
    signature: renderedSignature,
    projection: projectAction(project, {
      sourceProfile,
      sourceName,
      toolName,
      signature: renderedSignature,
      completion,
      boundary,
      checker,
      inputType,
      outputType,
    }),
    completion,
  }
}

function findExport(exports: ReadonlyMap<unknown, TypeScriptSymbol>, name: string): TypeScriptSymbol | undefined {
  return [...exports.values()].find((symbol) => symbol.name === name)
}

export function analyzeViemActions<Projection extends ViemProjection | undefined = undefined>(
  input: AnalyzeViemActionsInput<Projection> = {},
): ViemAnalysis<Projection> {
  const cwd = resolve(input.cwd ?? process.cwd())
  const metadata: SourceMetadata = input.fixture === undefined
    ? resolveInstalledViem(cwd)
    : {
        ...input.fixture,
        trustedDeclarationRoots: [input.fixture.moduleSpecifier.replace(/\.js$/, '.d.ts')],
        fixturePackage: {
          packageName: 'viem-fixture',
          packageVersion: input.fixture.packageVersion,
          packageIntegrity: input.fixture.packageIntegrity,
          packageRoot: dirname(input.fixture.moduleSpecifier.replace(/\.js$/, '.d.ts')),
        },
        trustedDependencies: [],
      }
  const probePath = resolve(cwd, '.tas-viem-manifest-probe.ts')
  const moduleSpecifier = JSON.stringify(metadata.moduleSpecifier)
  const probeSource = [
    `import type { PublicActions, WalletActions, PrivateKeyAccount } from ${moduleSpecifier}`,
    'export type TASPublicActions = PublicActions',
    'export type TASWalletActions = WalletActions',
    'export type TASPrivateKeyAccount = PrivateKeyAccount',
    '',
  ].join('\n')
  const ownedFiles = new Map([[probePath, probeSource]])
  const api = new API({
    cwd,
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
    if (project === undefined || sourceFile === undefined) throw new Error('TypeScript did not resolve the viem analyzer probe')
    const diagnostics = project.program.getSemanticDiagnostics(probePath)
    if (diagnostics.length > 0) {
      throw new Error(`viem analyzer probe has semantic diagnostics: ${diagnostics.map(({ text }) => text).join('; ')}`)
    }
    const exports = project.checker.getSymbolAtLocation(sourceFile)?.getExports()
    if (exports === undefined) throw new Error('viem analyzer probe has no module exports')
    const publicSymbol = findExport(exports, 'TASPublicActions')
    const walletSymbol = findExport(exports, 'TASWalletActions')
    const accountSymbol = findExport(exports, 'TASPrivateKeyAccount')
    if (publicSymbol === undefined || walletSymbol === undefined || accountSymbol === undefined) {
      throw new Error('viem analyzer probe aliases are unresolved')
    }
    const privateKeyAccount = project.checker.getDeclaredTypeOfSymbol(accountSymbol)
    const standardLibraryFiles = new Set(project.program.getSourceFileNames().flatMap((fileName) => {
      const file = project.program.getSourceFile(fileName)
      return file !== undefined && project.program.isSourceFileDefaultLibrary(file)
        ? [canonicalSourcePath(file.fileName)]
        : []
    }))
    const profiles: readonly [ViemSourceProfile, TypeScriptSymbol][] = [
      ['viem-public', publicSymbol],
      ['viem-wallet', walletSymbol],
    ]
    const included: IncludedAction<Projection>[] = []
    const excluded: ExcludedAction[] = []
    const classified = new Set<string>()
    const toolNames = new Set<string>()

    for (const [profile, profileSymbol] of profiles) {
      const profileType = project.checker.getDeclaredTypeOfSymbol(profileSymbol)
      for (const member of project.checker.getPropertiesOfType(profileType).toSorted((left, right) => left.name.localeCompare(right.name))) {
        const classificationKey = `${profile}:${member.name}`
        if (classified.has(classificationKey)) throw new Error(`duplicate viem member classification: ${classificationKey}`)
        classified.add(classificationKey)
        const result = analyzeMember(
          profile,
          member,
          project.checker,
          privateKeyAccount,
          metadata.trustedDeclarationRoots,
          standardLibraryFiles,
          input.project,
        )
        if ('toolName' in result) {
          if (toolNames.has(result.toolName)) throw new Error(`duplicate generated viem tool name: ${result.toolName}`)
          toolNames.add(result.toolName)
          included.push(result)
        } else {
          excluded.push(result)
        }
      }
    }

    included.sort((left, right) => `${left.sourceProfile}:${left.sourceName}`.localeCompare(`${right.sourceProfile}:${right.sourceName}`))
    excluded.sort((left, right) => `${left.sourceProfile}:${left.sourceName}`.localeCompare(`${right.sourceProfile}:${right.sourceName}`))
    const { reviewedPackages, reviewedDeclarations } = reviewedDeclarationClosure(
      project.program,
      probePath,
      metadata,
      standardLibraryFiles,
    )
    return {
      packageVersion: metadata.packageVersion,
      packageIntegrity: metadata.packageIntegrity,
      trustedDependencies: metadata.trustedDependencies,
      reviewedPackages,
      reviewedDeclarations,
      included,
      excluded,
    }
  } finally {
    closeCompilerSession(snapshot, api)
  }
}
