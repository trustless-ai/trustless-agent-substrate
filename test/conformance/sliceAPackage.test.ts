import { execFileSync } from 'node:child_process'
import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

const root = fileURLToPath(new URL('../../', import.meta.url))
const sensitiveEndpoint = /https?:\/\/[^\s/]+(?::[^\s/@]+)?@|[?&](?:token|key|secret|auth|api_key|apikey|access_token|password)=/i
const assignedPrivateKey = /(?:private(?:key|[_ .-]key)|secret)["']?\s*[:=]\s*["']?0x[0-9a-f]{64}\b/i

function checkedText(path: string): string {
  const text = readFileSync(path, 'utf8')
  expect(text, `${path} contains a fixture credential`).not.toMatch(assignedPrivateKey)
  expect(text, `${path} contains an authenticated endpoint`).not.toMatch(sensitiveEndpoint)
  return text
}

describe('Slice A package gate', () => {
  it('ships current Manifests and excludes deterministic chain fixtures from the npm package', () => {
    expect(() => execFileSync('npm', ['run', 'manifest:check'], { cwd: root, encoding: 'utf8', timeout: 120_000 })).not.toThrow()
    for (const name of ['identityRegistry.ts', 'tawgProfile.ts', 'README.md', 'source/Fixtures.sol']) {
      checkedText(`${root}/test/fixtures/contracts/${name}`)
    }

    const packed = JSON.parse(execFileSync('npm', ['pack', '--dry-run', '--json'], {
      cwd: root, encoding: 'utf8', timeout: 120_000,
    })) as readonly { readonly files: readonly { readonly path: string }[] }[]
    const paths = packed[0]?.files.map(({ path }) => path) ?? []
    expect(paths).toEqual(expect.arrayContaining([
      'dist/core/skill/collaborationSkill.js',
      'dist/core/skill/loader.js',
      'dist/core/skill/tasSkill.js',
      'dist/mcp/skillTools.js',
      'skills/tas/SKILL.md',
      'skills/tawg-collaboration/SKILL.md',
    ]))
    expect(paths.some((path) => path.startsWith('skills/tas-bootstrap/') || path.startsWith('tawg/'))).toBe(false)
    expect(paths.some((path) => path.startsWith('test/fixtures/contracts/'))).toBe(false)
    expect(paths.some((path) => path.endsWith('.sol') || path.endsWith('/README.md'))).toBe(false)
    expect(paths.filter((path) => path.startsWith('manifests/')).sort()).toEqual([
      'manifests/agent-sdk-report.v1.json', 'manifests/agent-sdk.v1.json',
      'manifests/discord-report.v1.json', 'manifests/discord.v1.json',
      'manifests/telegram-report.v1.json', 'manifests/telegram.v1.json',
      'manifests/viem-public.v1.json', 'manifests/viem-report.v1.json', 'manifests/viem-wallet.v1.json',
    ])

    for (const name of readdirSync(`${root}/dist`, { recursive: true, encoding: 'utf8' })) {
      if (typeof name !== 'string' || !name.endsWith('.js')) continue
      checkedText(`${root}/dist/${name}`)
    }
  }, 120_000)
})
