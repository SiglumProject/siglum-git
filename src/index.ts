/**
 * @siglum/git
 *
 * Browser-based Git operations using OPFS storage with isomorphic-git.
 *
 * ## Standalone OPFS Adapter
 *
 * Use the OPFS adapter directly with isomorphic-git:
 *
 * ```typescript
 * import { createOPFSGitAdapter } from '@siglum/git'
 * import git from 'isomorphic-git'
 * import http from 'isomorphic-git/http/web'
 *
 * const fs = createOPFSGitAdapter()
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

// OPFS adapter for isomorphic-git (standalone)
export { createOPFSGitAdapter, getOPFSGitAdapter } from './OPFSGitAdapter'

// Full GitService with sync, subscriptions, etc.
export { GitService, getGitService, type GitServiceOptions } from './GitService'

// Types
export type {
  GitConfig,
  GitStatus,
  FileChange,
  FileItem,
  GitStatusListener,
  FileTreeListener
} from './types'
