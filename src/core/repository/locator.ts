import { TasError } from '../errors.js'

const ownerPattern = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/
const repositoryPattern = /^[A-Za-z0-9._-]{1,100}$/

export interface GitHubLocator {
  readonly locator: `https://github.com/${string}/${string}`
  readonly owner: string
  readonly repository: string
}

function unsupported(): never {
  throw new TasError(
    'REPOSITORY_LOCATOR_UNSUPPORTED',
    'The Profile Repository locator is not supported.',
  )
}

export function parseGitHubLocator(locator: string): GitHubLocator {
  let url: URL
  try {
    url = new URL(locator)
  } catch {
    return unsupported()
  }

  if (
    url.protocol !== 'https:'
    || url.hostname !== 'github.com'
    || url.username !== ''
    || url.password !== ''
    || url.port !== ''
    || url.search !== ''
    || url.hash !== ''
  ) return unsupported()

  const segments = url.pathname.split('/')
  if (segments.length !== 3 || segments[0] !== '') return unsupported()
  const owner = segments[1]
  const repository = segments[2]
  if (
    owner === undefined
    || repository === undefined
    || !ownerPattern.test(owner)
    || owner.includes('--')
    || !repositoryPattern.test(repository)
    || repository === '.'
    || repository === '..'
    || repository.toLowerCase().endsWith('.git')
  ) return unsupported()

  const canonical = `https://github.com/${owner}/${repository}` as const
  if (locator !== canonical) return unsupported()

  return { locator: canonical, owner, repository }
}
