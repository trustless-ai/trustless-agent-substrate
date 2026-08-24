import { describe, expect, it } from 'vitest'

import { TasError } from '../../../src/core/errors.js'
import { parseGitHubLocator } from '../../../src/core/repository/locator.js'

function expectUnsupported(locator: string): void {
  expect(() => parseGitHubLocator(locator)).toThrow(TasError)
  try {
    parseGitHubLocator(locator)
  } catch (error) {
    expect(error).toMatchObject({ code: 'REPOSITORY_LOCATOR_UNSUPPORTED' })
    expect(String(error)).not.toContain(locator)
  }
}

describe('parseGitHubLocator', () => {
  it.each([
    [
      'https://github.com/trustless-ai/trustless-agent-substrate',
      {
        locator: 'https://github.com/trustless-ai/trustless-agent-substrate',
        owner: 'trustless-ai',
        repository: 'trustless-agent-substrate',
      },
    ],
    [
      'https://github.com/Owner-Name/repo_name',
      {
        locator: 'https://github.com/Owner-Name/repo_name',
        owner: 'Owner-Name',
        repository: 'repo_name',
      },
    ],
  ])('accepts one byte-preserved canonical GitHub locator: %s', (locator, expected) => {
    expect(parseGitHubLocator(locator)).toEqual(expected)
  })

  it.each([
    'http://github.com/owner/repo',
    'https://user@github.com/owner/repo',
    'https://github.com:443/owner/repo',
    'https://github.com/owner/repo/',
    'https://github.com/owner/repo.git',
    'https://github.com/owner/repo?ref=main',
    'https://github.com/owner/repo#readme',
    'https://api.github.com/repos/owner/repo',
    'https://github.example.com/owner/repo',
    'git@github.com:owner/repo.git',
    'git://github.com/owner/repo',
    'https://GITHUB.com/owner/repo',
  ])('rejects an unsupported locator form without normalizing it: %s', expectUnsupported)

  it.each([
    'https://github.com//repo',
    'https://github.com/owner/',
    'https://github.com/owner',
    'https://github.com/owner/repo/extra',
    'https://github.com/-owner/repo',
    'https://github.com/owner-/repo',
    'https://github.com/owner--name/repo',
    `https://github.com/${'a'.repeat(40)}/repo`,
    'https://github.com/owner/.',
    'https://github.com/owner/..',
    'https://github.com/owner/repo space',
    `https://github.com/owner/${'r'.repeat(101)}`,
    'https://github.com/%6fwner/repo',
    'https://github.com/owner/%72epo',
    'https://github.com/owner/repo%2Egit',
    'https://github.com/owner%2Frepository/repo',
  ])('rejects invalid owner, repository, path, or percent-encoded segments: %s', expectUnsupported)
})
