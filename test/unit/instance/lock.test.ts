import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { TasError } from '../../../src/core/errors.js'

const { lockMock } = vi.hoisted(() => ({ lockMock: vi.fn() }))

vi.mock('proper-lockfile', () => ({ lock: lockMock }))

import { acquireMemberLock } from '../../../src/local/instance/lock.js'

const temporaryDirectories: string[] = []

async function memberDirectory(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'tas-compromised-lock-'))
  temporaryDirectories.push(root)
  return join(root, 'member')
}

afterEach(async () => {
  vi.clearAllMocks()
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { force: true, recursive: true })))
})

describe('acquireMemberLock compromise handling', () => {
  it('fails closed with one stable error when proper-lockfile reports compromised ownership', async () => {
    let onCompromised: ((error: Error) => void) | undefined
    const upstreamRelease = vi.fn(async () => undefined)
    lockMock.mockImplementation(async (_directory: string, options: { onCompromised?: (error: Error) => void }) => {
      onCompromised = options.onCompromised
      return upstreamRelease
    })
    const release = await acquireMemberLock(await memberDirectory())

    expect(onCompromised).toBeTypeOf('function')
    if (!onCompromised) throw new Error('Expected proper-lockfile compromise callback')
    expect(() => onCompromised!(new Error('raw upstream path: /private/member/tas.lock'))).not.toThrow()

    const releases = await Promise.allSettled([release(), release()])

    expect(releases).toHaveLength(2)
    for (const result of releases) {
      expect(result.status).toBe('rejected')
      if (result.status === 'rejected') {
        expect(result.reason).toBeInstanceOf(TasError)
        expect(result.reason).toMatchObject({
          code: 'INSTANCE_LOCK_FAILED',
          message: 'Member TAS instance lock was compromised',
          details: undefined,
        } satisfies Partial<TasError>)
        expect(String(result.reason)).not.toContain('/private/member/tas.lock')
      }
    }
    if (releases[0].status === 'rejected' && releases[1].status === 'rejected') {
      expect(releases[0].reason).toBe(releases[1].reason)
    }
    expect(upstreamRelease).not.toHaveBeenCalled()
  })
})
