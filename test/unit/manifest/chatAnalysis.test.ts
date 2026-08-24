import { resolve } from 'node:path'

import { API, type Symbol as TypeScriptSymbol } from 'typescript/unstable/sync'
import { describe, expect, it } from 'vitest'

import { analyzeDiscord, canonicalDiscordMemberName } from '../../../tools/manifest/analyzeDiscord.js'
import { analyzeTelegram } from '../../../tools/manifest/analyzeTelegram.js'

function hasPropertyAtAnyDepth(value: unknown, propertyName: string): boolean {
  if (Array.isArray(value)) return value.some((entry) => hasPropertyAtAnyDepth(entry, propertyName))
  if (value === null || typeof value !== 'object') return false
  const record = value as Record<string, unknown>
  const properties = record.properties
  if (properties !== null && typeof properties === 'object' && !Array.isArray(properties)
    && Object.hasOwn(properties, propertyName)) return true
  return Object.values(record).some((entry) => hasPropertyAtAnyDepth(entry, propertyName))
}

function requiredProperties(schema: { readonly required?: unknown }): readonly string[] {
  return Array.isArray(schema.required) && schema.required.every((name) => typeof name === 'string')
    ? schema.required
    : []
}

function syntheticMemberNames(): readonly string[] {
  const cwd = process.cwd()
  const probePath = resolve(cwd, '.tas-discord-synthetic-member-probe.ts')
  const source = [
    'declare namespace A { const member: unique symbol }',
    'declare namespace B { const member: unique symbol }',
    'export interface TASPair {',
    '  [A.member](): void',
    '  [B.member](): void',
    "  '__@ordinary@42'(): void",
    '}',
  ].join('\n')
  const api = new API({
    cwd,
    fs: {
      readFile: (path) => path === probePath ? source : undefined,
      fileExists: (path) => path === probePath ? true : undefined,
      directoryExists: () => undefined,
      getAccessibleEntries: () => undefined,
      realpath: () => undefined,
    },
  })
  let snapshot: ReturnType<API['updateSnapshot']> | undefined
  try {
    snapshot = api.updateSnapshot({ openFiles: [probePath] })
    const project = snapshot.getDefaultProjectForFile(probePath)
    const sourceFile = project?.program.getSourceFile(probePath)
    if (project === undefined || sourceFile === undefined) throw new Error('synthetic member probe did not resolve')
    const diagnostics = project.program.getSemanticDiagnostics(probePath)
    if (diagnostics.length > 0) throw new Error(`synthetic member probe diagnostics: ${diagnostics.map(({ text }) => text).join('; ')}`)
    const pair = [...(project.checker.getSymbolAtLocation(sourceFile)?.getExports().values() ?? [])]
      .find((symbol) => symbol.name === 'TASPair')
    if (pair === undefined) throw new Error('synthetic member probe export did not resolve')
    return project.checker.getPropertiesOfType(project.checker.getDeclaredTypeOfSymbol(pair))
      .map((member) => canonicalDiscordMemberName(member, cwd))
  } finally {
    try {
      snapshot?.dispose()
    } finally {
      api.close()
    }
  }
}

describe('chat source profiles', () => {
  it('projects target-scoped grammY API calls without caller-controlled chat or abort fields', () => {
    const analysis = analyzeTelegram({ cwd: process.cwd() })
    const leaveChat = analysis.included.find(({ sourceName }) => sourceName === 'leaveChat')

    expect(analysis.packageVersion).toBe('1.45.1')
    expect(leaveChat).toMatchObject({
      toolName: 'chat.telegram.api.leave_chat',
      runtimeDependencies: ['chat_source', 'chat_target'],
      credential: 'telegram_bot_token',
    })
    expect(Object.keys(leaveChat?.projection.input_schema.properties ?? {})).toEqual(
      expect.arrayContaining(['credential', 'target']),
    )
    expect(leaveChat?.projection.input_schema.properties).not.toHaveProperty('chat_id')
    expect(leaveChat?.projection.input_schema.properties).not.toHaveProperty('signal')
  })

  it('reports every selected Telegram API member once, including callback and non-JSON exclusions', () => {
    const analysis = analyzeTelegram({ cwd: process.cwd() })
    const classified = [...analysis.included, ...analysis.excluded]
    const sourceNames = classified.map(({ sourceName }) => sourceName)

    expect(sourceNames).toHaveLength(new Set(sourceNames).size)
    expect(analysis.excluded.some(({ reasonCode }) => reasonCode === 'callback_input')).toBe(true)
    expect(analysis.excluded.some(({ reasonCode }) => reasonCode === 'non_json_input')).toBe(true)
    expect(analysis.excluded.some(({ reasonCode }) => reasonCode === 'not_target_scoped')).toBe(true)
  })

  it('projects context-bound Discord message manager operations and excludes streaming or non-JSON members', () => {
    const analysis = analyzeDiscord({ cwd: process.cwd() })
    const deleteMessage = analysis.included.find(({ sourceName }) => sourceName === 'delete')
    const classified = [...analysis.included, ...analysis.excluded]

    expect(analysis.packageVersion).toBe('14.27.0')
    expect(deleteMessage).toMatchObject({
      toolName: 'chat.discord.message_manager.delete',
      runtimeDependencies: ['chat_source', 'chat_target', 'chat_context'],
      credential: 'discord_bot_token',
    })
    expect(Object.keys(deleteMessage?.projection.input_schema.properties ?? {})).toEqual(
      expect.arrayContaining(['credential', 'target', 'message']),
    )
    expect(analysis.excluded.some(({ reasonCode }) => reasonCode === 'callback_input')).toBe(true)
    expect(analysis.excluded.some(({ reasonCode }) => reasonCode === 'non_json_output')).toBe(true)
    expect(classified.map(({ sourceName }) => sourceName)).toHaveLength(new Set(classified.map(({ sourceName }) => sourceName)).size)
  })

  it('canonicalizes TypeScript synthetic Discord member names without session-local symbol ids', () => {
    const analysis = analyzeDiscord({ cwd: process.cwd() })
    const sourceNames = [...analysis.included, ...analysis.excluded].map(({ sourceName }) => sourceName)

    expect(sourceNames.some((sourceName) => /^client\.__@asyncDispose\$[0-9a-f]{64}$/.test(sourceName))).toBe(true)
    expect(sourceNames.some((sourceName) => /^client\.__@captureRejectionSymbol\$[0-9a-f]{64}$/.test(sourceName))).toBe(true)
    expect(sourceNames.some((sourceName) => /__@[^.]*@\d+(?:\.|$)/.test(sourceName))).toBe(false)
  })

  it('gives distinct deterministic names to unique computed symbols and preserves a literal lookalike', () => {
    const first = syntheticMemberNames()
    const second = syntheticMemberNames()
    const computed = first.filter((name) => name.startsWith('__@member$'))

    expect(second).toEqual(first)
    expect(first).toContain('__@ordinary@42')
    expect(computed).toHaveLength(2)
    expect(new Set(computed)).toHaveLength(2)
    expect(computed.some((name) => /__@[^.]*@\d+(?:\.|$)/.test(name))).toBe(false)
  })

  it('fails closed when a genuine synthetic symbol has no deterministic declaration identity', () => {
    expect(() => canonicalDiscordMemberName({
      name: '__@orphan@42',
      escapedName: '__@orphan@42' as never,
      declarations: [],
    } as unknown as TypeScriptSymbol, process.cwd())).toThrow(/deterministic declaration identity/i)
  })

  it('records a schema projection failure instead of silently omitting an otherwise callable operation', () => {
    const analysis = analyzeTelegram({
      cwd: process.cwd(),
      project: ({ sourceName }) => {
        if (sourceName === 'leaveChat') throw new Error('injected projection failure')
      },
    })

    expect(analysis.excluded).toContainEqual(expect.objectContaining({
      sourceName: 'leaveChat',
      reasonCode: 'projection_failure',
    }))
  })

  it('rejects recursively caller-controlled Telegram chat identifiers that would override the injected target', () => {
    const analysis = analyzeTelegram({ cwd: process.cwd() })

    expect(analysis.excluded).toContainEqual(expect.objectContaining({
      sourceName: 'verifyChat',
      reasonCode: 'injected_target_collision',
    }))
    for (const action of analysis.included) {
      expect(hasPropertyAtAnyDepth(action.projection.input_schema, 'chat_id')).toBe(false)
    }
  })

  it('preserves optional SDK parameters as optional caller inputs', () => {
    const telegram = analyzeTelegram({ cwd: process.cwd() })
    const discord = analyzeDiscord({ cwd: process.cwd() })
    const approveSuggestedPost = telegram.included.find(({ sourceName }) => sourceName === 'approveSuggestedPost')
    const pin = discord.included.find(({ sourceName }) => sourceName === 'pin')

    expect(requiredProperties(approveSuggestedPost?.projection.input_schema ?? {})).not.toContain('other')
    expect(requiredProperties(pin?.projection.input_schema ?? {})).not.toContain('reason')
  })
})
