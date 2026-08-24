import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import { describe, expect, it } from 'vitest'

import { analyzeDiscord } from '../../tools/manifest/analyzeDiscord.js'
import { analyzeTelegram } from '../../tools/manifest/analyzeTelegram.js'
import {
  chatArtifactDigestSourceRelativePath,
  chatManifestFileNames,
  generateChatArtifactDigestSource,
  generateChatManifestArtifacts,
} from '../../tools/manifest/generate.js'

const repositoryRoot = resolve(import.meta.dirname, '../..')

describe('reviewed chat Manifest generation', () => {
  it('compiles the raw-byte digest of every Chat Manifest and report', () => {
    const artifacts = generateChatManifestArtifacts({ cwd: repositoryRoot })
    const source = generateChatArtifactDigestSource(artifacts)

    expect(readFileSync(join(repositoryRoot, chatArtifactDigestSourceRelativePath), 'utf8')).toBe(source)
    for (const fileName of chatManifestFileNames) {
      const digest = `sha256:${createHash('sha256').update(artifacts[fileName], 'utf8').digest('hex')}`
      expect(source).toContain(`'${fileName}': '${digest}'`)
    }
  })

  it('generates byte-identical Telegram and Discord manifests with complete source accounting', () => {
    const first = generateChatManifestArtifacts({ cwd: process.cwd() })
    const second = generateChatManifestArtifacts({ cwd: process.cwd() })
    const telegramAnalysis = analyzeTelegram({ cwd: process.cwd() })
    const discordAnalysis = analyzeDiscord({ cwd: process.cwd() })

    expect(Object.keys(first).toSorted()).toEqual([...chatManifestFileNames].toSorted())
    expect(second).toEqual(first)
    for (const fileName of chatManifestFileNames) {
      expect(first[fileName].endsWith('\n')).toBe(false)
      expect(JSON.stringify(JSON.parse(first[fileName]))).toBe(first[fileName])
    }

    const telegram = JSON.parse(first['telegram.v1.json']) as Record<string, unknown>
    const discord = JSON.parse(first['discord.v1.json']) as Record<string, unknown>
    const telegramReport = JSON.parse(first['telegram-report.v1.json']) as { readonly entries: readonly Record<string, unknown>[] }
    const discordReport = JSON.parse(first['discord-report.v1.json']) as { readonly entries: readonly Record<string, unknown>[] }
    expect(telegram).toMatchObject({
      manifest_id: 'telegram',
      source_profile: 'telegram',
      source: { package: 'grammy', version: '1.45.1', package_integrity: telegramAnalysis.packageIntegrity },
    })
    expect(discord).toMatchObject({
      manifest_id: 'discord',
      source_profile: 'discord',
      source: { package: 'discord.js', version: '14.27.0', package_integrity: discordAnalysis.packageIntegrity },
    })

    const telegramTools = (telegram.tools as readonly Record<string, unknown>[])
    const discordTools = (discord.tools as readonly Record<string, unknown>[])
    expect(telegramTools).not.toHaveLength(0)
    expect(discordTools).not.toHaveLength(0)
    expect(telegramTools.every(({ name }) => typeof name === 'string' && name.startsWith('chat.telegram.'))).toBe(true)
    expect(discordTools.every(({ name }) => typeof name === 'string' && name.startsWith('chat.discord.'))).toBe(true)
    expect([...telegramTools, ...discordTools].every(({ credential }) => /(?:telegram|discord)_bot_token/.test(String(credential)))).toBe(true)
    expect([...telegramTools, ...discordTools].every(({ binding }) => (binding as { kind?: string }).kind === 'chat_operation')).toBe(true)

    for (const [report, analysis] of [[telegramReport, telegramAnalysis], [discordReport, discordAnalysis]] as const) {
      const reportNames = report.entries.map(({ source_name }) => source_name)
      const analysisNames = [...analysis.included, ...analysis.excluded].map(({ sourceName }) => sourceName).toSorted()
      expect(reportNames).toEqual(analysisNames)
      expect(new Set(reportNames)).toHaveLength(reportNames.length)
    }
  })

  it('generates an identical Discord report in fresh processes regardless of prior analyzer sessions', { timeout: 30_000 }, () => {
    const analyzerUrl = pathToFileURL(join(process.cwd(), 'tools', 'manifest', 'analyzeDiscord.ts')).href
    const generatorUrl = pathToFileURL(join(process.cwd(), 'tools', 'manifest', 'generate.ts')).href
    const deadline = Date.now() + 25_000
    const generate = (warm: boolean) => {
      const script = [
        `import { analyzeDiscord } from ${JSON.stringify(analyzerUrl)}`,
        `import { generateChatManifestArtifacts } from ${JSON.stringify(generatorUrl)}`,
        warm ? 'analyzeDiscord({ cwd: process.cwd() })' : '',
        "process.stdout.write(generateChatManifestArtifacts({ cwd: process.cwd() })['discord-report.v1.json'])",
      ].join('\n')
      const child = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', script], {
        cwd: process.cwd(),
        encoding: 'utf8',
        timeout: Math.max(1, deadline - Date.now()),
      })
      expect(child.status, child.stderr).toBe(0)
      return child.stdout
    }

    const cold = generate(false)
    const warmed = generate(true)
    expect(warmed).toBe(cold)
    expect(cold).not.toMatch(/__@[^".]*@\d+(?:[".]|$)/)
  })
})
