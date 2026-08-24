import { posix } from 'node:path'

import { TasError } from '../errors.js'
import type { FullGitCommit, GitDaPath, GitDaReference } from './types.js'

const fullCommitPattern = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/
const maxPathCharacters = 4_096

function invalidReference(): never {
  throw new TasError('DA_REFERENCE_INVALID', 'The DA reference is invalid.')
}

function invalidPath(): never {
  throw new TasError('DA_PATH_INVALID', 'The DA destination path is invalid.')
}

function dataProperty(value: unknown, key: string): unknown {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return invalidReference()
  try {
    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) return invalidReference()
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) return invalidReference()
    return descriptor.value
  } catch {
    return invalidReference()
  }
}

export function requireFullGitCommit(value: unknown): FullGitCommit {
  return typeof value === 'string' && fullCommitPattern.test(value)
    ? value
    : invalidReference()
}

export function requireGitDaPath(value: unknown): GitDaPath {
  if (
    typeof value !== 'string'
    || value.length > maxPathCharacters
    || !value.startsWith('data/')
    || value === 'data/'
    || value.endsWith('/')
    || value.includes('\\')
    || /[\u0000-\u001f\u007f]/.test(value)
    || posix.isAbsolute(value)
    || posix.normalize(value) !== value
  ) return invalidPath()

  const segments = value.split('/')
  if (segments.some((segment) => segment.length === 0 || segment === '.' || segment === '..')) {
    return invalidPath()
  }
  return value as GitDaPath
}

export function parseGitDaReference(value: unknown): GitDaReference {
  const type = dataProperty(value, 'type')
  const commit = dataProperty(value, 'commit')
  const path = dataProperty(value, 'path')
  if (type !== 'git') return invalidReference()

  try {
    return {
      type: 'git',
      commit: requireFullGitCommit(commit),
      path: requireGitDaPath(path),
    }
  } catch (error) {
    if (error instanceof TasError && error.code === 'DA_PATH_INVALID') return invalidReference()
    throw error
  }
}
