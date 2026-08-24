import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'

import { describe, expect, it, vi } from 'vitest'

import {
  createSolcCompiler,
  type SolcProcess,
  type SolcProcessFactory,
  type SolcProcessInput,
  type SolcProcessOutput,
} from '../../../src/clients/workflow/solcCompiler.js'
import { TasError } from '../../../src/core/errors.js'

const exactVersion = '0.8.30+commit.73712a01'

function standardInput(source = 'pragma solidity 0.8.30; contract Fixture { function value() external pure returns (uint256) { return 7; } }') {
  return {
    language: 'Solidity',
    sources: { 'contracts/Fixture.sol': { content: source } },
    settings: {
      outputSelection: {
        '*': { '*': ['metadata', 'evm.deployedBytecode.object'] },
      },
    },
  }
}

class ControlledInput implements SolcProcessInput {
  readonly writes: string[] = []
  private errorListener: ((error: Error) => void) | undefined

  once(_event: 'error', listener: (error: Error) => void): this {
    this.errorListener = listener
    return this
  }

  end(value: string, _encoding: BufferEncoding): void {
    this.writes.push(value)
  }

  fail(): void {
    this.errorListener?.(new Error('stdin failed'))
  }
}

class ControlledOutput implements SolcProcessOutput {
  private dataListener: ((value: Buffer | string) => void) | undefined
  private errorListener: ((error: Error) => void) | undefined

  on(_event: 'data', listener: (value: Buffer | string) => void): this {
    this.dataListener = listener
    return this
  }

  once(_event: 'error', listener: (error: Error) => void): this {
    this.errorListener = listener
    return this
  }

  emit(value: Buffer | string): void {
    this.dataListener?.(value)
  }

  fail(): void {
    this.errorListener?.(new Error('stream failed'))
  }
}

class ControlledProcess implements SolcProcess {
  readonly stdin = new ControlledInput()
  readonly stdout = new ControlledOutput()
  readonly stderr = new ControlledOutput()
  readonly killSignals: NodeJS.Signals[] = []
  private errorListener: ((error: Error) => void) | undefined
  private closeListener: ((code: number | null, signal: NodeJS.Signals | null) => void) | undefined

  once(event: 'error', listener: (error: Error) => void): this
  once(event: 'close', listener: (code: number | null, signal: NodeJS.Signals | null) => void): this
  once(
    event: 'error' | 'close',
    listener: ((error: Error) => void) | ((code: number | null, signal: NodeJS.Signals | null) => void),
  ): this {
    if (event === 'error') this.errorListener = listener as (error: Error) => void
    else this.closeListener = listener as (code: number | null, signal: NodeJS.Signals | null) => void
    return this
  }

  kill(signal: NodeJS.Signals): boolean {
    this.killSignals.push(signal)
    return true
  }

  succeed(outputText = '{}'): void {
    this.stdout.emit(`OK\n${outputText}`)
    this.close(0, null)
  }

  crash(): void {
    this.close(1, null)
  }

  close(code: number | null, signal: NodeJS.Signals | null): void {
    const listener = this.closeListener
    this.closeListener = undefined
    listener?.(code, signal)
  }

  failToSpawn(): void {
    this.errorListener?.(new Error('process failed to spawn'))
  }
}

function controlledProcesses(options: { readonly throwOnCreate?: boolean } = {}) {
  const processes: ControlledProcess[] = []
  const processFactory: SolcProcessFactory = () => {
    if (options.throwOnCreate) throw new Error('process construction failed')
    const child = new ControlledProcess()
    processes.push(child)
    return child
  }
  return { processFactory, processes }
}

describe('isolated Solidity compiler', () => {
  it('starts a heap-constrained child with a minimal environment and sends Standard JSON on stdin', async () => {
    const calls: Parameters<SolcProcessFactory>[] = []
    const child = new ControlledProcess()
    const processFactory: SolcProcessFactory = (...arguments_) => {
      calls.push(arguments_)
      return child
    }
    const compiler = createSolcCompiler({ timeoutMs: 20_000, processFactory })
    const input = standardInput()

    const operation = compiler.compile(input, exactVersion)

    expect(calls).toHaveLength(1)
    expect(calls[0]?.[0]).toBe(process.execPath)
    expect(calls[0]?.[1].slice(0, 3)).toEqual([
      '--max-old-space-size=256',
      '--max-semi-space-size=16',
      '-e',
    ])
    expect(calls[0]?.[2]).toMatchObject({
      shell: false,
      env: {},
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    expect(child.stdin.writes).toEqual([JSON.stringify(input)])
    child.succeed()
    await operation
  })

  it('compiles a bounded Standard JSON request only with the exact installed long version', async () => {
    const compiler = createSolcCompiler({ timeoutMs: 20_000 })

    const result = await compiler.compile(standardInput(), exactVersion)

    expect(result.compilerVersion).toBe(exactVersion)
    expect(result.output.contracts?.['contracts/Fixture.sol']?.Fixture?.evm?.deployedBytecode?.object)
      .toMatch(/^[0-9a-f]+$/)
  })

  it('rejects a semver-only or otherwise different compiler identity', async () => {
    const compiler = createSolcCompiler({ timeoutMs: 20_000 })

    await expect(compiler.compile(standardInput(), '0.8.30')).rejects.toBeInstanceOf(TasError)
  })

  it('reports compiler diagnostics with severity error as a typed failure', async () => {
    const compiler = createSolcCompiler({ timeoutMs: 20_000 })

    await expect(compiler.compile(
      standardInput('pragma solidity 0.8.30; import "./Missing.sol"; contract Fixture {}'),
      exactVersion,
    )).rejects.toBeInstanceOf(TasError)
  })

  it('force-kills a timed-out child and waits for close before rejecting or starting queued work', async () => {
    vi.useFakeTimers()
    try {
      const controlled = controlledProcesses()
      const compiler = createSolcCompiler({ timeoutMs: 10, processFactory: controlled.processFactory })
      const first = compiler.compile(standardInput(), exactVersion)
      const firstRejection = expect(first).rejects.toMatchObject({
        name: 'TasError',
        code: 'WORKFLOW_COMPILE_FAILED',
      })
      const second = compiler.compile(standardInput(), exactVersion)
      let firstSettled = false
      void first.then(
        () => { firstSettled = true },
        () => { firstSettled = true },
      )

      await vi.advanceTimersByTimeAsync(10)

      expect(controlled.processes[0]!.killSignals).toEqual(['SIGKILL'])
      expect(firstSettled).toBe(false)
      expect(controlled.processes).toHaveLength(1)

      controlled.processes[0]!.close(null, 'SIGKILL')
      await firstRejection
      await vi.advanceTimersByTimeAsync(0)
      expect(controlled.processes).toHaveLength(2)
      controlled.processes[1]!.succeed()
      await second
    } finally {
      vi.useRealTimers()
    }
  })

  it('resolves the bundled compiler independently of the process working directory', async () => {
    const originalDirectory = process.cwd()
    const unrelatedDirectory = mkdtempSync(resolve(tmpdir(), 'tas-solc-cwd-'))
    try {
      process.chdir(unrelatedDirectory)
      const compiler = createSolcCompiler({ timeoutMs: 20_000 })

      await expect(compiler.compile(standardInput(), exactVersion)).resolves.toMatchObject({
        compilerVersion: exactVersion,
      })
    } finally {
      process.chdir(originalDirectory)
      rmSync(unrelatedDirectory, { recursive: true, force: true })
    }
  })

  it('rejects an input above the byte bound before starting compilation', async () => {
    const compiler = createSolcCompiler({ timeoutMs: 20_000, maxInputBytes: 64 })

    await expect(compiler.compile(standardInput(), exactVersion)).rejects.toBeInstanceOf(TasError)
  })

  it('rejects compiler output above the response byte bound', async () => {
    const compiler = createSolcCompiler({ timeoutMs: 20_000, maxOutputBytes: 64 })

    await expect(compiler.compile(standardInput(), exactVersion)).rejects.toMatchObject({
      name: 'TasError',
      code: 'WORKFLOW_COMPILE_FAILED',
    })
  })

  it('force-kills a child as soon as streamed stdout exceeds the bound and waits for close', async () => {
    const controlled = controlledProcesses()
    const compiler = createSolcCompiler({
      timeoutMs: 20_000,
      maxOutputBytes: 64,
      processFactory: controlled.processFactory,
    })
    const operation = compiler.compile(standardInput(), exactVersion)
    const rejection = expect(operation).rejects.toMatchObject({
      name: 'TasError',
      code: 'WORKFLOW_COMPILE_FAILED',
    })
    let settled = false
    void operation.then(
      () => { settled = true },
      () => { settled = true },
    )

    controlled.processes[0]!.stdout.emit(`OK\n${'x'.repeat(65)}`)
    await Promise.resolve()

    expect(controlled.processes[0]!.killSignals).toEqual(['SIGKILL'])
    expect(settled).toBe(false)
    controlled.processes[0]!.close(null, 'SIGKILL')
    await rejection
  })

  it('runs at most one child and admits at most one waiting compilation', async () => {
    const controlled = controlledProcesses()
    const compiler = createSolcCompiler({ timeoutMs: 20_000, processFactory: controlled.processFactory })

    const first = compiler.compile(standardInput(), exactVersion)
    const second = compiler.compile(standardInput(), exactVersion)
    const overflow = compiler.compile(standardInput(), exactVersion)

    expect(controlled.processes).toHaveLength(1)
    await expect(overflow).rejects.toMatchObject({ name: 'TasError', code: 'WORKFLOW_COMPILER_BUSY' })
    expect(controlled.processes).toHaveLength(1)

    controlled.processes[0]!.succeed()
    await first
    await vi.waitFor(() => expect(controlled.processes).toHaveLength(2))
    controlled.processes[1]!.succeed()
    await second
  })

  it('cancels a waiting compilation without starting its child', async () => {
    const controlled = controlledProcesses()
    const compiler = createSolcCompiler({ timeoutMs: 20_000, processFactory: controlled.processFactory })
    const waitingCancellation = new AbortController()

    const active = compiler.compile(standardInput(), exactVersion)
    const waiting = compiler.compile(standardInput(), exactVersion, waitingCancellation.signal)
    waitingCancellation.abort()

    await expect(waiting).rejects.toMatchObject({ name: 'AbortError' })
    expect(controlled.processes).toHaveLength(1)
    controlled.processes[0]!.succeed()
    await active
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 0))
    expect(controlled.processes).toHaveLength(1)
  })

  it('force-kills a cancelled child and waits for close before settling', async () => {
    const controlled = controlledProcesses()
    const compiler = createSolcCompiler({ timeoutMs: 20_000, processFactory: controlled.processFactory })
    const cancellation = new AbortController()

    const operation = compiler.compile(standardInput(), exactVersion, cancellation.signal)
    const rejection = expect(operation).rejects.toMatchObject({ name: 'AbortError' })
    let settled = false
    void operation.then(
      () => { settled = true },
      () => { settled = true },
    )
    cancellation.abort()

    await Promise.resolve()
    expect(settled).toBe(false)
    expect(controlled.processes[0]!.killSignals).toEqual(['SIGKILL'])
    controlled.processes[0]!.close(null, 'SIGKILL')
    await rejection
  })

  it('maps synchronous process construction failures to a typed compiler error', async () => {
    const controlled = controlledProcesses({ throwOnCreate: true })
    const compiler = createSolcCompiler({ timeoutMs: 20_000, processFactory: controlled.processFactory })

    await expect(compiler.compile(standardInput(), exactVersion)).rejects.toMatchObject({
      name: 'TasError',
      code: 'WORKFLOW_COMPILER_UNAVAILABLE',
    })
  })

  it('maps a child crash to a redacted failure and starts the queued compilation after close', async () => {
    const controlled = controlledProcesses()
    const compiler = createSolcCompiler({ timeoutMs: 20_000, processFactory: controlled.processFactory })

    const operation = compiler.compile(standardInput(), exactVersion)
    const queued = compiler.compile(standardInput(), exactVersion)
    controlled.processes[0]!.stderr.emit('secret compiler crash details')
    controlled.processes[0]!.crash()

    const error = await operation.catch((reason: unknown) => reason)
    expect(error).toMatchObject({
      name: 'TasError',
      code: 'WORKFLOW_COMPILE_FAILED',
    })
    expect(String(error)).not.toContain('secret compiler crash details')
    await vi.waitFor(() => expect(controlled.processes).toHaveLength(2))
    controlled.processes[1]!.succeed()
    await expect(queued).resolves.toMatchObject({ compilerVersion: exactVersion })
  })
})
