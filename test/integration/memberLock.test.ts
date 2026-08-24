import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { TasError } from '../../src/core/errors.js'
import { acquireMemberLock } from '../../src/local/instance/lock.js'

const temporaryDirectories: string[] = []

async function memberDirectory(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'tas-member-lock-'))
  temporaryDirectories.push(root)
  return join(root, 'instances', 'eip155-1-0xabc', 'agents', '42')
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { force: true, recursive: true })))
})

describe('acquireMemberLock', () => {
  it('creates the member directory and its exact tas.lock artifact for the first owner', async () => {
    const directory = await memberDirectory()
    const release = await acquireMemberLock(directory)

    expect(await readdir(directory)).toEqual(['tas.lock'])

    await release()
  })

  it('rejects a second owner immediately with a safe contention error', async () => {
    const directory = await memberDirectory()
    const release = await acquireMemberLock(directory)

    await expect(acquireMemberLock(directory)).rejects.toMatchObject({
      name: 'TasError',
      code: 'INSTANCE_ALREADY_RUNNING',
      message: 'Member TAS instance is already running',
      details: undefined,
    } satisfies Partial<TasError>)

    await release()
  })

  it('releases idempotently under concurrent calls and permits reacquisition', async () => {
    const directory = await memberDirectory()
    const release = await acquireMemberLock(directory)

    await Promise.all([release(), release(), release()])

    const nextRelease = await acquireMemberLock(directory)
    await nextRelease()
  })

  it('does not mislabel an unrelated lock acquisition failure as contention', async () => {
    const directory = await memberDirectory()
    await mkdir(dirname(directory), { recursive: true })
    await writeFile(directory, 'not a directory')

    await expect(acquireMemberLock(directory)).rejects.toMatchObject({
      name: 'TasError',
      code: 'INSTANCE_LOCK_FAILED',
      message: 'Member TAS instance lock could not be acquired',
      details: undefined,
    } satisfies Partial<TasError>)
  })

  it('returns a safe error when an acquired lock cannot be released', async () => {
    const directory = await memberDirectory()
    const release = await acquireMemberLock(directory)
    const lockPath = join(directory, 'tas.lock')
    await rm(lockPath, { recursive: true })
    await writeFile(lockPath, 'replaced lock')

    await expect(release()).rejects.toMatchObject({
      name: 'TasError',
      code: 'INSTANCE_LOCK_FAILED',
      message: 'Member TAS instance lock could not be released',
      details: undefined,
    } satisfies Partial<TasError>)
  })
})
