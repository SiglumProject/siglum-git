import { fileSystem } from '@siglum/filesystem'

const STAGING = '/git-staging'
const RECOVERY = '/git-recovery'
const SNAPSHOT = `${RECOVERY}/snapshot`
const PENDING = `${RECOVERY}/pending.json`

async function mountRecovery(): Promise<void> {
  if (!fileSystem.isMounted(RECOVERY)) await fileSystem.mountAuto(RECOVERY, { namespace: 'siglum-git-recovery' })
}

/** Retry recovery after an interrupted install or a storage failure. */
export async function recoverRepository(): Promise<void> {
  await mountRecovery()
  if (!await fileSystem.exists(PENDING)) throw new Error('No interrupted repository replacement to recover')
  if (!await fileSystem.exists(SNAPSHOT)) throw new Error('Recovery snapshot is missing; the checkout has not been changed')
  await clearDirectory('/git')
  await copyDirectory(SNAPSHOT, '/git')
  await fileSystem.deleteFile(PENDING, { silent: true })
}

async function clearDirectory(path: string): Promise<void> {
  for (const entry of await fileSystem.readdir(path)) {
    if (entry.isDirectory) await fileSystem.rmdir(entry.path, { recursive: true, silent: true })
    else await fileSystem.deleteFile(entry.path, { silent: true })
  }
}

async function copyDirectory(source: string, target: string): Promise<void> {
  await fileSystem.mkdir(target, { silent: true })
  for (const entry of await fileSystem.readdir(source)) {
    const destination = `${target}/${entry.name}`
    if (entry.isDirectory) await copyDirectory(entry.path, destination)
    else await fileSystem.writeBinary(destination,
      await fileSystem.readBinary(entry.path, { autoDecompress: false }),
      { createParents: true, silent: true })
  }
}

/** Download and back up before touching the live checkout. Browser storage has
 * no atomic directory swap; retain a complete recovery copy even after success.
 * Failed installs roll back. If storage also prevents rollback, the backup stays
 * available in the independent siglum-git-recovery storage namespace.
 */
export async function replaceRepository(
  clone: (directory: string) => Promise<void>,
  beforeReplace?: () => Promise<void>,
): Promise<void> {
  for (const [path, namespace] of [[STAGING, 'siglum-git-staging'], [RECOVERY, 'siglum-git-recovery']]) {
    if (!fileSystem.isMounted(path)) await fileSystem.mountAuto(path, { namespace })
  }
  if (await fileSystem.exists(PENDING)) {
    throw new Error('An interrupted replacement needs recovery from /git-recovery/snapshot before replacing this checkout again.')
  }
  await clearDirectory(STAGING)
  try {
    await clone(STAGING)
    await beforeReplace?.()
    // A failed download or failed backup must never erase the live checkout.
    await clearDirectory(RECOVERY)
    await copyDirectory('/git', SNAPSHOT)
    await fileSystem.writeFile(PENDING, JSON.stringify({ createdAt: new Date().toISOString() }), { silent: true })
    try {
      await clearDirectory('/git')
      await copyDirectory(STAGING, '/git')
      await fileSystem.deleteFile(PENDING, { silent: true })
    } catch (installError) {
      try {
        await clearDirectory('/git')
        await copyDirectory(SNAPSHOT, '/git')
        await fileSystem.deleteFile(PENDING, { silent: true })
      } catch {
        throw new Error('Repository replacement and recovery failed. Your previous checkout is preserved in /git-recovery/snapshot (storage namespace siglum-git-recovery). Free storage before recovering it.')
      }
      throw installError
    }
  } finally {
    // Cleanup failure must not turn a successful replacement into a failed one.
    await clearDirectory(STAGING).catch(() => {})
  }
}
