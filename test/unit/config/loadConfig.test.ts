import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { TasError } from '../../../src/core/errors.js'
import { loadTasConfig } from '../../../src/local/config/loadConfig.js'

const fixtures = join(import.meta.dirname, '../../fixtures/config')
const rpcSecret = 'https://rpc-user:rpc-password@rpc.example.test/secret-token'
const tokenMarker = 'telegram-token-should-never-leak'
const directories: string[] = []

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { force: true, recursive: true })
})

function fixture(name: string): string {
  const directory = mkdtempSync(join(tmpdir(), 'tas-config-'))
  directories.push(directory)
  const destination = join(directory, name)
  cpSync(join(fixtures, name), destination)
  return destination
}

function toml(source: string): string {
  const directory = mkdtempSync(join(tmpdir(), 'tas-config-'))
  directories.push(directory)
  const path = join(directory, 'tas.toml')
  writeFileSync(path, source)
  return path
}

function validMember(): string {
  return readFileSync(join(fixtures, 'member-valid.toml'), 'utf8')
}

async function expectConfigError(
  path: string,
  expectedCode: TasError['code'],
  environment: Readonly<Record<string, string | undefined>> = { TAS_RPC_URL: rpcSecret },
): Promise<TasError> {
  try {
    await loadTasConfig(path, environment)
    throw new Error('expected configuration loading to fail')
  } catch (error) {
    expect(error).toBeInstanceOf(TasError)
    const tasError = error as TasError
    expect(tasError.code).toBe(expectedCode)
    return tasError
  }
}

function serialized(error: TasError): string {
  return JSON.stringify({ message: error.message, details: error.details, cause: error.cause })
}

function throwingEnvironment(secret: string): { readonly environment: Readonly<Record<string, string | undefined>>; readonly reads: () => number } {
  let accesses = 0
  return {
    environment: {
      get TAS_RPC_URL() {
        accesses += 1
        throw new Error(secret)
      },
    },
    reads: () => accesses,
  }
}

function usesRpcEnvironment(source: string): string {
  return source.replace('rpc_url = "https://rpc.example.test"', 'rpc_url_env = "TAS_RPC_URL"')
}

describe('loadTasConfig', () => {
  it('loads and normalizes the identity setup phase', async () => {
    await expect(loadTasConfig(fixture('identity-setup-valid.toml'), { TAS_RPC_URL: rpcSecret })).resolves.toEqual({
      configVersion: 1,
      mode: 'identity_setup',
      identitySetup: {
        chainId: '31337',
        identityRegistryAddress: '0x8004000000000000000000000000000000000001',
      },
      chain: { family: 'evm', rpcUrl: rpcSecret, rpcSource: 'environment' },
    })
  })

  it('loads the complete TAWG setup phase', async () => {
    await expect(loadTasConfig(fixture('tawg-setup-valid.toml'), {})).resolves.toEqual({
      configVersion: 1,
      mode: 'tawg_setup',
      tawgSetup: { chainId: '31337', tawgAddress: '0x8004000000000000000000000000000000000002' },
      chain: { family: 'evm', rpcUrl: 'https://rpc.example.test', rpcSource: 'config' },
    })
  })

  it('loads complete member mode with normalized addresses and configured chat', async () => {
    await expect(loadTasConfig(fixture('member-valid.toml'), { TAS_RPC_URL: rpcSecret })).resolves.toEqual({
      configVersion: 1,
      mode: 'member',
      instance: {
        chainId: '31337',
        tawgAddress: '0x8004000000000000000000000000000000000003',
        agentId: '340282366920938463463374607431768211457',
      },
      chain: { family: 'evm', rpcUrl: rpcSecret, rpcSource: 'environment' },
      repository: { client: 'github' },
      da: { client: 'git' },
      chat: {
        sources: [
          { name: 'telegram-main', platform: 'telegram', pollInterval: '6s' },
          { name: 'discord-main', platform: 'discord', pollInterval: '1000ms' },
        ],
        targets: [
          { name: 'ops', source: 'telegram-main', conversationId: '-100123' },
          { name: 'alerts', source: 'discord-main', conversationId: 'alerts-channel' },
        ],
      },
      proofProviders: [],
    })
  })

  it('reads the selected RPC environment value exactly once', async () => {
    let reads = 0
    const environment = {
      get TAS_RPC_URL() {
        reads += 1
        return 'https://rpc.example.test'
      },
    }

    await loadTasConfig(fixture('identity-setup-valid.toml'), environment)

    expect(reads).toBe(1)
  })

  it('does not resolve an RPC environment value after phase validation fails', async () => {
    let reads = 0
    const environment = {
      get TAS_RPC_URL() {
        reads += 1
        return rpcSecret
      },
    }
    const source = readFileSync(join(fixtures, 'identity-setup-valid.toml'), 'utf8') + '\n[repository]\nclient = "github"\n'

    await expectConfigError(toml(source), 'CONFIG_CONFLICT', environment)

    expect(reads).toBe(0)
  })

  it.each([
    ['identity chain ID', readFileSync(join(fixtures, 'identity-setup-valid.toml'), 'utf8').replace('chain_id = "31337"', 'chain_id = "0"'), 'CONFIG_FIELD_INVALID'],
    ['identity address', readFileSync(join(fixtures, 'identity-setup-valid.toml'), 'utf8').replace('identity_registry_address = "0x8004000000000000000000000000000000000001"', 'identity_registry_address = "bad"'), 'CONFIG_FIELD_INVALID'],
    ['identity unknown nested field', readFileSync(join(fixtures, 'identity-setup-valid.toml'), 'utf8').replace('chain_id = "31337"', 'chain_id = "31337"\nextra = true'), 'CONFIG_FIELD_INVALID'],
    ['TAWG chain ID', usesRpcEnvironment(readFileSync(join(fixtures, 'tawg-setup-valid.toml'), 'utf8').replace('chain_id = "31337"', 'chain_id = "0"')), 'CONFIG_FIELD_INVALID'],
    ['TAWG address', usesRpcEnvironment(readFileSync(join(fixtures, 'tawg-setup-valid.toml'), 'utf8').replace('tawg_address = "0x8004000000000000000000000000000000000002"', 'tawg_address = "bad"')), 'CONFIG_FIELD_INVALID'],
    ['TAWG unknown nested field', usesRpcEnvironment(readFileSync(join(fixtures, 'tawg-setup-valid.toml'), 'utf8').replace('chain_id = "31337"', 'chain_id = "31337"\nextra = true')), 'CONFIG_FIELD_INVALID'],
    ['member instance', validMember().replace('agent_id = "340282366920938463463374607431768211457"', 'agent_id = "01"'), 'CONFIG_FIELD_INVALID'],
    ['member instance unknown nested field', validMember().replace('agent_id = "340282366920938463463374607431768211457"', 'agent_id = "340282366920938463463374607431768211457"\nextra = true'), 'CONFIG_FIELD_INVALID'],
    ['member repository', validMember().replace('client = "github"', 'client = "gitlab"'), 'CONFIG_CLIENT_UNSUPPORTED'],
    ['member repository unknown nested field', validMember().replace('client = "github"', 'client = "github"\nextra = true'), 'CONFIG_FIELD_INVALID'],
    ['member DA', validMember().replace('client = "git"', 'client = "ipfs"'), 'CONFIG_CLIENT_UNSUPPORTED'],
    ['member DA unknown nested field', validMember().replace('client = "git"', 'client = "git"\nextra = true'), 'CONFIG_FIELD_INVALID'],
    ['member chat polling', validMember().replace('poll_interval = "6s"', 'poll_interval = "61s"'), 'CONFIG_FIELD_INVALID'],
    ['member chat reference', validMember().replace('source = "discord-main"', 'source = "missing"'), 'CONFIG_REFERENCE_INVALID'],
    ['member chat unknown nested field', validMember().replace('poll_interval = "6s"', 'poll_interval = "6s", token = "nested-token"'), 'CONFIG_FIELD_INVALID'],
    ['member chat platform', validMember().replace('platform = "telegram"', 'platform = "slack"'), 'CONFIG_CLIENT_UNSUPPORTED'],
    ['member proof provider', validMember() + '\n[[proof_providers]]\nname = "unshipped"\ntype = "attestation"\nintegration = "unshipped"\nbase_url = "https://provider.example.test"\n', 'CONFIG_CLIENT_UNSUPPORTED'],
    ['member proof provider URL', validMember() + '\n[[proof_providers]]\nname = "unshipped"\ntype = "attestation"\nintegration = "unshipped"\nbase_url = "https://user:password@provider.example.test"\n', 'CONFIG_FIELD_INVALID'],
  ])('validates %s before reading the selected RPC environment value', async (_description, source, code) => {
    const secret = `throwing-getter-secret-${_description}`
    const tracked = throwingEnvironment(secret)
    const error = await expectConfigError(toml(source), code as TasError['code'], tracked.environment)

    expect(tracked.reads()).toBe(0)
    expect(serialized(error)).not.toContain(secret)
  })

  it('maps a throwing RPC environment accessor to a safe stable error', async () => {
    const secret = 'throwing-getter-secret-value'
    const tracked = throwingEnvironment(secret)
    const error = await expectConfigError(fixture('identity-setup-valid.toml'), 'CONFIG_ENV_REQUIRED', tracked.environment)

    expect(tracked.reads()).toBe(1)
    expect(error.message).not.toContain(secret)
    expect(serialized(error)).not.toContain(secret)
    expect(error.cause).toBeUndefined()
  })

  it('returns only a stable code and safe diagnostics for every error', async () => {
    const error = await expectConfigError(toml(`config_version = 1\nmode = "identity_setup"\n[identity_setup]\nchain_id = "1"\nidentity_registry_address = "0x0000000000000000000000000000000000000000"\n[chain]\nfamily = "evm"\nrpc_url = "${rpcSecret}"\n`), 'CONFIG_FIELD_INVALID')
    expect(error.message).not.toContain(rpcSecret)
    expect(serialized(error)).not.toContain(rpcSecret)
    expect(Object.keys(error)).toEqual(expect.arrayContaining(['code']))
    expect(error.cause).toBeUndefined()
  })

  it('maps missing files and TOML syntax errors to stable codes', async () => {
    await expectConfigError(join(tmpdir(), 'tas-config-does-not-exist.toml'), 'CONFIG_FILE_NOT_FOUND')
    await expectConfigError(toml('config_version = [\n'), 'CONFIG_PARSE_FAILED')
  })

  it('rejects unsupported versions and unknown fields at root and nested levels', async () => {
    await expectConfigError(toml(validMember().replace('config_version = 1', 'config_version = 2')), 'CONFIG_VERSION_UNSUPPORTED')
    await expectConfigError(toml(validMember().replace('mode = "member"', 'mode = "member"\nunknown = true')), 'CONFIG_FIELD_INVALID')
    await expectConfigError(toml(validMember().replace('client = "github"', 'client = "github"\nlocator = "org/repo"')), 'CONFIG_FIELD_INVALID')
    await expectConfigError(toml(validMember().replace('poll_interval = "6s"', 'poll_interval = "6s", token = "' + tokenMarker + '"')), 'CONFIG_FIELD_INVALID')
  })

  it.each([
    ['zero phase tables', 'config_version = 1\nmode = "member"\n[chain]\nfamily = "evm"\nrpc_url = "https://rpc.example.test"\n[repository]\nclient = "github"\n[da]\nclient = "git"'],
    ['two phase tables', validMember() + '\n[tawg_setup]\nchain_id = "1"\ntawg_address = "0x8004000000000000000000000000000000000004"\n'],
    ['identity mode with TAWG setup table', 'config_version = 1\nmode = "identity_setup"\n\n[tawg_setup]\nchain_id = "1"\ntawg_address = "0x8004000000000000000000000000000000000004"\n\n[chain]\nfamily = "evm"\nrpc_url = "https://rpc.example.test"'],
    ['TAWG setup mode with identity table', 'config_version = 1\nmode = "tawg_setup"\n\n[identity_setup]\nchain_id = "1"\nidentity_registry_address = "0x8004000000000000000000000000000000000004"\n\n[chain]\nfamily = "evm"\nrpc_url = "https://rpc.example.test"'],
    ['member mode with only TAWG setup table', 'config_version = 1\nmode = "member"\n\n[tawg_setup]\nchain_id = "1"\ntawg_address = "0x8004000000000000000000000000000000000004"\n\n[chain]\nfamily = "evm"\nrpc_url = "https://rpc.example.test"\n[repository]\nclient = "github"\n[da]\nclient = "git"'],
    ['member mode with identity table', validMember() + '\n[identity_setup]\nchain_id = "1"\nidentity_registry_address = "0x8004000000000000000000000000000000000004"\n'],
  ])('rejects phase conflicts: %s', async (_description, source) => {
    await expectConfigError(toml(source), 'CONFIG_CONFLICT')
  })

  it.each([
    ['identity setup repository', readFileSync(join(fixtures, 'identity-setup-valid.toml'), 'utf8') + '\n[repository]\nclient = "github"\n'],
    ['identity setup profile', readFileSync(join(fixtures, 'identity-setup-valid.toml'), 'utf8') + '\n[profile]\naddress = "0x8004000000000000000000000000000000000005"\n'],
    ['TAWG setup chat', readFileSync(join(fixtures, 'tawg-setup-valid.toml'), 'utf8') + '\n[chat]\nsources = []\ntargets = []\n'],
    ['member setup table', validMember() + '\n[tawg_setup]\nchain_id = "1"\ntawg_address = "0x8004000000000000000000000000000000000005"\n'],
  ])('does not permit phase capability leakage: %s', async (_description, source) => {
    const expected = _description === 'identity setup profile' ? 'CONFIG_FIELD_INVALID' : 'CONFIG_CONFLICT'
    await expectConfigError(toml(source), expected)
  })

  it('does not accept the obsolete bare setup phase names', async () => {
    await expectConfigError(toml('config_version = 1\nmode = "setup"\n[setup]\nchain_id = "1"\ntawg_address = "0x8004000000000000000000000000000000000005"\n[chain]\nfamily = "evm"\nrpc_url = "https://rpc.example.test"'), 'CONFIG_FIELD_INVALID')
  })

  it('requires only its matching phase table', async () => {
    await expectConfigError(toml('config_version = 1\nmode = "identity_setup"\n[chain]\nfamily = "evm"\nrpc_url = "https://rpc.example.test"'), 'CONFIG_CONFLICT')
    await expectConfigError(toml('config_version = 1\nmode = "tawg_setup"\n[chain]\nfamily = "evm"\nrpc_url = "https://rpc.example.test"'), 'CONFIG_CONFLICT')
    await expectConfigError(toml('config_version = 1\nmode = "member"\n[chain]\nfamily = "evm"\nrpc_url = "https://rpc.example.test"\n[repository]\nclient = "github"\n[da]\nclient = "git"'), 'CONFIG_CONFLICT')
  })

  it.each([
    ['leading zero chain ID', validMember().replace('chain_id = "31337"', 'chain_id = "031337"')],
    ['negative chain ID', validMember().replace('chain_id = "31337"', 'chain_id = "-1"')],
    ['zero chain ID', validMember().replace('chain_id = "31337"', 'chain_id = "0"')],
    ['overflow agent ID', validMember().replace('agent_id = "340282366920938463463374607431768211457"', 'agent_id = "115792089237316195423570985008687907853269984665640564039457584007913129639936"')],
    ['noncanonical agent ID', validMember().replace('agent_id = "340282366920938463463374607431768211457"', 'agent_id = "01"')],
    ['zero EVM address', validMember().replace('0x8004000000000000000000000000000000000003', '0x0000000000000000000000000000000000000000')],
    ['invalid EVM address', validMember().replace('0x8004000000000000000000000000000000000003', 'not-an-address')],
  ])('rejects invalid canonical identifiers: %s', async (_description, source) => {
    await expectConfigError(toml(source), 'CONFIG_FIELD_INVALID')
  })

  it('normalizes a valid mixed-case EVM address', async () => {
    const source = validMember().replace('0x8004000000000000000000000000000000000003', '0x800400000000000000000000000000000000000A')
    await expect(loadTasConfig(toml(source), { TAS_RPC_URL: rpcSecret })).resolves.toMatchObject({
      instance: { tawgAddress: '0x800400000000000000000000000000000000000a' },
    })
  })

  it.each([
    ['both selectors', validMember().replace('rpc_url_env = "TAS_RPC_URL"', `rpc_url_env = "TAS_RPC_URL"\nrpc_url = "${rpcSecret}"`), 'CONFIG_CONFLICT'],
    ['neither selector', validMember().replace('rpc_url_env = "TAS_RPC_URL"', ''), 'CONFIG_CONFLICT'],
    ['invalid selector name', validMember().replace('TAS_RPC_URL', '1INVALID'), 'CONFIG_FIELD_INVALID'],
    ['missing environment value', validMember(), 'CONFIG_ENV_REQUIRED'],
    ['empty environment value', validMember(), 'CONFIG_ENV_REQUIRED'],
    ['URL credentials', validMember().replace('rpc_url_env = "TAS_RPC_URL"', `rpc_url = "${rpcSecret}"`), 'CONFIG_FIELD_INVALID'],
  ])('validates RPC selector configuration: %s', async (_description, source, code) => {
    const environment = _description === 'empty environment value' ? { TAS_RPC_URL: '' } : {}
    const error = await expectConfigError(toml(source), code as TasError['code'], environment)
    expect(serialized(error)).not.toContain(rpcSecret)
  })

  it('redacts unsafe environment URL credentials in validation errors', async () => {
    const unsafeEnvironmentUrl = 'ftp://rpc-user:rpc-password@rpc.example.test/secret-token'
    const error = await expectConfigError(fixture('member-valid.toml'), 'CONFIG_FIELD_INVALID', { TAS_RPC_URL: unsafeEnvironmentUrl })
    expect(serialized(error)).not.toContain(rpcSecret)
    expect(serialized(error)).not.toContain(unsafeEnvironmentUrl)
    expect(error.message).not.toContain('rpc-password')
  })

  it.each([
    ['duplicate source', validMember().replace('sources = [', 'sources = [\n  { name = "telegram-main", platform = "discord" },')],
    ['duplicate target name', validMember().replace('{ name = "alerts"', '{ name = "ops"')],
    ['duplicate target destination', validMember().replace('source = "discord-main", conversation_id = "alerts-channel"', 'source = "telegram-main", conversation_id = "-100123"')],
    ['dangling target source', validMember().replace('source = "discord-main"', 'source = "missing"')],
    ['source without target', validMember().replace('sources = [\n', 'sources = [\n  { name = "orphan", platform = "telegram" },\n')],
    ['target without sources', validMember().replace(/sources = \[[\s\S]*?\]\n+targets/, 'sources = []\ntargets')],
    ['poll interval too short', validMember().replace('poll_interval = "1000ms"', 'poll_interval = "999ms"')],
    ['poll interval too long', validMember().replace('poll_interval = "6s"', 'poll_interval = "61s"')],
  ])('rejects invalid chat references and polling: %s', async (_description, source) => {
    const referenceCases = ['dangling target source', 'source without target', 'target without sources']
    await expectConfigError(toml(source), referenceCases.includes(_description) ? 'CONFIG_REFERENCE_INVALID' : 'CONFIG_FIELD_INVALID')
  })

  it.each([
    ['repository client', validMember().replace('client = "github"', 'client = "gitlab"')],
    ['DA client', validMember().replace('client = "git"', 'client = "ipfs"')],
    ['provider type', validMember() + '\n[[proof_providers]]\nname = "unsupported"\ntype = "tee"\nintegration = "future"\nbase_url = "https://provider.example.test"\n'],
    ['provider integration', validMember() + '\n[[proof_providers]]\nname = "unshipped"\ntype = "attestation"\nintegration = "unshipped"\nbase_url = "https://provider.example.test"\n'],
  ])('rejects unsupported client declarations: %s', async (_description, source) => {
    await expectConfigError(toml(source), 'CONFIG_CLIENT_UNSUPPORTED')
  })
})
