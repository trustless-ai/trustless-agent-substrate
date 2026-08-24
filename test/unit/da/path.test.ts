import { describe, expect, it } from 'vitest'

import { TasError } from '../../../src/core/errors.js'
import {
  parseGitDaReference,
  requireFullGitCommit,
  requireGitDaPath,
} from '../../../src/core/da/path.js'

const commit40 = 'a'.repeat(40)
const commit64 = 'b'.repeat(64)

describe('Git DA immutable references', () => {
  it.each([commit40, commit64])('accepts a full lowercase Git commit: %s', (commit) => {
    expect(requireFullGitCommit(commit)).toBe(commit)
  })

  it.each([
    '', 'a'.repeat(39), 'a'.repeat(41), 'A'.repeat(40), 'main', 'abc1234',
    `0x${'a'.repeat(40)}`,
  ])('rejects a mutable or non-canonical Git commit: %s', (commit) => {
    expect(() => requireFullGitCommit(commit)).toThrowError(
      expect.objectContaining<TasError>({ code: 'DA_REFERENCE_INVALID' }),
    )
  })

  it('returns a canonical immutable reference without retaining untrusted input fields', () => {
    const input = { type: 'git', commit: commit64, path: 'data/runs/42/result.json', repository: 'attacker/repo' }

    expect(parseGitDaReference(input)).toEqual({
      type: 'git', commit: commit64, path: 'data/runs/42/result.json',
    })
    expect(parseGitDaReference(input)).not.toBe(input)
  })

  it.each([
    null,
    {},
    { type: 'ipfs', commit: commit40, path: 'data/result.json' },
    { type: 'git', commit: 'main', path: 'data/result.json' },
    { type: 'git', commit: commit40, path: '../data/result.json' },
  ])('rejects a malformed or unsupported reference: %j', (ref) => {
    expect(() => parseGitDaReference(ref)).toThrowError(
      expect.objectContaining<TasError>({ code: 'DA_REFERENCE_INVALID' }),
    )
  })
})

describe('Git DA path confinement', () => {
  it.each([
    'data/result.json',
    'data/runs/42/result.json',
    'data/a b/日本語.bin',
  ])('accepts an already-normalized file path below data/: %s', (path) => {
    expect(requireGitDaPath(path)).toBe(path)
  })

  it.each([
    '',
    'data',
    'data/',
    '/data/result.json',
    'result.json',
    'database/result.json',
    'data/../secret',
    'data/./result.json',
    'data/runs//result.json',
    'data/runs/',
    'data\\result.json',
    'data/runs\\result.json',
    'data/\0result.json',
    'data/result\n.json',
    'data/result\u007f.json',
  ])('rejects a path that is not a canonical file below data/: %s', (path) => {
    expect(() => requireGitDaPath(path)).toThrowError(
      expect.objectContaining<TasError>({ code: 'DA_PATH_INVALID' }),
    )
  })
})
