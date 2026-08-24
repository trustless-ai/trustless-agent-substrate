import { createHash, type Hash } from 'node:crypto'
import {
  closeSync,
  constants as fileSystemConstants,
  fstatSync,
  lstatSync,
  openSync,
  opendirSync,
  readSync,
  realpathSync,
} from 'node:fs'
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path'

export interface ReviewedPackageTreeLimits {
  readonly maximumFileBytes: number
  readonly maximumPackageFiles: number
  readonly maximumPackageBytes: number
  readonly maximumGlobalFiles: number
  readonly maximumGlobalBytes: number
  readonly maximumPackageDirectories: number
  readonly maximumGlobalDirectories: number
  readonly maximumPackageEntries: number
  readonly maximumGlobalEntries: number
}

export const reviewedPackageTreeLimits: ReviewedPackageTreeLimits = Object.freeze({
  maximumFileBytes: 4 * 1_024 * 1_024,
  maximumPackageFiles: 20_000,
  maximumPackageBytes: 128 * 1_024 * 1_024,
  maximumGlobalFiles: 50_000,
  maximumGlobalBytes: 256 * 1_024 * 1_024,
  maximumPackageDirectories: 50_000,
  maximumGlobalDirectories: 100_000,
  maximumPackageEntries: 50_000,
  maximumGlobalEntries: 100_000,
})

export interface ReviewedPackageRoot {
  readonly packageName: string
  readonly packageRoot: string
}

export interface ReviewedPackageTreeSnapshot {
  readonly packageName: string
  readonly packageTreeSha256: `sha256:${string}`
  readonly packageFileCount: number
  readonly packageTotalBytes: number
}

interface PackageFile {
  readonly absolutePath: string
  readonly relativePath: string
  readonly size: number
}

interface GlobalBudget {
  files: number
  bytes: number
  directories: number
  entries: number
}

const packageFileDomain = Buffer.from('trustless-ai/tas/reviewed-package-file/v1', 'utf8')
const packageTreeDomain = Buffer.from('trustless-ai/tas/reviewed-package-tree/v1', 'utf8')
const fileRecordDomain = Buffer.from('file', 'utf8')
const summaryRecordDomain = Buffer.from('summary', 'utf8')
const readBufferBytes = 65_536

function isPathWithin(path: string, root: string): boolean {
  const child = relative(resolve(root), resolve(path))
  return child === '' || (!child.startsWith(`..${sep}`) && child !== '..' && !isAbsolute(child))
}

function lengthBuffer(length: number): Buffer {
  if (!Number.isSafeInteger(length) || length < 0) throw new Error('framed hash length must be a non-negative safe integer')
  const buffer = Buffer.alloc(8)
  buffer.writeBigUInt64BE(BigInt(length))
  return buffer
}

function updateFrame(hash: Hash, value: Buffer): void {
  hash.update(lengthBuffer(value.byteLength))
  hash.update(value)
}

function utf8Compare(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'))
}

function validateLimits(limits: ReviewedPackageTreeLimits): void {
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`reviewed package-tree ${name} must be a positive safe integer`)
  }
}

function recordDirectory(
  packageName: string,
  packageDirectories: { value: number },
  global: GlobalBudget,
  limits: ReviewedPackageTreeLimits,
): void {
  packageDirectories.value += 1
  global.directories += 1
  if (packageDirectories.value > limits.maximumPackageDirectories) {
    throw new Error(`reviewed package ${packageName} exceeds the package directory-count budget`)
  }
  if (global.directories > limits.maximumGlobalDirectories) {
    throw new Error('reviewed package trees exceed the global directory-count budget')
  }
}

function recordEntry(
  packageName: string,
  packageEntries: { value: number },
  global: GlobalBudget,
  limits: ReviewedPackageTreeLimits,
): void {
  packageEntries.value += 1
  global.entries += 1
  if (packageEntries.value > limits.maximumPackageEntries) {
    throw new Error(`reviewed package ${packageName} exceeds the package entry-count budget`)
  }
  if (global.entries > limits.maximumGlobalEntries) {
    throw new Error('reviewed package trees exceed the global entry-count budget')
  }
}

function enumeratePackageFiles(
  package_: ReviewedPackageRoot,
  global: GlobalBudget,
  limits: ReviewedPackageTreeLimits,
): PackageFile[] {
  const packageRoot = resolve(package_.packageRoot)
  const rootStatus = lstatSync(packageRoot)
  if (rootStatus.isSymbolicLink() || !rootStatus.isDirectory()) {
    throw new Error(`reviewed package ${package_.packageName} root must be a regular non-symlink directory`)
  }
  const realRoot = realpathSync(packageRoot)
  const pending = [packageRoot]
  const files: PackageFile[] = []
  const packageDirectories = { value: 0 }
  const packageEntries = { value: 0 }
  let packageBytes = 0
  recordDirectory(package_.packageName, packageDirectories, global, limits)

  while (pending.length > 0) {
    const directory = pending.pop() as string
    const directoryStatus = lstatSync(directory)
    if (directoryStatus.isSymbolicLink() || !directoryStatus.isDirectory()) {
      throw new Error(`reviewed package ${package_.packageName} contains a symlink or non-directory traversal path`)
    }
    if (!isPathWithin(realpathSync(directory), realRoot)) {
      throw new Error(`reviewed package ${package_.packageName} directory resolves outside its package root`)
    }
    const directoryHandle = opendirSync(directory)
    try {
      while (true) {
        const entry = directoryHandle.readSync()
        if (entry === null) break
        recordEntry(package_.packageName, packageEntries, global, limits)
        const absolutePath = join(directory, entry.name)
        const status = lstatSync(absolutePath)
        if (status.isSymbolicLink()) {
          throw new Error(`reviewed package ${package_.packageName} contains a symlink: ${entry.name}`)
        }
        if (status.isDirectory()) {
          if (entry.name.toLowerCase() === 'node_modules') {
            throw new Error(`reviewed package ${package_.packageName} contains nested node_modules`)
          }
          recordDirectory(package_.packageName, packageDirectories, global, limits)
          pending.push(absolutePath)
          continue
        }
        if (!status.isFile()) {
          throw new Error(`reviewed package ${package_.packageName} contains a special filesystem entry: ${entry.name}`)
        }
        const realFile = realpathSync(absolutePath)
        if (!isPathWithin(realFile, realRoot)) {
          throw new Error(`reviewed package ${package_.packageName} file resolves outside its package root`)
        }
        const relativePath = relative(realRoot, realFile).split(sep).join('/')
        if (relativePath.length === 0 || relativePath.split('/').includes('..')) {
          throw new Error(`reviewed package ${package_.packageName} has an unsafe relative path`)
        }
        if (status.size > limits.maximumFileBytes) {
          throw new Error(`reviewed package ${package_.packageName} exceeds the single-file byte budget: ${relativePath}`)
        }
        files.push({ absolutePath, relativePath, size: status.size })
        packageBytes += status.size
        global.files += 1
        global.bytes += status.size
        if (files.length > limits.maximumPackageFiles) {
          throw new Error(`reviewed package ${package_.packageName} exceeds the package file-count budget`)
        }
        if (packageBytes > limits.maximumPackageBytes) {
          throw new Error(`reviewed package ${package_.packageName} exceeds the package byte budget`)
        }
        if (global.files > limits.maximumGlobalFiles) {
          throw new Error('reviewed package trees exceed the global file-count budget')
        }
        if (global.bytes > limits.maximumGlobalBytes) {
          throw new Error('reviewed package trees exceed the global byte budget')
        }
      }
    } finally {
      directoryHandle.closeSync()
    }
  }
  if (files.length === 0) throw new Error(`reviewed package ${package_.packageName} tree is empty`)
  return files.toSorted((left, right) => utf8Compare(left.relativePath, right.relativePath))
}

function hashPackageFile(file: PackageFile): Buffer {
  const descriptor = openSync(
    file.absolutePath,
    fileSystemConstants.O_RDONLY | fileSystemConstants.O_NOFOLLOW | fileSystemConstants.O_NONBLOCK,
  )
  try {
    const before = fstatSync(descriptor)
    if (!before.isFile() || before.size !== file.size) {
      throw new Error(`reviewed package file changed before hashing: ${basename(file.absolutePath)}`)
    }
    const hash = createHash('sha256')
    updateFrame(hash, packageFileDomain)
    hash.update(lengthBuffer(file.size))
    const buffer = Buffer.allocUnsafe(Math.min(readBufferBytes, Math.max(1, file.size)))
    let total = 0
    while (total < file.size) {
      const read = readSync(descriptor, buffer, 0, Math.min(buffer.byteLength, file.size - total), null)
      if (read === 0) break
      hash.update(buffer.subarray(0, read))
      total += read
    }
    const extra = readSync(descriptor, buffer, 0, 1, null)
    const after = fstatSync(descriptor)
    if (total !== file.size || extra !== 0 || !after.isFile() || after.size !== file.size) {
      throw new Error(`reviewed package file changed while hashing: ${basename(file.absolutePath)}`)
    }
    return hash.digest()
  } finally {
    closeSync(descriptor)
  }
}

function snapshotPackage(
  package_: ReviewedPackageRoot,
  global: GlobalBudget,
  limits: ReviewedPackageTreeLimits,
): ReviewedPackageTreeSnapshot {
  const files = enumeratePackageFiles(package_, global, limits)
  const treeHash = createHash('sha256')
  updateFrame(treeHash, packageTreeDomain)
  let totalBytes = 0
  for (const file of files) {
    updateFrame(treeHash, fileRecordDomain)
    updateFrame(treeHash, Buffer.from(file.relativePath, 'utf8'))
    updateFrame(treeHash, lengthBuffer(file.size))
    updateFrame(treeHash, hashPackageFile(file))
    totalBytes += file.size
  }
  updateFrame(treeHash, summaryRecordDomain)
  updateFrame(treeHash, lengthBuffer(files.length))
  updateFrame(treeHash, lengthBuffer(totalBytes))
  return {
    packageName: package_.packageName,
    packageTreeSha256: `sha256:${treeHash.digest('hex')}`,
    packageFileCount: files.length,
    packageTotalBytes: totalBytes,
  }
}

function snapshotWithLimits(
  packages: readonly ReviewedPackageRoot[],
  limits: ReviewedPackageTreeLimits,
): readonly ReviewedPackageTreeSnapshot[] {
  validateLimits(limits)
  if (packages.length === 0) throw new Error('reviewed package-tree input must not be empty')
  const sorted = [...packages].toSorted((left, right) => utf8Compare(left.packageName, right.packageName))
  if (new Set(sorted.map(({ packageName }) => packageName)).size !== sorted.length) {
    throw new Error('reviewed package-tree input contains duplicate package names')
  }
  const global: GlobalBudget = { files: 0, bytes: 0, directories: 0, entries: 0 }
  return sorted.map((package_) => snapshotPackage(package_, global, limits))
}

export function snapshotReviewedPackageTrees(
  packages: readonly ReviewedPackageRoot[],
): readonly ReviewedPackageTreeSnapshot[] {
  return snapshotWithLimits(packages, reviewedPackageTreeLimits)
}

/** Conformance-only seam for proving fixed production budget behavior with small fixtures. */
export function snapshotReviewedPackageTreesForTest(
  packages: readonly ReviewedPackageRoot[],
  limits: ReviewedPackageTreeLimits,
): readonly ReviewedPackageTreeSnapshot[] {
  return snapshotWithLimits(packages, limits)
}
