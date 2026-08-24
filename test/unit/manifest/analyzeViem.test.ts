import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { API } from 'typescript/unstable/sync'
import { afterAll, describe, expect, it } from 'vitest'
import {
  analyzeViemActions,
  closeCompilerSession,
  isCanonicalSha512Integrity,
  packageNameFromLockKey,
  resolveLockedPackage,
  resolveReviewedProgramPackage,
} from '../../../tools/manifest/analyzeViem.js'

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const fixtureDeclaration = resolve(repositoryRoot, 'test/fixtures/manifest/viem-mini.d.ts')
const fixtureModule = fixtureDeclaration.replace(/\.d\.ts$/, '.js')
const fixtureIntegrity = `sha512-${Buffer.alloc(64, 7).toString('base64')}`

describe('locked npm package identity', () => {
  const temporaryRoots: string[] = []

  afterAll(() => {
    for (const root of temporaryRoots) rmSync(root, { recursive: true, force: true })
  })

  function temporaryRoot(): string {
    const root = mkdtempSync(resolve(tmpdir(), 'tas-reviewed-package-'))
    temporaryRoots.push(root)
    return root
  }

  function writePackage(root: string, packageKey: string, name: string): string {
    const packageRoot = resolve(root, packageKey)
    mkdirSync(resolve(packageRoot, 'dist'), { recursive: true })
    writeFileSync(resolve(packageRoot, 'package.json'), JSON.stringify({ name, version: '1.2.3' }))
    const declaration = resolve(packageRoot, 'dist/index.d.ts')
    writeFileSync(declaration, 'export interface Example { readonly ok: true }\n')
    return declaration
  }

  const lockEntry = { version: '1.2.3', integrity: fixtureIntegrity }

  it.each([
    ['node_modules/plain', 'plain'],
    ['node_modules/@scope/pkg', '@scope/pkg'],
    ['node_modules/outer/node_modules/plain', 'plain'],
    ['node_modules/outer/node_modules/@scope/pkg', '@scope/pkg'],
  ])('derives the exact npm name from lock key %s', (packageKey, expected) => {
    expect(packageNameFromLockKey(packageKey)).toBe(expected)
  })

  it('does not attribute an unlocked inner package to a locked ancestor', () => {
    const root = temporaryRoot()
    writePackage(root, 'node_modules/outer', 'outer')
    const innerDeclaration = writePackage(root, 'node_modules/outer/embedded', 'embedded')
    expect(() => resolveReviewedProgramPackage(innerDeclaration, root, {
      'node_modules/outer': lockEntry,
    })).toThrow('nearest package boundary has no exact package-lock entry')
  })

  it('rejects a renamed reviewed package even when version and integrity still match', () => {
    const root = temporaryRoot()
    const declaration = writePackage(root, 'node_modules/original', 'renamed')
    expect(() => resolveReviewedProgramPackage(declaration, root, {
      'node_modules/original': lockEntry,
    })).toThrow('does not match expected package name original')
  })

  it('rejects a malformed inner npm manifest instead of falling back to its locked ancestor', () => {
    const root = temporaryRoot()
    writePackage(root, 'node_modules/outer', 'outer')
    const innerRoot = resolve(root, 'node_modules/outer/embedded')
    mkdirSync(resolve(innerRoot, 'dist'), { recursive: true })
    writeFileSync(resolve(innerRoot, 'package.json'), JSON.stringify({ name: 'embedded' }))
    const declaration = resolve(innerRoot, 'dist/index.d.ts')
    writeFileSync(declaration, 'export type Example = true\n')
    expect(() => resolveReviewedProgramPackage(declaration, root, {
      'node_modules/outer': lockEntry,
    })).toThrow('npm package manifest must declare both name and version')
  })

  it.each(['viem', 'abitype'])('rejects primary %s metadata with a mismatched package.json name', (expectedName) => {
    const root = temporaryRoot()
    const packageKey = `node_modules/${expectedName}`
    const declaration = writePackage(root, packageKey, `renamed-${expectedName}`)
    expect(() => resolveLockedPackage(
      expectedName,
      resolve(dirname(declaration), '../package.json'),
      root,
      { [packageKey]: lockEntry },
    )).toThrow(`does not match expected package name ${expectedName}`)
  })

  it('rejects a contradictory optional lock-entry name', () => {
    const root = temporaryRoot()
    const declaration = writePackage(root, 'node_modules/original', 'original')
    expect(() => resolveReviewedProgramPackage(declaration, root, {
      'node_modules/original': { ...lockEntry, name: 'different' },
    })).toThrow('lock entry name different does not match package-lock key name original')
  })

  it('rejects a symlinked package root', () => {
    const root = temporaryRoot()
    const external = temporaryRoot()
    const externalDeclaration = writePackage(external, 'package', 'linked')
    mkdirSync(resolve(root, 'node_modules'), { recursive: true })
    symlinkSync(resolve(external, 'package'), resolve(root, 'node_modules/linked'), 'dir')
    const linkedDeclaration = resolve(root, 'node_modules/linked/dist/index.d.ts')
    expect(readFileSync(linkedDeclaration, 'utf8')).toBe(readFileSync(externalDeclaration, 'utf8'))
    expect(() => resolveReviewedProgramPackage(linkedDeclaration, root, {
      'node_modules/linked': lockEntry,
    })).toThrow('regular non-symlink paths')
  })

  it('rejects a package that escapes through an intermediate symlink', () => {
    const root = temporaryRoot()
    const external = temporaryRoot()
    const externalDeclaration = writePackage(external, 'node_modules/escaped', 'escaped')
    symlinkSync(resolve(external, 'node_modules'), resolve(root, 'node_modules'), 'dir')
    const escapedDeclaration = resolve(root, 'node_modules/escaped/dist/index.d.ts')
    expect(readFileSync(escapedDeclaration, 'utf8')).toBe(readFileSync(externalDeclaration, 'utf8'))
    expect(() => resolveReviewedProgramPackage(escapedDeclaration, root, {
      'node_modules/escaped': lockEntry,
    })).toThrow('resolves outside package-lock ownership')
  })
})

describe('analyzeViemActions fixture profile', () => {
  const analysis = analyzeViemActions({
    cwd: repositoryRoot,
    fixture: {
      moduleSpecifier: fixtureModule,
      packageVersion: '1.2.3',
      packageIntegrity: fixtureIntegrity,
    },
  })

  it('includes finite reads and an Account-injectable Wallet write with stable tool names', () => {
    expect(analysis.packageVersion).toBe('1.2.3')
    expect(analysis.packageIntegrity).toBe(fixtureIntegrity)
    expect(analysis.trustedDependencies).toEqual([])
    expect(analysis.reviewedPackages).toEqual([{
      packageName: 'viem-fixture',
      packageVersion: '1.2.3',
      packageIntegrity: fixtureIntegrity,
    }])
    expect(analysis.reviewedDeclarations).toEqual([
      {
        packageName: 'viem-fixture',
        packageVersion: '1.2.3',
        packageRelativePath: 'viem-impostors.d.ts',
        sha256: `sha256:${createHash('sha256').update(readFileSync(resolve(dirname(fixtureDeclaration), 'viem-impostors.d.ts'))).digest('hex')}`,
      },
      {
        packageName: 'viem-fixture',
        packageVersion: '1.2.3',
        packageRelativePath: 'viem-mini.d.ts',
        sha256: `sha256:${createHash('sha256').update(readFileSync(fixtureDeclaration)).digest('hex')}`,
      },
    ])
    expect(analysis.included.map(({ toolName }) => toolName)).toEqual([
      'workflow.chain.public.abi_result',
      'workflow.chain.public.bytes',
      'workflow.chain.public.fill_transaction',
      'workflow.chain.public.get_balance',
      'workflow.chain.public.get_chain_id',
      'workflow.chain.public.read_hex',
      'workflow.chain.wallet.send_transaction',
      'workflow.chain.wallet.write_contract',
    ])
    expect(analysis.included.find(({ sourceName }) => sourceName === 'sendTransaction')?.signature)
      .toContain('account?: Account')
  })

  it('classifies every rejected fixture member with a reviewed structural reason', () => {
    expect(analysis.excluded.map(({ sourceProfile, sourceName, reasonCode }) =>
      `${sourceProfile}:${sourceName}:${reasonCode}`)).toEqual([
      'viem-public:abiPromise:callback_input',
      'viem-public:abiWithUnknown:non_finite_request',
      'viem-public:abiWithUnsafeOutput:non_finite_response',
      'viem-public:broadcastSigned:authenticated_write_not_bound',
      'viem-public:broadcastUnknown:authenticated_write_not_bound',
      'viem-public:deepRelay:authenticated_write_not_bound',
      'viem-public:foreignAccount:opaque_runtime_object',
      'viem-public:foreignBytes:opaque_runtime_object',
      'viem-public:foreignChain:callback_input',
      'viem-public:getCallback:callback_output',
      'viem-public:getClient:opaque_runtime_object',
      'viem-public:inspectRaw:authenticated_write_not_bound',
      'viem-public:inspectSerialized:authenticated_write_not_bound',
      'viem-public:nestedAccount:opaque_runtime_object',
      'viem-public:nestedPromise:callback_input',
      'viem-public:nestedPromiseOutput:callback_output',
      'viem-public:promiseInput:callback_input',
      'viem-public:providerInput:callback_input',
      'viem-public:relayAlias:authenticated_write_not_bound',
      'viem-public:relayBare:authenticated_write_not_bound',
      'viem-public:relayBytes:authenticated_write_not_bound',
      'viem-public:relayHex:authenticated_write_not_bound',
      'viem-public:token:opaque_runtime_object',
      'viem-public:untrustedAbi:non_finite_request',
      'viem-public:waitForReceipt:callback_input',
      'viem-public:watchBlocks:subscription',
      'viem-wallet:foreignKzg:callback_input',
      'viem-wallet:getAddresses:account_not_injectable',
      'viem-wallet:token:opaque_runtime_object',
      'viem-wallet:waitForTransaction:callback_input',
    ])
  })

  it('accounts for each fixture property exactly once', () => {
    const classified = [...analysis.included, ...analysis.excluded]
      .map(({ sourceProfile, sourceName }) => `${sourceProfile}:${sourceName}`)
    expect(classified).toHaveLength(new Set(classified).size)
    expect(classified.toSorted()).toEqual([
      'viem-public:abiPromise',
      'viem-public:abiResult',
      'viem-public:abiWithUnknown',
      'viem-public:abiWithUnsafeOutput',
      'viem-public:broadcastSigned',
      'viem-public:broadcastUnknown',
      'viem-public:bytes',
      'viem-public:deepRelay',
      'viem-public:fillTransaction',
      'viem-public:foreignAccount',
      'viem-public:foreignBytes',
      'viem-public:foreignChain',
      'viem-public:getBalance',
      'viem-public:getCallback',
      'viem-public:getChainId',
      'viem-public:getClient',
      'viem-public:inspectRaw',
      'viem-public:inspectSerialized',
      'viem-public:nestedAccount',
      'viem-public:nestedPromise',
      'viem-public:nestedPromiseOutput',
      'viem-public:promiseInput',
      'viem-public:providerInput',
      'viem-public:readHex',
      'viem-public:relayAlias',
      'viem-public:relayBare',
      'viem-public:relayBytes',
      'viem-public:relayHex',
      'viem-public:token',
      'viem-public:untrustedAbi',
      'viem-public:waitForReceipt',
      'viem-public:watchBlocks',
      'viem-wallet:foreignKzg',
      'viem-wallet:getAddresses',
      'viem-wallet:sendTransaction',
      'viem-wallet:token',
      'viem-wallet:waitForTransaction',
      'viem-wallet:writeContract',
    ])
  })

  it('projects Type graphs while the compiler session is live and returns only detached data', () => {
    const projected = analyzeViemActions({
      cwd: repositoryRoot,
      fixture: {
        moduleSpecifier: fixtureModule,
        packageVersion: '1.2.3',
        packageIntegrity: fixtureIntegrity,
      },
      project: ({ checker, inputType, outputType, sourceProfile, sourceName, completion, boundary }) => ({
        sourceProfile,
        sourceName,
        completion,
        boundary,
        input: checker.typeToString(inputType),
        output: checker.typeToString(outputType),
        inputProperties: checker.getPropertiesOfType(inputType).map(({ name }) => name).toSorted(),
      }),
    })
    const write = projected.included.find(({ sourceName }) => sourceName === 'writeContract')
    expect(write?.projection).toEqual({
      sourceProfile: 'viem-wallet',
      sourceName: 'writeContract',
      completion: 'external_handle',
      boundary: {
        omittedInputProperties: ['account', 'kzg'],
        addressInputProperties: [],
        dynamicJsonInputProperties: ['abi', 'args'],
        dynamicJsonOutput: false,
      },
      input: '{ readonly account: Account; readonly abi: readonly AbiParameter[]; readonly functionName: string; readonly args?: readonly unknown[] | undefined; readonly kzg?: Kzg | undefined; }',
      output: 'Promise<`0x${string}`>',
      inputProperties: ['abi', 'account', 'args', 'functionName', 'kzg'],
    })
    expect(Object.hasOwn(write ?? {}, 'inputType')).toBe(false)
    expect(Object.hasOwn(write ?? {}, 'outputType')).toBe(false)
    expect(projected.included.find(({ sourceName }) => sourceName === 'abiResult')?.projection.boundary)
      .toMatchObject({ dynamicJsonOutput: true })
  })

  it('rejects a projector that attempts to leak a compiler handle', () => {
    expect(() => analyzeViemActions({
      cwd: repositoryRoot,
      fixture: {
        moduleSpecifier: fixtureModule,
        packageVersion: '1.2.3',
        packageIntegrity: fixtureIntegrity,
      },
      project: ({ inputType }) => inputType as never,
    })).toThrow('canonicalJson requires a plain JSON tree')
  })

  it('closes the compiler API even when snapshot disposal throws', () => {
    let closed = false
    expect(() => closeCompilerSession({ dispose: () => { throw new Error('dispose failed') } }, {
      close: () => { closed = true },
    })).toThrow('dispose failed')
    expect(closed).toBe(true)
  })

  it('accepts only canonical 64-byte SHA-512 integrity', () => {
    expect(isCanonicalSha512Integrity(fixtureIntegrity)).toBe(true)
    expect(isCanonicalSha512Integrity('sha512-QQ==')).toBe(false)
    expect(isCanonicalSha512Integrity('sha512-////')).toBe(false)
  })
})

describe('analyzeViemActions installed viem profile', () => {
  const analysis = analyzeViemActions({ cwd: repositoryRoot })
  const probePath = resolve(repositoryRoot, '.test-viem-members.ts')
  const probeSource = [
    "import type { PublicActions, WalletActions } from 'viem'",
    'export type TestPublicActions = PublicActions',
    'export type TestWalletActions = WalletActions',
    '',
  ].join('\n')
  const owned = new Map([[probePath, probeSource]])
  const virtualFileSystem = {
    readFile: (path: string): string | undefined => owned.get(path),
    fileExists: (path: string): boolean | undefined => owned.has(path) ? true : undefined,
    directoryExists: (_path: string): undefined => undefined,
    getAccessibleEntries: (_path: string): undefined => undefined,
    realpath: (_path: string): undefined => undefined,
  }
  const inspectionApi = new API({ cwd: repositoryRoot, fs: virtualFileSystem })
  const snapshot = inspectionApi.updateSnapshot({ openFiles: [probePath] })

  afterAll(() => {
    snapshot.dispose()
    inspectionApi.close()
  })

  it('classifies exactly the independently inspected installed properties', () => {
    const project = snapshot.getDefaultProjectForFile(probePath)
    const sourceFile = project?.program.getSourceFile(probePath)
    if (project === undefined || sourceFile === undefined) throw new Error('test viem probe did not resolve')
    const exports = project.checker.getSymbolAtLocation(sourceFile)?.getExports()
    if (exports === undefined) throw new Error('test viem probe has no exports')

    const expected = (['TestPublicActions', 'TestWalletActions'] as const).flatMap((alias) => {
      const symbol = exports.get(alias)
      if (symbol === undefined) throw new Error(`test viem probe missing ${alias}`)
      const profile = alias === 'TestPublicActions' ? 'viem-public' : 'viem-wallet'
      return project.checker.getPropertiesOfType(project.checker.getDeclaredTypeOfSymbol(symbol))
        .map(({ name }) => `${profile}:${name}`)
    }).toSorted()

    const classified = [...analysis.included, ...analysis.excluded]
      .map(({ sourceProfile, sourceName }) => `${sourceProfile}:${sourceName}`)
      .toSorted()
    expect(classified).toEqual(expected)
  })

  it('keeps the ABI read/write and receipt polling actions needed by onboarding', () => {
    const included = new Map(analysis.included.map((action) => [
      `${action.sourceProfile}:${action.sourceName}`,
      action,
    ]))
    expect(included.has('viem-public:readContract')).toBe(true)
    expect(included.has('viem-public:getTransactionReceipt')).toBe(true)
    expect(included.get('viem-wallet:writeContract')?.completion).toBe('external_handle')
    expect(included.get('viem-wallet:sendTransaction')?.completion).toBe('external_handle')
    expect(analysis.excluded.find(({ sourceProfile, sourceName }) =>
      sourceProfile === 'viem-public' && sourceName === 'waitForTransactionReceipt')?.reasonCode)
      .toBe('callback_input')
  })

  it('binds trusted transitive declaration packages to exact locked metadata', () => {
    expect(analysis.trustedDependencies).toEqual([
      {
        packageName: 'abitype',
        packageVersion: expect.stringMatching(/^\d+\.\d+\.\d+/),
        packageIntegrity: expect.stringMatching(/^sha512-/),
      },
    ])
    expect(analysis.trustedDependencies.every(({ packageIntegrity }) =>
      isCanonicalSha512Integrity(packageIntegrity))).toBe(true)
  })

  it('returns the exact bounded declaration closure read by the live compiler without local paths', () => {
    const project = snapshot.getDefaultProjectForFile(probePath)
    if (project === undefined) throw new Error('test viem probe did not resolve')
    const expectedThirdPartyFiles = project.program.getSourceFileNames().filter((fileName) => {
      if (resolve(fileName) === resolve(probePath)) return false
      const sourceFile = project.program.getSourceFile(fileName)
      return sourceFile !== undefined && !project.program.isSourceFileDefaultLibrary(sourceFile)
    })
    const keys = analysis.reviewedDeclarations.map(({ packageName, packageRelativePath }) =>
      `${packageName}:${packageRelativePath}`)
    expect(keys).toEqual(keys.toSorted())
    expect(new Set(keys).size).toBe(keys.length)
    expect(analysis.reviewedDeclarations).toHaveLength(expectedThirdPartyFiles.length)
    expect(analysis.reviewedDeclarations.some(({ packageName, packageRelativePath }) =>
      packageName === 'ox' && packageRelativePath !== '_types/index.d.ts')).toBe(true)
    expect(analysis.reviewedDeclarations.some(({ packageName, packageRelativePath }) =>
      packageName === 'viem' && packageRelativePath.startsWith('_types/'))).toBe(true)
    expect(analysis.reviewedDeclarations.some(({ packageName, packageRelativePath }) =>
      packageName === 'ox' && packageRelativePath.startsWith('_types/'))).toBe(true)
    expect(analysis.reviewedPackages.map(({ packageName }) => packageName)).toEqual(
      expect.arrayContaining([
        'viem',
        'abitype',
        'ox',
        '@noble/curves',
        '@noble/hashes',
        '@scure/bip32',
        '@scure/bip39',
        'eventemitter3',
      ]),
    )
    expect(analysis.reviewedPackages.map(({ packageName }) => packageName))
      .toEqual(analysis.reviewedPackages.map(({ packageName }) => packageName).toSorted())
    for (const declaration of analysis.reviewedDeclarations) {
      expect(declaration.packageVersion).toMatch(/^\d+\.\d+\.\d+/)
      expect(isAbsolute(declaration.packageRelativePath)).toBe(false)
      expect(declaration.packageRelativePath.split('/')).not.toContain('..')
      expect(declaration.sha256).toMatch(/^sha256:[0-9a-f]{64}$/)
    }
    for (const package_ of analysis.reviewedPackages) {
      expect(isCanonicalSha512Integrity(package_.packageIntegrity)).toBe(true)
    }
    expect(JSON.stringify(analysis.reviewedDeclarations)).not.toContain(repositoryRoot)
    expect(JSON.stringify(analysis.reviewedPackages)).not.toContain(repositoryRoot)
  })

  it('produces a reviewable sorted report for the exact installed dependency', () => {
    const report = [...analysis.included.map(({ sourceProfile, sourceName, toolName, completion }) => ({
      sourceProfile,
      sourceName,
      result: 'included',
      toolName,
      completion,
    })), ...analysis.excluded.map(({ sourceProfile, sourceName, reasonCode }) => ({
      sourceProfile,
      sourceName,
      result: 'excluded',
      reasonCode,
    }))].toSorted((left, right) => `${left.sourceProfile}:${left.sourceName}`.localeCompare(`${right.sourceProfile}:${right.sourceName}`))

    expect({
      version: analysis.packageVersion,
      integrity: analysis.packageIntegrity,
      report,
    }).toMatchSnapshot()
  })
})
