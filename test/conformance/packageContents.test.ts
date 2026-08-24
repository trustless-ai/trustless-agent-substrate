import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { TextDecoder } from 'node:util'

import { describe, expect, it } from 'vitest'

import vitestConfig from '../../vitest.config.js'

const repositoryRoot = fileURLToPath(new URL('../../', import.meta.url))
const maximumPackedTextBytes = 1024 * 1024
const documentedPrivateKeyExample = '0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'
const sensitiveUrlParameters = new Set([
  'token', 'key', 'secret', 'auth', 'api_key', 'apikey', 'access_token', 'password', 'passwd',
])

interface PackFile {
  readonly path: string
  readonly size: number
}

interface PackResult {
  readonly files: readonly PackFile[]
}

function tarballs(): readonly string[] {
  return readdirSync(repositoryRoot).filter((name) => name.endsWith('.tgz')).sort()
}

function dryRunPackage(): PackResult {
  const before = tarballs()
  expect(before).toEqual([])
  const output = execFileSync('npm', ['pack', '--dry-run', '--json'], {
    cwd: repositoryRoot,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
    timeout: 120_000,
  })
  expect(tarballs()).toEqual(before)
  const parsed: unknown = JSON.parse(output)
  expect(parsed).toEqual([expect.objectContaining({ files: expect.any(Array) })])
  return (parsed as readonly PackResult[])[0]!
}

function expectedCompiledInventory(): readonly string[] {
  const compiler = JSON.parse(readFileSync(resolve(repositoryRoot, 'tsconfig.json'), 'utf8')) as {
    readonly compilerOptions?: Readonly<{
      rootDir?: string
      outDir?: string
      declaration?: boolean
      sourceMap?: boolean
      declarationMap?: boolean
      noEmit?: boolean
      emitDeclarationOnly?: boolean
    }>
    readonly include?: readonly string[]
  }
  const options = compiler.compilerOptions
  if (
    options?.rootDir !== 'src'
    || options.outDir !== 'dist'
    || options.declaration !== true
    || options.noEmit === true
    || options.emitDeclarationOnly === true
    || compiler.include?.length !== 1
    || compiler.include[0] !== 'src/**/*.ts'
  ) {
    throw new Error('The package conformance gate does not recognize the TypeScript emission contract.')
  }

  const sourceRoot = resolve(repositoryRoot, options.rootDir)
  const sources: string[] = []
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = resolve(directory, entry.name)
      if (entry.isDirectory()) visit(path)
      else if (entry.isFile() && entry.name.endsWith('.ts')) sources.push(path)
    }
  }
  visit(sourceRoot)

  return sources.flatMap((source) => {
    const sourcePath = relative(sourceRoot, source).split(sep).join('/')
    if (sourcePath.endsWith('.d.ts')) throw new Error('Ambient source declarations need an explicit package rule.')
    const stem = sourcePath.slice(0, -'.ts'.length)
    return [
      `${options.outDir}/${stem}.js`,
      `${options.outDir}/${stem}.d.ts`,
      ...(options.sourceMap === true ? [`${options.outDir}/${stem}.js.map`] : []),
      ...(options.declarationMap === true ? [`${options.outDir}/${stem}.d.ts.map`] : []),
    ]
  }).sort()
}

function readSafePackedText(file: PackFile): string {
  expect(file.size, `${file.path} exceeds the bounded text policy`).toBeLessThanOrEqual(maximumPackedTextBytes)
  const bytes = readFileSync(resolve(repositoryRoot, file.path))
  expect(bytes.byteLength).toBe(file.size)
  expect(bytes.includes(0), `${file.path} contains binary NUL bytes`).toBe(false)
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  assertSafePackedText(file.path, text)
  return text
}

function urlSchemeLengthAt(text: string, index: number): 0 | 7 | 8 {
  const prefix = text.slice(index, index + 8).toLowerCase()
  if (prefix.startsWith('https://')) return 8
  if (prefix.startsWith('http://')) return 7
  return 0
}

function isUrlCandidateDelimiter(character: string): boolean {
  const code = character.charCodeAt(0)
  return code <= 0x20 || '"\'`<>'.includes(character)
}

function assertSafeUrlCandidates(path: string, text: string): void {
  let cursor = 0
  while (cursor < text.length) {
    const schemeLength = urlSchemeLengthAt(text, cursor)
    if (schemeLength === 0) {
      cursor += 1
      continue
    }

    let end = cursor + schemeLength
    while (end < text.length) {
      if (urlSchemeLengthAt(text, end) !== 0 || isUrlCandidateDelimiter(text[end]!)) break
      end += 1
    }
    const candidate = text.slice(cursor, end)
    let parsed: URL
    try {
      parsed = new URL(candidate)
    } catch {
      throw new Error(`${path} contains a malformed HTTP URL candidate`)
    }
    if (parsed.username !== '' || parsed.password !== '') {
      throw new Error(`${path} contains a credential-bearing endpoint`)
    }
    for (const parameter of parsed.searchParams.keys()) {
      if (sensitiveUrlParameters.has(parameter.toLowerCase())) {
        throw new Error(`${path} contains a credential-bearing endpoint`)
      }
    }
    cursor = end
  }
}

function assertSafePackedText(path: string, text: string): void {
  const scanned = path === 'docs/tas/CREDENTIALS.md'
    ? text.replace(documentedPrivateKeyExample, '<documented-private-key-example>')
    : text
  expect(scanned, `${path} contains a private key`).not.toMatch(
    /(?:\bprivate(?:key|[_ .-]key)\b|\bsecret\b)["']?[ \t\r\n]{0,32}[:=][ \t\r\n]{0,32}["']?(?:0x)?[0-9a-fA-F]{64}\b/i,
  )
  expect(scanned, `${path} contains a credential token`).not.toMatch(
    /(?:\bgh[pousr]_[A-Za-z0-9_]{20,}\b|\bnpm_[A-Za-z0-9]{36}\b|\bAKIA[0-9A-Z]{16}\b|-----BEGIN [A-Z ]*PRIVATE KEY-----|\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b)/,
  )
  assertSafeUrlCandidates(path, scanned)
  expect(scanned, `${path} contains a live RPC endpoint marker`).not.toMatch(
    /https?:\/\/(?:localhost(?::\d+)?|127\.0\.0\.1(?::\d+)?|[^\s/]*(?:infura|alchemy|quicknode|ankr)[^\s/]*)\//i,
  )
}

function assertExactInventory(result: PackResult): void {
  const inventory = result.files.map(({ path }) => path).sort()
  const expectedMetadata = [
    'LICENSE',
    'README.md',
    'docs/tas/CREDENTIALS.md',
    'manifests/agent-sdk-report.v1.json',
    'manifests/agent-sdk.v1.json',
    'manifests/discord-report.v1.json',
    'manifests/discord.v1.json',
    'manifests/telegram-report.v1.json',
    'manifests/telegram.v1.json',
    'manifests/viem-public.v1.json',
    'manifests/viem-report.v1.json',
    'manifests/viem-wallet.v1.json',
    'package.json',
    'skills/tas/SKILL.md',
    'skills/tawg-collaboration/SKILL.md',
  ]
  const expected = [...expectedCompiledInventory(), ...expectedMetadata].sort()
  const unexpected = inventory.filter((path) => !expected.includes(path))
  const missing = expected.filter((path) => !inventory.includes(path))
  if (unexpected.length > 0 || missing.length > 0) {
    throw new Error(`npm package inventory mismatch; unexpected=[${unexpected.join(',')}]; missing=[${missing.join(',')}]`)
  }
}

describe('npm package contents', () => {
  it('publishes all TypeScript production sources to the coverage provider', () => {
    const config = vitestConfig as { readonly test?: { readonly coverage?: { readonly include?: readonly string[] } } }
    expect(config.test?.coverage?.include).toEqual(['src/**/*.ts'])
  })

  it('packs exactly the built runtime, release Skill, credential contract, and npm metadata', () => {
    const result = dryRunPackage()
    const inventory = result.files.map(({ path }) => path).sort()

    expect(() => assertExactInventory(result)).not.toThrow()
    expect(inventory).toContain('dist/app/main.js')
    expect(inventory).toContain('dist/app/main.d.ts')
    expect(inventory.some((path) => path.startsWith('dist/core/profile/'))).toBe(true)
    expect(inventory.some((path) => path.startsWith('dist/core/skill/'))).toBe(true)
    expect(inventory.some((path) => path.startsWith('dist/local/config/'))).toBe(true)
    expect(inventory.some((path) => path.startsWith('dist/local/instance/'))).toBe(true)
    expect(inventory.filter((path) => path.startsWith('manifests/'))).toEqual([
      'manifests/agent-sdk-report.v1.json',
      'manifests/agent-sdk.v1.json',
      'manifests/discord-report.v1.json',
      'manifests/discord.v1.json',
      'manifests/telegram-report.v1.json',
      'manifests/telegram.v1.json',
      'manifests/viem-public.v1.json',
      'manifests/viem-report.v1.json',
      'manifests/viem-wallet.v1.json',
    ])

    const packageMetadata = JSON.parse(readFileSync(resolve(repositoryRoot, 'package.json'), 'utf8')) as {
      readonly bin?: Readonly<Record<string, string>>
    }
    expect(packageMetadata.bin).toEqual({ tas: 'dist/app/main.js' })
    expect(inventory).toContain(packageMetadata.bin!.tas)
  })

  it('rejects a stale packed dist artifact with no source module', () => {
    const staleName = `stale-review-${randomUUID()}.js`
    const stalePath = `dist/${staleName}`
    const staleArtifact = resolve(repositoryRoot, stalePath)
    let created = false
    try {
      writeFileSync(staleArtifact, 'export const stale = true\n', { encoding: 'utf8', flag: 'wx' })
      created = true
      const result = dryRunPackage()
      expect(result.files.map(({ path }) => path)).toContain(stalePath)
      expect(() => assertExactInventory(result)).toThrow(
        `npm package inventory mismatch; unexpected=[${stalePath}]; missing=[]`,
      )
    } finally {
      if (created) unlinkSync(staleArtifact)
    }
  })

  it('excludes test, state, legacy, source, config, credential, and build scaffolding', () => {
    const result = dryRunPackage()
    const forbidden = /^(?:test|coverage|\.superpowers|\.tas-e2e|cmd|internal|config|docker|scripts|tas-skills|tawg|src)(?:\/|$)|(?:^|\/)(?:go\.(?:mod|sum)|.*\.go|.*\.toml|.*\.ya?ml|.*\.log|.*\.lock|credentials\.toml)$/
    for (const { path } of result.files) expect(path, `forbidden package entry: ${path}`).not.toMatch(forbidden)
  })

  it('bounded-decodes and scans every packed artifact without creating a tarball', () => {
    const result = dryRunPackage()
    for (const file of result.files) expect(readSafePackedText(file).length).toBeGreaterThan(0)
  })

  it.each([
    ['TOML private key', `private_key = "0x${'12'.repeat(32)}"`],
    ['JSON private key', `{"privateKey":"0x${'23'.repeat(32)}"}`],
    ['secret assignment', `secret = "0x${'34'.repeat(32)}"`],
    ['LF JavaScript private key assignment', `const privateKey =\n"0x${'35'.repeat(32)}"`],
    ['CRLF JavaScript private key assignment', `const privateKey =\r\n"${'36'.repeat(32)}"`],
    ['multiline JSON private key field', `{"privateKey":\n"0x${'37'.repeat(32)}"}`],
    ['npm token', ['np', 'm_', '0'.repeat(36)].join('')],
  ])('rejects synthetic credential material in packed text: %s', (_name, text) => {
    expect(() => assertSafePackedText('dist/synthetic.js', text)).toThrow()
  })

  it.each([
    'token', 'key', 'secret', 'auth', 'api_key', 'apikey', 'access_token', 'password', 'passwd',
  ])('rejects a credential-bearing endpoint using the %s parameter', (parameter) => {
    const endpoint = `https://rpc.example.invalid/path?${parameter}=synthetic-value`
    expect(() => assertSafePackedText('dist/synthetic.js', endpoint)).toThrow()
  })

  it.each([
    ['percent-encoded sensitive parameter', 'https://rpc.example.invalid/path?%74oken=synthetic-value'],
    ['mixed-case sensitive parameter', 'https://rpc.example.invalid/path?Access_Token=synthetic-value'],
    ['username', 'https://synthetic-user@rpc.example.invalid/path'],
    ['password', 'https://synthetic-user:synthetic-pass@rpc.example.invalid/path'],
    ['malformed candidate', 'https://[malformed-host'],
    ['credential URL after a delimiter', 'https://safe.example.invalid/path,https://rpc.example.invalid/?token=synthetic-value'],
    ['second URL token query after a queried URL and comma', 'https://safe.example.invalid/path?public=value,https://rpc.example.invalid/?token=synthetic-value'],
    ['second URL userinfo after a queried URL and semicolon', 'https://safe.example.invalid/path?public=value;https://synthetic-user@rpc.example.invalid/path'],
    ['sensitive parameter after a semicolon path segment', 'https://rpc.example.invalid/path;segment?token=synthetic-value'],
    ['sensitive parameter after a parenthesized path segment', 'https://rpc.example.invalid/path(section)?access_token=synthetic-value'],
  ])('rejects a parsed unsafe or malformed URL candidate: %s', (_name, text) => {
    expect(() => assertSafePackedText('dist/synthetic.js', text)).toThrow()
  })

  it.each([
    'https://repository.example.invalid/path?not_token=public-value',
    'HTTP://EXAMPLE.INVALID/PUBLIC',
    'https://[2001:db8::1]/public',
    'https://first.example.invalid/path?public=value,https://second.example.invalid/path?other=value',
    'text before https://example.invalid/path#public-fragment and text after',
  ])('allows a parsed public URL candidate: %s', (text) => {
    expect(() => assertSafePackedText('dist/synthetic.js', text)).not.toThrow()
  })

  it('does not quadratically rescan repeated URL-scheme prefixes', () => {
    const repeatedCandidate = 'https://safe.example.invalid/public,'
    const input = repeatedCandidate.repeat(Math.floor((maximumPackedTextBytes - 1) / repeatedCandidate.length))
    const started = performance.now()
    expect(() => assertSafePackedText('dist/synthetic.js', input)).not.toThrow()
    expect(performance.now() - started).toBeLessThan(2_000)
  })

  it.each([
    ['block hash', `block_hash = "0x${'45'.repeat(32)}"`],
    ['transaction hash', `transaction_hash = "0x${'56'.repeat(32)}"`],
    ['content digest', `content_digest = "0x${'67'.repeat(32)}"`],
  ])('allows a public 32-byte %s', (_name, text) => {
    expect(() => assertSafePackedText('dist/synthetic.js', text)).not.toThrow()
  })

  it.each([
    ['LF separate fields', `secret = "redacted"\nblock_hash = "0x${'68'.repeat(32)}"`],
    ['CRLF separate fields', `private_key = "redacted"\r\ntransaction_hash = "0x${'69'.repeat(32)}"`],
    ['JSON separate fields', `{"secret":"redacted",\n"content_digest":"0x${'6a'.repeat(32)}"}`],
    ['guidance near public hash', `Never publish a private key.\nblock_hash = "0x${'6b'.repeat(32)}"`],
  ])('allows a public 32-byte hash near unrelated secret guidance: %s', (_name, text) => {
    expect(() => assertSafePackedText('dist/synthetic.js', text)).not.toThrow()
  })

  it('allows only the explicit Credential Contract private-key example in its documented context', () => {
    expect(() => assertSafePackedText(
      'docs/tas/CREDENTIALS.md',
      `private_key = "${documentedPrivateKeyExample}"`,
    )).not.toThrow()
    expect(() => assertSafePackedText(
      'skills/tas/SKILL.md',
      `private_key = "${documentedPrivateKeyExample}"`,
    )).toThrow()
  })
})
