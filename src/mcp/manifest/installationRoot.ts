import { lstatSync, type Stats } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'

const INVALID = Symbol('invalid installation path')

function statusIfPresent(path: string): Stats | undefined | typeof INVALID {
  try {
    return lstatSync(path)
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? undefined : INVALID
  }
}

function validNodeModulesRoot(nodeModules: string): string | undefined | typeof INVALID {
  const directory = statusIfPresent(nodeModules)
  if (directory === undefined) return undefined
  if (directory === INVALID || directory.isSymbolicLink() || !directory.isDirectory()) return INVALID
  const hiddenLock = statusIfPresent(join(nodeModules, '.package-lock.json'))
  if (hiddenLock === undefined) return undefined
  if (hiddenLock === INVALID || hiddenLock.isSymbolicLink() || !hiddenLock.isFile()) return INVALID
  return dirname(nodeModules)
}

function containingNodeModulesDirectories(artifactRoot: string): readonly string[] {
  const directories: string[] = []
  let current = resolve(artifactRoot)
  while (true) {
    if (basename(current) === 'node_modules') directories.push(current)
    const parent = dirname(current)
    if (parent === current) return directories
    current = parent
  }
}

export function findInstallationRoot(artifactRoot: string): string | undefined {
  const containingDirectories = containingNodeModulesDirectories(artifactRoot)
  if (containingDirectories.length > 0) {
    for (const nodeModules of containingDirectories) {
      const root = validNodeModulesRoot(nodeModules)
      if (root === INVALID) return undefined
      if (root !== undefined) return root
    }
    return undefined
  }

  let candidate = resolve(artifactRoot)
  for (let depth = 0; depth < 8; depth += 1) {
    const nodeModules = join(candidate, 'node_modules')
    const status = statusIfPresent(nodeModules)
    if (status !== undefined) {
      if (status === INVALID || status.isSymbolicLink() || !status.isDirectory()) return undefined
      return validNodeModulesRoot(nodeModules) === candidate ? candidate : undefined
    }
    const parent = dirname(candidate)
    if (parent === candidate) return undefined
    candidate = parent
  }
  return undefined
}
