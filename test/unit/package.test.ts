import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const packagePath = fileURLToPath(new URL('../../package.json', import.meta.url))
const cliSourcePath = fileURLToPath(new URL('../../src/app/main.ts', import.meta.url))
const pkg = JSON.parse(readFileSync(packagePath, 'utf8')) as Record<string, unknown>

describe('package contract', () => {
  it('publishes the required TAS package metadata and artifacts', () => {
    expect(pkg).toMatchObject({
      name: '@trustless-ai/tas',
      version: '0.1.0',
      type: 'module',
      bin: { tas: 'dist/app/main.js' },
      engines: { node: '>=24 <25' },
    })
    expect(pkg.files).toEqual(expect.arrayContaining([
      'dist',
      'skills/tas/SKILL.md',
      'skills/tawg-collaboration/SKILL.md',
      'docs/tas/CREDENTIALS.md',
    ]))
  })

  it('pins the runtime and development toolchain dependencies', () => {
    expect(pkg.dependencies).toEqual({
      '@modelcontextprotocol/core': '2.0.0',
      '@modelcontextprotocol/server': '2.0.0',
      '@octokit/request': '10.0.14',
      '@trustless-ai/agent-sdk': '0.3.0',
      'discord.js': '14.27.0',
      grammy: '1.45.1',
      pino: '10.3.1',
      'proper-lockfile': '4.1.2',
      'smol-toml': '1.8.0',
      solc: '0.8.30',
      viem: '2.55.19',
      zod: '4.4.3',
    })
    expect(pkg.overrides).toEqual({ tmp: '0.2.7' })
    expect(pkg.devDependencies).toEqual({
      '@types/node': '24.13.3',
      '@types/proper-lockfile': '4.1.4',
      '@vitest/coverage-v8': '4.1.11',
      canonicalize: '4.0.0',
      tsx: '4.23.12',
      typescript: '7.0.2',
      vitest: '4.1.11',
    })
  })

  it('provides the required build, validation, and startup scripts', () => {
    expect(pkg.scripts).toMatchObject({
      build: 'tsc -p tsconfig.json',
      typecheck: 'tsc --noEmit && tsc --noEmit -p tsconfig.tools.json',
      'manifest:generate': 'tsx tools/manifest/generate.ts',
      'manifest:check': 'tsx tools/manifest/generate.ts --check',
      test: 'vitest run',
      'test:coverage': 'vitest run --coverage',
      start: 'tsx src/app/main.ts',
      prepack: 'npm run build',
    })
  })

  it('marks the published CLI entrypoint for Node execution', () => {
    expect(readFileSync(cliSourcePath, 'utf8').startsWith('#!/usr/bin/env node\n')).toBe(true)
  })
})
