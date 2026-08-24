import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'

import { lock } from 'proper-lockfile'

import { TasError } from '../../core/errors.js'

const lockFileName = 'tas.lock'

/** Acquires the exclusive lock for one member instance directory. */
export async function acquireMemberLock(memberDirectory: string): Promise<() => Promise<void>> {
  try {
    await mkdir(memberDirectory, { recursive: true })

    let compromised: TasError | undefined
    const releaseLock = await lock(memberDirectory, {
      lockfilePath: join(memberDirectory, lockFileName),
      onCompromised: () => {
        compromised ??= new TasError('INSTANCE_LOCK_FAILED', 'Member TAS instance lock was compromised')
      },
      realpath: false,
      retries: 0,
      stale: 30_000,
      update: 10_000,
    })

    let releasePromise: Promise<void> | undefined
    return async () => {
      releasePromise ??= releaseMemberLock(releaseLock, () => compromised)
      return releasePromise
    }
  } catch (error: unknown) {
    if (isContention(error)) {
      throw new TasError('INSTANCE_ALREADY_RUNNING', 'Member TAS instance is already running')
    }

    throw new TasError('INSTANCE_LOCK_FAILED', 'Member TAS instance lock could not be acquired')
  }
}

async function releaseMemberLock(releaseLock: () => Promise<void>, compromised: () => TasError | undefined): Promise<void> {
  const compromiseError = compromised()
  if (compromiseError) throw compromiseError

  try {
    await releaseLock()
  } catch {
    throw compromised() ?? new TasError('INSTANCE_LOCK_FAILED', 'Member TAS instance lock could not be released')
  }

  const afterReleaseCompromise = compromised()
  if (afterReleaseCompromise) throw afterReleaseCompromise
}

function isContention(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ELOCKED'
}
