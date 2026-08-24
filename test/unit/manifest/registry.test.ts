import { describe, expect, it } from 'vitest'

import { getManifestRegistry } from '../../../src/mcp/manifest/registry.js'

describe('Manifest Registry', () => {
  it('returns each complete reviewed profile as one stable sorted group', () => {
    const registry = getManifestRegistry()
    const agentSdkTools = registry.list('agent-sdk')
    const publicTools = registry.list('viem-public')
    const walletTools = registry.list('viem-wallet')
    const telegramTools = registry.list('telegram')
    const discordTools = registry.list('discord')

    expect(agentSdkTools).toHaveLength(56)
    expect(publicTools).toHaveLength(27)
    expect(walletTools).toHaveLength(7)
    expect(telegramTools).toHaveLength(56)
    expect(discordTools).toHaveLength(4)
    expect(agentSdkTools.map(({ name }) => name)).toEqual(agentSdkTools.map(({ name }) => name).toSorted())
    expect(publicTools.map(({ name }) => name)).toEqual(publicTools.map(({ name }) => name).toSorted())
    expect(walletTools.map(({ name }) => name)).toEqual(walletTools.map(({ name }) => name).toSorted())
    expect(telegramTools.every(({ name }) => name.startsWith('chat.telegram.'))).toBe(true)
    expect(discordTools.every(({ name }) => name.startsWith('chat.discord.'))).toBe(true)
    expect(getManifestRegistry()).toBe(registry)
  })

  it('looks up one reviewed tool by its globally unique name', () => {
    const registry = getManifestRegistry()
    const expected = registry.list('viem-public').find(({ source }) => source.member === 'getBalance')

    expect(expected).toBeDefined()
    expect(registry.get(expected!.name)).toBe(expected)
    expect(registry.get('workflow.chain.public.not_reviewed')).toBeUndefined()
  })

  it('looks up an agent-sdk tool from the same globally unique namespace', () => {
    const registry = getManifestRegistry()
    const expected = registry.list('agent-sdk').find(({ name }) => name === 'workflow.verify.erc8274.get_trusted_verifier')

    expect(expected).toBeDefined()
    expect(registry.get(expected!.name)).toBe(expected)
  })

  it('deeply freezes entries and schemas exposed to callers', () => {
    const registry = getManifestRegistry()
    const tools = registry.list('viem-public')
    const entry = tools[0]!

    expect(Object.isFrozen(registry)).toBe(true)
    expect(Object.isFrozen(tools)).toBe(true)
    expect(Object.isFrozen(entry)).toBe(true)
    expect(Object.isFrozen(entry.source)).toBe(true)
    expect(Object.isFrozen(entry.runtime_dependencies)).toBe(true)
    expect(Object.isFrozen(entry.input_schema)).toBe(true)
    expect(() => (tools as unknown[]).pop()).toThrow()
    expect(() => {
      ;(entry.input_schema as Record<string, unknown>).type = 'changed'
    }).toThrow()
    expect(registry.get(entry.name)).toBe(entry)

    const agentSdkEntry = registry.list('agent-sdk')[0]!
    expect(Object.isFrozen(registry.list('agent-sdk'))).toBe(true)
    expect(Object.isFrozen(agentSdkEntry)).toBe(true)
    expect(Object.isFrozen(agentSdkEntry.binding)).toBe(true)
  })
})
