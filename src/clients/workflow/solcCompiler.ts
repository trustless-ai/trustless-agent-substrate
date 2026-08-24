import { Buffer } from 'node:buffer'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'

import { TasError } from '../../core/errors.js'

export interface SolidityStandardJsonInput {
  readonly language: string
  readonly sources: Readonly<Record<string, { readonly content: string }>>
  readonly settings: Readonly<Record<string, unknown>>
}

export interface SolidityCompilerOutput {
  readonly contracts?: Readonly<Record<string, Readonly<Record<string, SolidityContractOutput>>>>
  readonly errors?: readonly {
    readonly severity?: string
    readonly formattedMessage?: string
    readonly message?: string
  }[]
}

export interface SolidityContractOutput {
  readonly metadata?: string
  readonly evm?: {
    readonly deployedBytecode?: {
      readonly object?: string
      readonly linkReferences?: unknown
      readonly immutableReferences?: unknown
    }
  }
}

export interface SolidityCompilation {
  readonly compilerVersion: string
  readonly output: SolidityCompilerOutput
}

export interface SolidityCompiler {
  compile(
    input: SolidityStandardJsonInput,
    expectedVersion: string,
    signal?: AbortSignal,
  ): Promise<SolidityCompilation>
}

export interface SolcProcessInput {
  once(event: 'error', listener: (error: Error) => void): this
  end(value: string, encoding: BufferEncoding): void
}

export interface SolcProcessOutput {
  on(event: 'data', listener: (value: Buffer | string) => void): this
  once(event: 'error', listener: (error: Error) => void): this
}

export interface SolcProcess {
  readonly stdin: SolcProcessInput
  readonly stdout: SolcProcessOutput
  readonly stderr: SolcProcessOutput
  once(event: 'error', listener: (error: Error) => void): this
  once(event: 'close', listener: (code: number | null, signal: NodeJS.Signals | null) => void): this
  kill(signal: NodeJS.Signals): boolean
}

export interface SolcProcessOptions {
  readonly shell: false
  readonly windowsHide: true
  readonly env: Readonly<Record<string, string>>
  readonly stdio: readonly ['pipe', 'pipe', 'pipe']
}

export type SolcProcessFactory = (
  executable: string,
  arguments_: readonly string[],
  options: SolcProcessOptions,
) => SolcProcess

export interface SolcCompilerOptions {
  readonly timeoutMs?: number
  readonly maxInputBytes?: number
  readonly maxOutputBytes?: number
  readonly processFactory?: SolcProcessFactory
}

interface ProcessSuccess {
  readonly ok: true
  readonly compilerVersion: string
  readonly outputText: string
}

const defaultTimeoutMs = 30_000
const defaultMaxInputBytes = 4 * 1_024 * 1_024
const defaultMaxOutputBytes = 16 * 1_024 * 1_024
const maxStderrBytes = 64 * 1_024
const bundledSolcPath = createRequire(import.meta.url).resolve('solc')

const childSource = String.raw`
'use strict'
const [solcPath, expectedVersion, maxInputText, maxOutputText] = process.argv.slice(1)
const maxInputBytes = Number(maxInputText)
const maxOutputBytes = Number(maxOutputText)
const chunks = []
let inputBytes = 0
let inputTooLarge = false

process.stdin.on('data', (chunk) => {
  inputBytes += chunk.length
  if (inputBytes > maxInputBytes) {
    inputTooLarge = true
    chunks.length = 0
  } else if (!inputTooLarge) {
    chunks.push(chunk)
  }
})

process.stdin.on('end', () => {
  if (inputTooLarge) {
    process.stdout.write('ERR INPUT_TOO_LARGE\n')
    return
  }
  let solc
  try {
    solc = require(solcPath)
  } catch {}
  if (solc === undefined) {
    process.stdout.write('ERR VERSION\n')
    return
  }
  try {
    const installedVersion = solc.version()
    if (installedVersion !== expectedVersion + '.Emscripten.clang') {
      process.stdout.write('ERR VERSION\n')
      return
    }
    // Supplying no import callback is deliberate: every source unit must be
    // present in the bounded Standard JSON request.
    const outputText = solc.compile(Buffer.concat(chunks).toString('utf8'))
    if (typeof outputText !== 'string' || Buffer.byteLength(outputText, 'utf8') > maxOutputBytes) {
      process.stdout.write('ERR OUTPUT_TOO_LARGE\n')
      return
    }
    process.stdout.write('OK\n')
    process.stdout.write(outputText)
  } catch {
    process.stdout.write('ERR COMPILE\n')
  }
})
`

function compilerUnavailable(): TasError {
  return new TasError(
    'WORKFLOW_COMPILER_UNAVAILABLE',
    'The exact Workflow Solidity compiler is unavailable.',
  )
}

function compileFailed(): TasError {
  return new TasError(
    'WORKFLOW_COMPILE_FAILED',
    'The Workflow Solidity compilation failed.',
  )
}

function compilerBusy(): TasError {
  return new TasError(
    'WORKFLOW_COMPILER_BUSY',
    'The Workflow compiler is busy with another verification.',
  )
}

function aborted(): Error {
  const error = new Error('The Workflow compilation request was aborted.')
  error.name = 'AbortError'
  return error
}

function positiveInteger(value: number | undefined, fallback: number): number {
  const normalized = value ?? fallback
  if (!Number.isSafeInteger(normalized) || normalized <= 0) throw new RangeError('Compiler bounds must be positive safe integers.')
  return normalized
}

function parseOutput(text: string): SolidityCompilerOutput {
  let output: unknown
  try {
    output = JSON.parse(text)
  } catch {
    throw compileFailed()
  }
  if (output === null || typeof output !== 'object' || Array.isArray(output)) throw compileFailed()
  const result = output as SolidityCompilerOutput
  if (result.errors !== undefined && !Array.isArray(result.errors)) throw compileFailed()
  if (result.errors?.some((diagnostic) => diagnostic?.severity === 'error')) throw compileFailed()
  return result
}

function runProcess(
  inputText: string,
  expectedVersion: string,
  timeoutMs: number,
  maxInputBytes: number,
  maxOutputBytes: number,
  processFactory: SolcProcessFactory,
  signal?: AbortSignal,
): Promise<ProcessSuccess> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(aborted())
      return
    }
    let child: SolcProcess
    try {
      child = processFactory(process.execPath, [
        '--max-old-space-size=256',
        '--max-semi-space-size=16',
        '-e',
        childSource,
        bundledSolcPath,
        expectedVersion,
        String(maxInputBytes),
        String(maxOutputBytes),
      ], {
        shell: false,
        windowsHide: true,
        env: {},
        stdio: ['pipe', 'pipe', 'pipe'],
      })
    } catch {
      reject(compilerUnavailable())
      return
    }

    const stdoutChunks: Buffer[] = []
    let stdoutPrefix = Buffer.alloc(0)
    let stdoutBytes = 0
    let stderrBytes = 0
    let terminalError: Error | undefined
    let killRequested = false
    let closed = false

    const force = (error: Error): void => {
      terminalError ??= error
      if (killRequested || closed) return
      killRequested = true
      stdoutChunks.length = 0
      try { child.kill('SIGKILL') } catch { /* close remains the serialization boundary */ }
    }

    const onAbort = (): void => force(aborted())
    const timer = setTimeout(() => force(compileFailed()), timeoutMs)
    timer.unref()
    signal?.addEventListener('abort', onAbort, { once: true })

    child.stdout.on('data', (value) => {
      if (terminalError !== undefined) return
      const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value, 'utf8')
      if (chunk.byteLength > Number.MAX_SAFE_INTEGER - stdoutBytes) {
        force(compileFailed())
        return
      }
      const nextBytes = stdoutBytes + chunk.byteLength
      if (stdoutPrefix.byteLength < 3) {
        stdoutPrefix = Buffer.concat([
          stdoutPrefix,
          chunk.subarray(0, 3 - stdoutPrefix.byteLength),
        ])
      }
      const stdoutLimit = stdoutPrefix.byteLength < 3 || stdoutPrefix.toString('utf8') === 'OK\n'
        ? Math.min(Number.MAX_SAFE_INTEGER, maxOutputBytes + 3)
        : 32
      if (nextBytes > stdoutLimit) {
        force(compileFailed())
        return
      }
      stdoutBytes = nextBytes
      stdoutChunks.push(chunk)
    })
    child.stderr.on('data', (value) => {
      if (terminalError !== undefined) return
      const chunkBytes = Buffer.isBuffer(value) ? value.byteLength : Buffer.byteLength(value, 'utf8')
      if (chunkBytes > maxStderrBytes - stderrBytes) {
        force(compileFailed())
        return
      }
      stderrBytes += chunkBytes
    })
    child.stdout.once('error', () => force(compileFailed()))
    child.stderr.once('error', () => force(compileFailed()))
    child.stdin.once('error', () => force(compileFailed()))
    child.once('error', () => force(compilerUnavailable()))
    child.once('close', (code) => {
      if (closed) return
      closed = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      if (terminalError !== undefined) {
        reject(terminalError)
        return
      }
      if (code !== 0) {
        reject(compileFailed())
        return
      }
      const response = Buffer.concat(stdoutChunks, stdoutBytes).toString('utf8')
      if (response === 'ERR VERSION\n') {
        reject(compilerUnavailable())
        return
      }
      if (!response.startsWith('OK\n')) {
        reject(compileFailed())
        return
      }
      const outputText = response.slice(3)
      if (Buffer.byteLength(outputText, 'utf8') > maxOutputBytes) {
        reject(compileFailed())
        return
      }
      resolve({
        ok: true,
        compilerVersion: expectedVersion,
        outputText,
      })
    })

    if (signal?.aborted) {
      onAbort()
      return
    }
    try {
      child.stdin.end(inputText, 'utf8')
    } catch {
      force(compileFailed())
    }
  })
}

export function createSolcCompiler(options: SolcCompilerOptions = {}): SolidityCompiler {
  const timeoutMs = positiveInteger(options.timeoutMs, defaultTimeoutMs)
  const maxInputBytes = positiveInteger(options.maxInputBytes, defaultMaxInputBytes)
  const maxOutputBytes = positiveInteger(options.maxOutputBytes, defaultMaxOutputBytes)
  const processFactory = options.processFactory ?? ((executable, arguments_, processOptions) => (
    spawn(executable, [...arguments_], {
      shell: processOptions.shell,
      windowsHide: processOptions.windowsHide,
      env: { ...processOptions.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
  ))
  let active = false
  let waiting: CompilationJob | undefined

  interface CompilationJob {
    readonly inputText: string
    readonly expectedVersion: string
    readonly signal?: AbortSignal
    readonly resolve: (value: SolidityCompilation) => void
    readonly reject: (error: unknown) => void
    waitingAbort?: () => void
  }

  function start(job: CompilationJob): void {
    job.signal?.removeEventListener('abort', job.waitingAbort ?? (() => undefined))
    job.waitingAbort = undefined
    if (job.signal?.aborted) {
      job.reject(aborted())
      startNext()
      return
    }
    active = true
    void runProcess(
      job.inputText,
      job.expectedVersion,
      timeoutMs,
      maxInputBytes,
      maxOutputBytes,
      processFactory,
      job.signal,
    ).then((response) => ({
      compilerVersion: response.compilerVersion,
      output: parseOutput(response.outputText),
    })).then(job.resolve, job.reject).finally(() => {
      active = false
      startNext()
    })
  }

  function startNext(): void {
    if (active) return
    const next = waiting
    waiting = undefined
    if (next !== undefined) start(next)
  }

  function schedule(job: CompilationJob): void {
    if (job.signal?.aborted) {
      job.reject(aborted())
      return
    }
    if (!active) {
      start(job)
      return
    }
    if (waiting !== undefined) {
      job.reject(compilerBusy())
      return
    }
    waiting = job
    const onAbort = (): void => {
      if (waiting !== job) return
      waiting = undefined
      job.signal?.removeEventListener('abort', onAbort)
      job.reject(aborted())
    }
    job.waitingAbort = onAbort
    job.signal?.addEventListener('abort', onAbort, { once: true })
    if (job.signal?.aborted) onAbort()
  }

  return Object.freeze({
    compile(
      input: SolidityStandardJsonInput,
      expectedVersion: string,
      signal?: AbortSignal,
    ): Promise<SolidityCompilation> {
      let inputText: string
      try {
        inputText = JSON.stringify(input)
      } catch {
        return Promise.reject(compileFailed())
      }
      if (Buffer.byteLength(inputText, 'utf8') > maxInputBytes) return Promise.reject(compileFailed())
      return new Promise((resolve, reject) => schedule({ inputText, expectedVersion, signal, resolve, reject }))
    },
  })
}
