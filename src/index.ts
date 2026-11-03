/**
 * @siglum/git
 *
 * Browser-based Git operations using siglum-filesystem with isomorphic-git.
 *
 * ## Filesystem Adapter
 *
 * Use the filesystem adapter directly with isomorphic-git:
 *
 * ```typescript
 * import { createFilesystemGitAdapter } from '@siglum/git'
 * import { fileSystem } from '@siglum/filesystem'
 * import git from 'isomorphic-git'
 * import http from 'isomorphic-git/http/web'
 *
 * await fileSystem.mountAuto('/repo')
 * const fs = createFilesystemGitAdapter(fileSystem)
 *
 * await git.clone({
 *   fs,
 *   http,
 *   dir: '/repo',
 *   url: 'https://github.com/user/repo',
 *   corsProxy: 'https://cors.isomorphic-git.org'
 * })
 *
 * // Read files
 * const content = await fs.promises.readFile('/repo/README.md', 'utf8')
 * ```
 *
 * ## Full GitService
 *
 * For a higher-level API with sync, conflict detection, and subscriptions:
 *
 * ```typescript
 * import { GitService } from '@siglum/git'
 *
 * const git = new GitService({
 *   corsProxy: 'https://cors.isomorphic-git.org',
 *   onFileTreeChange: (files) => console.log('Files:', files)
 * })
 *
 * await git.connect({
 *   provider: 'github',
 *   repoUrl: 'https://github.com/user/repo',
 *   branch: 'main',
 *   token: 'ghp_xxx'
 * })
 *
 * git.subscribeStatus((status) => {
 *   console.log('Connected:', status.isConnected)
 * })
 * ```
 */

// Legacy OPFS adapter for isomorphic-git (deprecated, use createFilesystemGitAdapter)
export { createOPFSGitAdapter, getOPFSGitAdapter } from './OPFSGitAdapter'

// Filesystem adapter for isomorphic-git (wraps @siglum/filesystem)
export { createFilesystemGitAdapter, type FilesystemGitAdapter } from './FilesystemGitAdapter'

// Full GitService with sync, subscriptions, etc.
export { GitService, getGitService, type GitServiceOptions } from './GitService'

// Types
export type {
  GitConfig,
  GitStatus,
  FileChange,
  FileItem,
  GitStatusListener,
  FileTreeListener,
  Collaborator,
  CollaboratorPresence,
  CollaboratorsListener,
  BranchDiff,
  ConflictingFile
} from './types'
