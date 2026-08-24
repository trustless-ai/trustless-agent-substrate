import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, isAbsolute, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, vi } from 'vitest'
import { run } from '../../src/app/main.js'

const cliPath = fileURLToPath(new URL('../../src/app/main.ts', import.meta.url))
const packagePath = fileURLToPath(new URL('../../package.json', import.meta.url))

function pinnedNodeTypesVersion(): string {
  const pkg = JSON.parse(readFileSync(packagePath, 'utf8')) as {
    readonly devDependencies?: Readonly<Record<string, unknown>>
  }
  const version = pkg.devDependencies?.['@types/node']
  if (typeof version !== 'string') throw new Error('package.json must pin @types/node as a development dependency')
  return version
}

function runProcess(args: string[]) {
  return spawnSync(process.execPath, ['--import', 'tsx', cliPath, ...args], {
    encoding: 'utf8',
  })
}

async function runCli(args: string[]) {
  let stdout = ''
  let stderr = ''
  const status = await run(
    args,
    { write: (message: string) => (stdout += message) },
    { write: (message: string) => (stderr += message) },
  )

  return { status, stdout, stderr }
}

function npmCliPath(env: NodeJS.ProcessEnv = process.env): string {
  const npmExecPath = env.npm_execpath

  if (
    npmExecPath === undefined
    || !isAbsolute(npmExecPath)
    || basename(npmExecPath) !== 'npm-cli.js'
  ) {
    throw new Error('npm_execpath must be an existing absolute npm-cli.js file')
  }

  try {
    if (!statSync(npmExecPath).isFile()) {
      throw new Error('not a file')
    }
  } catch {
    throw new Error('npm_execpath must be an existing absolute npm-cli.js file')
  }

  return npmExecPath
}

function npmCliInvocation(npmCli: string, args: readonly string[]) {
  return { command: process.execPath, args: [npmCli, ...args] }
}

function consumerInstallInvocation(npmCli: string) {
  return npmCliInvocation(npmCli, [
    'install',
    '--prefer-offline',
    '--ignore-scripts',
    '--no-audit',
    '--no-fund',
  ])
}

function installedLauncherInvocation(
  platform: NodeJS.Platform,
  launcher: string,
): {
  command: string
  args: string[]
  options: { env: NodeJS.ProcessEnv; windowsVerbatimArguments?: boolean }
} {
  if (platform === 'win32') {
    return {
      command: 'cmd.exe',
      args: ['/d', '/v:off', '/s', '/c', '""%TAS_TEST_LAUNCHER%" --version"'],
      options: {
        env: { TAS_TEST_LAUNCHER: launcher },
        windowsVerbatimArguments: true,
      },
    }
  }

  return { command: launcher, args: ['--version'], options: { env: {} } }
}

describe('tas CLI', () => {
  it('prints the package version without diagnostics', async () => {
    const result = await runCli(['--version'])

    expect(result.status).toBe(0)
    expect(result.stdout).toBe('0.1.0\n')
    expect(result.stderr).toBe('')
  })

  it('executes the version command as a process', () => {
    const result = runProcess(['--version'])

    expect(result.status).toBe(0)
    expect(result.stdout).toBe('0.1.0\n')
    expect(result.stderr).toBe('')
  })

  it('starts when the executable is entered through a symbolic link', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'tas-cli-'))
    const executablePath = join(directory, 'tas')
    const originalArgv = process.argv
    const originalExitCode = process.exitCode
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)

    try {
      symlinkSync(cliPath, executablePath)
      process.argv = [process.execPath, executablePath, '--version']
      vi.resetModules()

      await import('../../src/app/main.js')

      expect(write).toHaveBeenCalledWith('0.1.0\n')
      expect(process.exitCode).toBe(0)
    } finally {
      process.argv = originalArgv
      process.exitCode = originalExitCode
      write.mockRestore()
      rmSync(directory, { force: true, recursive: true })
    }
  })

  it('invokes npm through Node using its JavaScript CLI path', () => {
    expect(npmCliInvocation('/tools/npm-cli.js', ['pack'])).toEqual({
      command: process.execPath,
      args: ['/tools/npm-cli.js', 'pack'],
    })
  })

  it('prefers the npm cache while permitting clean consumer dependency resolution', () => {
    expect(consumerInstallInvocation('/tools/npm-cli.js')).toEqual({
      command: process.execPath,
      args: [
        '/tools/npm-cli.js',
        'install',
        '--prefer-offline',
        '--ignore-scripts',
        '--no-audit',
        '--no-fund',
      ],
    })
  })

  it('requires npm_execpath to name an existing absolute npm-cli.js file', () => {
    const currentNpmCli = npmCliPath()

    expect(npmCliPath({ npm_execpath: currentNpmCli })).toBe(currentNpmCli)
    expect(() => npmCliPath({})).toThrow('npm_execpath must be an existing absolute npm-cli.js file')
    expect(() => npmCliPath({ npm_execpath: 'npm-cli.js' })).toThrow(
      'npm_execpath must be an existing absolute npm-cli.js file',
    )
    expect(() => npmCliPath({ npm_execpath: process.execPath })).toThrow(
      'npm_execpath must be an existing absolute npm-cli.js file',
    )
    expect(() => npmCliPath({ npm_execpath: join(tmpdir(), 'tas-missing', 'npm-cli.js') })).toThrow(
      'npm_execpath must be an existing absolute npm-cli.js file',
    )
  })

  it.each([
    ['spaces', 'C:\\Program Files\\tas\\tas.cmd'],
    ['CMD metacharacters', 'C:\\tas & (draft)^!%\\tas.cmd'],
  ])('uses a constant CMD command for Windows paths with %s', (_description, launcher) => {
    expect(installedLauncherInvocation('win32', launcher)).toEqual({
      command: 'cmd.exe',
      args: ['/d', '/v:off', '/s', '/c', '""%TAS_TEST_LAUNCHER%" --version"'],
      options: {
        env: { TAS_TEST_LAUNCHER: launcher },
        windowsVerbatimArguments: true,
      },
    })
  })

  it('does not enable verbatim Windows arguments for POSIX launchers', () => {
    expect(installedLauncherInvocation('linux', '/tmp/tas')).toEqual({
      command: '/tmp/tas',
      args: ['--version'],
      options: { env: {} },
    })
  })

  it('runs the npm-created launcher from a temporary package installation', () => {
    const directory = mkdtempSync(join(tmpdir(), 'tas-package-'))

    try {
      const packageTarball = join(directory, 'trustless-ai-tas-0.1.0.tgz')
      const launcher = join(
        directory,
        'node_modules',
        '.bin',
        process.platform === 'win32' ? 'tas.cmd' : 'tas',
      )
      const npmCli = npmCliPath()
      const pack = npmCliInvocation(npmCli, ['pack', '--pack-destination', directory])
      execFileSync(pack.command, pack.args, {
        cwd: fileURLToPath(new URL('../..', import.meta.url)),
        stdio: 'pipe',
      })
      const nodeTypesVersion = pinnedNodeTypesVersion()
      writeFileSync(join(directory, 'package.json'), `${JSON.stringify({
        private: true,
        dependencies: { '@trustless-ai/tas': `file:./${basename(packageTarball)}` },
        overrides: { '@types/node': nodeTypesVersion },
      }, null, 2)}\n`)
      const install = consumerInstallInvocation(npmCli)
      execFileSync(
        install.command,
        install.args,
        { cwd: directory, stdio: 'pipe' },
      )

      const installedNodeTypes = JSON.parse(
        readFileSync(join(directory, 'node_modules', '@types', 'node', 'package.json'), 'utf8'),
      ) as { readonly version?: unknown }
      expect(installedNodeTypes.version).toBe(nodeTypesVersion)

      const invocation = installedLauncherInvocation(process.platform, launcher)
      const result = spawnSync(invocation.command, invocation.args, {
        encoding: 'utf8',
        env: { ...process.env, ...invocation.options.env },
        windowsVerbatimArguments: invocation.options.windowsVerbatimArguments,
      })

      expect(result.status).toBe(0)
      expect(result.stdout).toBe('0.1.0\n')
      expect(result.stderr).toBe('')
    } finally {
      rmSync(directory, { force: true, recursive: true })
    }
  }, 30_000)

  it('returns a fixed safe failure when configuration startup fails', async () => {
    const result = await runCli(['--config', 'tas.toml'])

    expect(result.status).toBe(1)
    expect(result.stdout).toBe('')
    expect(result.stderr).toBe('TAS_STARTUP_FAILED\n')
  })

  it.each([
    ['a missing configuration path', ['--config']],
    ['an unknown flag', ['--unknown']],
    ['a duplicate version flag', ['--version', '--version']],
    ['a duplicate configuration flag', ['--config', 'one.toml', '--config', 'two.toml']],
    ['a flag used as a configuration path', ['--config', '--version']],
  ])('rejects %s without writing stdout', async (_description, args) => {
    const result = await runCli(args)

    expect(result.status).toBe(2)
    expect(result.stdout).toBe('')
    expect(result.stderr).toBe('Usage: tas --version | tas --config <path>\n')
  })
})
