#!/usr/bin/env node

import { readFileSync, realpathSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

import { getManifestRegistry } from '../mcp/manifest/registry.js'
import type { TasApp } from './createTasApp.js'

const usage = 'Usage: tas --version | tas --config <path>\n'
const packagePath = new URL('../../package.json', import.meta.url)
const packageMetadata = JSON.parse(readFileSync(packagePath, 'utf8')) as { version: string }

interface TextOutput {
  write(message: string): unknown
}

interface ShutdownEventSource {
  on(event: string, listener: () => void): unknown
  off(event: string, listener: () => void): unknown
}

interface ShutdownInput extends ShutdownEventSource {
  readonly readableEnded: boolean
  readonly closed: boolean
}

export interface RunDependencies {
  /** Test-only preflight seam; production validates bundled Manifests here. */
  readonly preflight?: () => void
  /** Test-only application construction seam. */
  readonly createApp?: (configPath: string) => Promise<TasApp>
  /** Test-only stdin lifecycle seam. */
  readonly stdin?: ShutdownInput
  /** Test-only process-signal lifecycle seam. */
  readonly signals?: ShutdownEventSource
}

function isConfigPath(value: string | undefined): value is string {
  return value !== undefined && value !== '' && !value.startsWith('--')
}

async function startAndWaitForShutdown(
  configPath: string,
  stderr: TextOutput,
  dependencies: RunDependencies,
): Promise<number> {
  const stdin = dependencies.stdin ?? process.stdin
  const signals = dependencies.signals ?? process
  let app: TasApp | undefined
  let shutdownRequested = stdin.readableEnded || stdin.closed
  let stdioFailed = false
  let cleanupPromise: Promise<void> | undefined
  let resolveStatus!: (status: number) => void
  const status = new Promise<number>((resolve) => { resolveStatus = resolve })

  const removeGuards = (): void => {
    stdin.off('end', onShutdown)
    stdin.off('close', onShutdown)
    signals.off('SIGINT', onShutdown)
    signals.off('SIGTERM', onShutdown)
  }
  const cleanup = (reason: 'normal' | 'stdio_error' = 'normal'): void => {
    if (reason === 'stdio_error') stdioFailed = true
    shutdownRequested = true
    const ownedApp = app
    if (ownedApp === undefined || cleanupPromise !== undefined) return
    cleanupPromise = (async () => {
      try {
        await ownedApp.close()
      } catch {
        if (!stdioFailed) {
          stderr.write('TAS_SHUTDOWN_FAILED\n')
          resolveStatus(1)
          return
        }
      } finally {
        removeGuards()
      }
      if (stdioFailed) {
        stderr.write('TAS_STDIO_FAILED\n')
        resolveStatus(1)
      } else {
        resolveStatus(0)
      }
    })()
  }
  const onShutdown = (): void => { cleanup() }

  stdin.on('end', onShutdown)
  stdin.on('close', onShutdown)
  signals.on('SIGINT', onShutdown)
  signals.on('SIGTERM', onShutdown)
  if (stdin.readableEnded || stdin.closed) cleanup()

  try {
    ;(dependencies.preflight ?? getManifestRegistry)()
    const createApp = dependencies.createApp
      ?? (await import('./createTasApp.js')).createTasApp
    app = await createApp(configPath)
  } catch {
    removeGuards()
    stderr.write('TAS_STARTUP_FAILED\n')
    return 1
  }
  void app.terminal.then(
    () => cleanup('stdio_error'),
    () => cleanup('stdio_error'),
  )
  if (shutdownRequested) cleanup()
  return await status
}

export async function run(
  args: readonly string[],
  stdout: TextOutput,
  stderr: TextOutput,
  dependencies: RunDependencies = {},
): Promise<number> {
  if (args.length === 1 && args[0] === '--version') {
    stdout.write(`${packageMetadata.version}\n`)
    return 0
  }

  if (args.length === 2 && args[0] === '--config' && isConfigPath(args[1])) {
    return await startAndWaitForShutdown(args[1], stderr, dependencies)
  }

  stderr.write(usage)
  return 2
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  process.exitCode = await run(process.argv.slice(2), process.stdout, process.stderr)
}
