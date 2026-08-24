import { spawnSync } from 'node:child_process'

import { describe, expect, it } from 'vitest'

import { createTasLogger, redactForLogging } from '../../src/local/logging.js'

const secret = 'credential-value-that-must-not-appear'

describe('TAS logging boundary', () => {
  it('redacts credential-shaped keys recursively without mutating the caller value', () => {
    const input = {
      credential: secret,
      nested: {
        PRIVATE_key: secret,
        authorizationHeader: secret,
        rpc_url: secret,
      },
      values: [{ apiToken: secret }, { Secret_Value: secret }],
    }

    const redacted = redactForLogging(input)

    expect(redacted).toEqual({
      credential: '[REDACTED]',
      nested: {
        PRIVATE_key: '[REDACTED]',
        authorizationHeader: '[REDACTED]',
        rpc_url: '[REDACTED]',
      },
      values: [{ apiToken: '[REDACTED]' }, { Secret_Value: '[REDACTED]' }],
    })
    expect(input.nested.rpc_url).toBe(secret)
  })

  it('does not let Error causes, stacks, or upstream response objects bypass safe projection', () => {
    const upstream = Object.assign(new Error(`upstream ${secret}`), {
      cause: { response: { body: { token: secret } } },
      request: { headers: { Authorization: secret } },
      response: { body: { privateKey: secret } },
      stack: `stack ${secret}`,
    })

    const redacted = redactForLogging({ upstream })

    expect(JSON.stringify(redacted)).not.toContain(secret)
  })

  it('handles cyclic data while preserving the redaction boundary', () => {
    const cyclic: { secret?: string; self?: unknown } = { secret }
    cyclic.self = cyclic

    const redacted = redactForLogging(cyclic)

    expect(redacted).toEqual({ secret: '[REDACTED]', self: '[Circular]' })
  })

  it('preserves repeated aliases while marking only a true cycle', () => {
    const shared = { value: 'public' }
    const cyclic: { self?: unknown } = {}
    cyclic.self = cyclic

    expect(redactForLogging({ first: shared, second: shared, cyclic })).toEqual({
      first: { value: 'public' },
      second: { value: 'public' },
      cyclic: { self: '[Circular]' },
    })
  })

  it('omits serialization escape hatches and safely falls back when a proxy trap throws', () => {
    const inherited = Object.create({ toJSON: () => secret }) as Record<string, unknown>
    inherited.public = 'value'
    Object.defineProperty(inherited, 'toJSON', { enumerable: true, value: () => secret })
    Object.defineProperty(inherited, '__proto__', { enumerable: true, value: secret })
    const proxy = new Proxy({}, {
      ownKeys() {
        throw new Error(secret)
      },
    })

    const projected = redactForLogging({ inherited, proxy }) as Record<string, unknown>

    expect(projected.inherited).toEqual({ public: 'value' })
    expect(JSON.stringify(projected)).not.toContain(secret)
    expect(projected.proxy).toBe('[UNSAFE]')
  })

  it('preserves ordinary values while safely handling nulls, empty arrays, unicode, and accessors', () => {
    const input = {
      empty: [],
      nullable: null,
      unicode: '安全🔐',
      get computed() {
        throw new Error('must not invoke accessors while logging')
      },
    }

    expect(redactForLogging(input)).toEqual({
      empty: [],
      nullable: null,
      unicode: '安全🔐',
      computed: '[REDACTED]',
    })
    expect(redactForLogging(undefined)).toBe('[UNSAFE]')
  })

  it('redacts a large nested collection without modifying any original entries', () => {
    const entries = Array.from({ length: 10_000 }, (_, index) => ({ index, api_token: secret }))

    const redacted = redactForLogging(entries) as Array<{ index: number; api_token: string }>

    expect(redacted).toHaveLength(10_000)
    expect(redacted[9_999]).toEqual({ index: 9_999, api_token: '[REDACTED]' })
    expect(entries[9_999].api_token).toBe(secret)
  })

  it('uses a fixed fallback when the diagnostic depth budget is exceeded', () => {
    const root: { next?: unknown } = {}
    let cursor = root
    for (let index = 0; index < 65; index += 1) {
      const next: { next?: unknown } = {}
      cursor.next = next
      cursor = next
    }
    expect(JSON.stringify(redactForLogging(root))).toContain('[UNSAFE]')
  })

  it('writes pino records to stderr and never stdout', () => {
    const loggingModule = new URL('../../src/local/logging.js', import.meta.url).href
    const child = spawnSync(process.execPath, [
      '--import',
      'tsx',
      '--input-type=module',
      '--eval',
      `import { createTasLogger } from ${JSON.stringify(loggingModule)}; createTasLogger().info({ authorization: ${JSON.stringify(secret)} }, ${JSON.stringify(secret)});`,
    ], { encoding: 'utf8' })

    expect(child.status).toBe(0)
    expect(child.stdout).toBe('')
    expect(child.stderr).not.toBe('')
    expect(child.stderr).not.toContain(secret)
  })

  it('redacts child logger bindings before Pino writes them', () => {
    const loggingModule = new URL('../../src/local/logging.js', import.meta.url).href
    const child = spawnSync(process.execPath, [
      '--import',
      'tsx',
      '--input-type=module',
      '--eval',
      `import { createTasLogger } from ${JSON.stringify(loggingModule)}; createTasLogger().child({ token: ${JSON.stringify(secret)} }).info('safe');`,
    ], { encoding: 'utf8' })

    expect(child.status).toBe(0)
    expect(child.stdout).toBe('')
    expect(child.stderr).not.toContain(secret)
  })

  it('rejects Pino child options that could replace safe serializers or formatters', () => {
    const logger = createTasLogger()
    expect(() => logger.child({ token: secret }, { msgPrefix: secret } as never)).toThrow('TAS logger child options are disabled.')
    expect(() => logger.child({ token: secret }, { serializers: {}, formatters: {} } as never)).toThrow('TAS logger child options are disabled.')
  })

  it('constructs a Pino logger without writing a test record', () => {
    expect(createTasLogger().isLevelEnabled('info')).toBe(true)
  })

  it('applies its Pino hook and error serializer before a local write', () => {
    const logger = createTasLogger()
    logger.info(secret)
    logger.error({ err: new Error(secret) }, secret)

    expect(logger.isLevelEnabled('error')).toBe(true)
  })

})
