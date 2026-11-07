/**
 * GitService - Git operations using siglum-filesystem
 *
 * Uses @siglum/filesystem for git repository storage, providing a unified
 * storage layer shared with the rest of the application.
 *
 * isomorphic-git is lazily loaded on first git operation to reduce initial bundle.
 */

import { Buffer } from 'buffer'
import { replaceRepository, recoverRepository } from './RepositoryReplacement'
import { fileSystem } from '@siglum/filesystem'
import { createFilesystemGitAdapter, type FilesystemGitAdapter } from './FilesystemGitAdapter'
import type {
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
  ConflictingFile,
  GitConflictReview,
  GitConflictResolution
} from './types'

// Polyfill Buffer for browser
declare const globalThis: { Buffer?: typeof Buffer }
if (typeof globalThis.Buffer === 'undefined') {
  globalThis.Buffer = Buffer
}

// Lazy-loaded git modules
let gitModule: typeof import('isomorphic-git').default | null = null
let httpModule: typeof import('isomorphic-git/http/web').default | null = null

async function loadGitModules() {
  if (!gitModule || !httpModule) {
    const [gitImport, httpImport] = await Promise.all([
      import('isomorphic-git'),
      import('isomorphic-git/http/web')
    ])
    gitModule = gitImport.default
    httpModule = httpImport.default
  }
  return { git: gitModule, http: httpModule }
}

// Git directory within the filesystem
const GIT_DIR = '/git'

type ConflictBytes = Uint8Array | null

interface IncomingConflictPath {
  path: string
  previous: boolean
  incoming: boolean
}

interface ConflictReviewState {
  id: string
  config: GitConfig
  connection: GitConfig
  localHead: string
  remoteHead: string
  affected: IncomingConflictPath[]
  workingFiles: Map<string, ConflictBytes>
  conflicts: Map<string, { binary: boolean }>
}

function sameConflictBytes(left: ConflictBytes, right: ConflictBytes): boolean {
  if (left === null || right === null) return left === right
  if (left.byteLength !== right.byteLength) return false
  return left.every((byte, index) => byte === right[index])
}

function decodeConflictText(bytes: ConflictBytes): string | null {
  if (!bytes || bytes.includes(0)) return null
  try { return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes) }
  catch { return null }
}

function safeConflictPath(path: string): boolean {
  return !/[\\\0\r\n]/.test(path) && path.split('/').every(part =>
    part && part !== '.' && part !== '..' && part.toLowerCase() !== '.git')
}


export interface GitServiceOptions {
  /** CORS proxy URL for git operations */
  corsProxy?: string
  /** Storage key for config persistence */
  storageKey?: string
  /** Flush editor drafts before switching the working tree. */
  beforeBranchSwitch?: () => Promise<void>
  /** Flush editor drafts before reconnect, clone, or force pull. */
  beforeWorkingTreeChange?: () => Promise<void>
  /** Callback when file tree changes */
  onFileTreeChange?: FileTreeListener
}

export class GitService {
  private fs: FilesystemGitAdapter
  private config: GitConfig | null = null
  private status: GitStatus = {
    remoteStatus: 'unchecked',
    isConnected: false,
    isSyncing: false,
    ahead: 0,
    behind: 0,
    hasChanges: false,
    hasConflict: false
  }
  private syncIntervalId: number | null = null
  private statusListeners: Set<GitStatusListener> = new Set()
  private fileTreeListeners: Set<FileTreeListener> = new Set()
  private collaboratorsListeners: Set<CollaboratorsListener> = new Set()
  private remoteCheckCleanup: (() => void) | null = null
  private collaboratorsPollId: number | null = null
  private presenceUpdateId: number | null = null
  private options: GitServiceOptions
  private conflictReview: ConflictReviewState | null = null
  private pendingWorktreeWrites = 0

  constructor(options: GitServiceOptions = {}) {
    this.options = {
      corsProxy: 'https://cors.isomorphic-git.org',
      storageKey: 'siglum-git-config',
      ...options
    }
    this.fs = createFilesystemGitAdapter(fileSystem)

    if (options.onFileTreeChange) {
      this.fileTreeListeners.add(options.onFileTreeChange)
    }

    this.loadConfig()
  }

  private loadConfig(): void {
    if (typeof localStorage === 'undefined') return

    const saved = localStorage.getItem(this.options.storageKey!)
    if (saved) {
      try {
        this.config = JSON.parse(saved)
        if (this.config?.token) {
          this.status.isConnected = true
          this.startRemoteCheck()
        }
      } catch {
        // Invalid config
      }
    }
  }

  private recordRemoteError(error: unknown): void {
    const code = (error as { data?: { statusCode?: number } })?.data?.statusCode
    const message = error instanceof Error ? error.message : 'Could not sync with the repository.'
    this.status.needsAuthentication = code === 401 || code === 403 || /\b(401|403)\b/.test(message)
    this.status.remoteStatus = 'error'
    this.status.error = this.status.needsAuthentication
      ? 'Repository access was denied. Update your token and check that it has access to this repository. Local files are still available.'
      : message
    this.notifyStatusListeners()
  }

  /** Validate new credentials without cloning or replacing any local files. */
  async updateToken(token: string): Promise<void> {
    if (!this.config) throw new Error('Not configured')
    if (this.status.isSyncing) throw new Error('Another Git operation is in progress')
    if (!token.trim()) throw new Error('Enter a token')
    const previous = this.config
    this.config = { ...previous, token: token.trim() }
    this.status.isSyncing = true
    this.notifyStatusListeners()
    try {
      await this.checkRemote()
      this.saveConfig()
      this.startAutoSync()
    } catch (error) {
      this.config = previous
      throw error
    } finally {
      this.status.isSyncing = false
      this.notifyStatusListeners()
    }
  }

  private saveConfig(): void {
    if (typeof localStorage === 'undefined') return

    if (this.config) {
      localStorage.setItem(this.options.storageKey!, JSON.stringify(this.config))
    } else {
      localStorage.removeItem(this.options.storageKey!)
    }
  }

  private notifyStatusListeners(): void {
    this.statusListeners.forEach(listener => listener({ ...this.status }))
  }

  private notifyFileTreeListeners(files: FileItem[]): void {
    this.fileTreeListeners.forEach(listener => listener(files))
  }

  /**
   * Subscribe to status changes
   */
  subscribeStatus(listener: GitStatusListener): () => void {
    this.statusListeners.add(listener)
    listener({ ...this.status })
    return () => this.statusListeners.delete(listener)
  }

  /**
   * Change the branch (requires reconnect to take effect)
   */
  setBranch(branch: string): void {
    if (!this.config) return
    this.config.branch = branch
    this.saveConfig()
  }

  /**
   * Subscribe to file tree changes
   */
  subscribeFileTree(listener: FileTreeListener): () => void {
    this.fileTreeListeners.add(listener)
    return () => this.fileTreeListeners.delete(listener)
  }

  getConfig(): GitConfig | null {
    return this.config
  }

  getStatus(): GitStatus {
    return { ...this.status }
  }

  get isConnected(): boolean {
    return this.status.isConnected
  }

  /**
   * Ensure the git filesystem is mounted with its own isolated namespace
   */
  private async ensureMounted(): Promise<void> {
    if (!fileSystem.isMounted(GIT_DIR)) {
      await fileSystem.mountAuto(GIT_DIR, { namespace: 'siglum-git' })
    }
  }

  private getRepoUrl(config = this.config): string {
    if (!config) throw new Error('Not configured')

    const repoUrl = config.repoUrl

    // GitHub: explicit provider, github.com URL, or owner/repo shorthand
    if (
      config.provider === 'github' ||
      repoUrl.includes('github.com') ||
      /^[^\/\s]+\/[^\/\s]+$/.test(repoUrl)
    ) {
      const repoPath = repoUrl.replace(/^https?:\/\/github\.com\//, '').replace(/\.git$/, '')
      return `https://github.com/${repoPath}.git`
    }

    if (repoUrl.startsWith('https://')) {
      const url = new URL(repoUrl)
      // Authentication belongs in onAuth, never in persisted remote URLs.
      url.username = ''
      url.password = ''
      return url.toString()
    }

    return repoUrl
  }

  /**
   * Connect to a git repository
   */
  async connect(config: GitConfig): Promise<void> {
    if (this.status.isSyncing) throw new Error('Another Git operation is in progress')
    const previousConfig = this.config
    this.status.isSyncing = true
    this.status.error = undefined
    this.notifyStatusListeners()

    try {
      await this.cloneReplacement(config, 1)
      this.config = { ...config }
      this.status = {
        isConnected: true, remoteStatus: 'ok', isSyncing: true, ahead: 0, behind: 0,
        hasChanges: false, hasConflict: false, lastSync: new Date(),
      }
      this.saveConfig()
      await this.syncFileTree()
      this.startAutoSync()
    } catch (error: unknown) {
      this.config = previousConfig
      const httpError = error as { data?: { statusCode?: number } }
      const errorMessage = error instanceof Error ? error.message : String(error)
      if (httpError?.data?.statusCode === 404 || errorMessage.includes('404')) {
        // Keep a first connection's credentials for the explicit create-repo flow.
        if (!previousConfig) this.config = { ...config }
        this.status.error = 'Repository not found'
        const repoNotFoundError = new Error('REPO_NOT_FOUND')
        ;(repoNotFoundError as Error & { repoUrl: string }).repoUrl = config.repoUrl
        throw repoNotFoundError
      }
      this.status.error = errorMessage || 'Connection failed'
      throw error
    } finally {
      this.status.isSyncing = false
      this.notifyStatusListeners()
    }
  }

  private async cloneReplacement(config: GitConfig, depth: number): Promise<void> {
    await this.ensureMounted()
    const { git, http } = await loadGitModules()
    await replaceRepository(async dir => {
      await git.clone({
        fs: this.fs, http, dir, url: this.getRepoUrl(config), ref: config.branch,
        singleBranch: true, depth, corsProxy: this.options.corsProxy,
        onAuth: () => ({ username: config.username || config.token, password: config.token }),
      })
    }, this.options.beforeWorkingTreeChange)
  }

  /**
   * Create a new repository on GitHub
   */
  async createRepo(repoName: string, isPrivate: boolean = true): Promise<void> {
    if (!this.config?.token) throw new Error('No token configured')

    const response = await fetch('https://api.github.com/user/repos', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.config.token}`,
        'Accept': 'application/vnd.github+json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        name: repoName,
        private: isPrivate,
        auto_init: true,
      })
    })

    if (!response.ok) {
      const error = await response.json()
      throw new Error(error.message || 'Failed to create repository')
    }

    await new Promise(resolve => setTimeout(resolve, 1500))
    await this.connect(this.config)
  }

  /**
   * Switch to a different branch
   */
  async switchBranch(branch: string): Promise<void> {
    if (!this.config) throw new Error('Not connected')

    if (this.status.isSyncing) throw new Error('Another Git operation is in progress')
    this.status.isSyncing = true
    this.status.error = undefined
    this.notifyStatusListeners()

    try {
      await this.options.beforeBranchSwitch?.()
      await this.ensureMounted()
      const { git, http } = await loadGitModules()
      const changes = await git.statusMatrix({ fs: this.fs, dir: GIT_DIR })
      if (changes.some(([, head, workdir, stage]) => head !== workdir || head !== stage)) {
        throw new Error('Save and sync your changes before switching branches.')
      }

      const localBranches = await git.listBranches({ fs: this.fs, dir: GIT_DIR })
      let createdBranch = false
      if (!localBranches.includes(branch)) {
        const connection = {
          http, url: this.getRepoUrl(), corsProxy: this.options.corsProxy,
          onAuth: () => ({ username: this.config!.username || this.config!.token, password: this.config!.token }),
        }
        // A network/authentication failure must not be interpreted as a missing branch.
        const refs = await git.listServerRefs({ ...connection, prefix: 'refs/heads/' })
        const remote = refs.find(ref => ref.ref === `refs/heads/${branch}`)
        if (remote) {
          await git.fetch({ ...connection, fs: this.fs, dir: GIT_DIR, ref: branch, singleBranch: true })
          const object = await git.resolveRef({ fs: this.fs, dir: GIT_DIR, ref: `refs/remotes/origin/${branch}` })
          await git.branch({ fs: this.fs, dir: GIT_DIR, ref: branch, object })
        } else {
          await git.branch({ fs: this.fs, dir: GIT_DIR, ref: branch })
          createdBranch = true
        }
      }
      // Keep the repository and its local commits intact; checkout refuses conflicting writes.
      await git.checkout({ fs: this.fs, dir: GIT_DIR, ref: branch })
      this.config.branch = branch
      this.saveConfig()
      if (createdBranch) {
        await git.push({
          fs: this.fs, http, dir: GIT_DIR, remote: 'origin', ref: branch,
          corsProxy: this.options.corsProxy,
          onAuth: () => ({ username: this.config!.username || this.config!.token, password: this.config!.token }),
        })
      }

      this.config.branch = branch
      this.saveConfig()

      await this.syncFileTree()
      this.status.lastSync = new Date()
    } catch (error) {
      this.status.error = error instanceof Error ? error.message : 'Branch switch failed'
      throw error
    } finally {
      this.status.isSyncing = false
      this.notifyStatusListeners()
    }
  }

  private async syncFileTree(): Promise<void> {
    const fileTree = await this.buildFileTree(GIT_DIR)
    this.notifyFileTreeListeners(fileTree)
  }

  private async buildFileTree(dir: string, relativePath: string = ''): Promise<FileItem[]> {
    const items: FileItem[] = []

    try {
      const entries = await this.fs.promises.readdir(dir)

      for (const name of entries) {
        if (name === '.git') continue

        const fullPath = `${dir}/${name}`
        const itemPath = relativePath ? `${relativePath}/${name}` : `/${name}`

        try {
          const stat = await this.fs.promises.stat(fullPath)

          if (stat.isDirectory()) {
            const children = await this.buildFileTree(fullPath, itemPath)
            items.push({
              id: this.generateId(),
              name,
              path: itemPath,
              type: 'folder',
              children
            })
          } else {
            items.push({
              id: this.generateId(),
              name,
              path: itemPath,
              type: 'file'
            })
          }
        } catch {
          // Skip files we can't stat
        }
      }
    } catch {
      // Directory might not exist
    }

    return items
  }

  private generateId(): string {
    return `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`
  }

  /**
   * Disconnect from the repository
   */
  async disconnect(): Promise<void> {
    if (this.status.isSyncing) throw new Error('Another Git operation is in progress')
    await this.options.beforeWorkingTreeChange?.()
    if (this.status.isSyncing) throw new Error('Another Git operation is in progress')
    this.stopAutoSync()
    this.conflictReview = null
    this.config = null
    // Disconnect removes credentials; retain the checkout and unsynced work.
    this.status = {
      isConnected: false,
      isSyncing: false,
      ahead: 0,
      behind: 0,
      hasChanges: false,
      hasConflict: false
    }

    if (typeof localStorage !== 'undefined') {
      localStorage.removeItem(this.options.storageKey!)
    }

    this.notifyFileTreeListeners([])
    this.notifyStatusListeners()
  }

  /**
   * Clone the repository
   */
  async clone(): Promise<void> {
    if (!this.config) throw new Error('Not configured')
    if (this.status.isSyncing) throw new Error('Another Git operation is in progress')
    this.status.isSyncing = true
    this.status.error = undefined
    this.notifyStatusListeners()
    try {
      await this.cloneReplacement({ ...this.config }, 10)
      await this.syncFileTree()
      this.status.lastSync = new Date()
    } catch (error) {
      this.status.error = error instanceof Error ? error.message : 'Clone failed'
      throw error
    } finally {
      this.status.isSyncing = false
      this.notifyStatusListeners()
    }
  }

  /**
   * Pull changes from remote
   */
  private async pullRemote(): Promise<void> {
    if (!this.config) throw new Error('Not configured')
    await this.ensureMounted()
    const { git, http } = await loadGitModules()
    await git.pull({
      fs: this.fs,
      http,
      dir: GIT_DIR,
      url: this.getRepoUrl(),
      corsProxy: this.options.corsProxy,
      ref: this.config.branch,
      singleBranch: true,
      author: {
        name: this.config.username || 'Siglum User',
        email: `${this.config.username || 'user'}@siglum.app`
      },
      onAuth: () => ({
        username: this.config!.username || this.config!.token,
        password: this.config!.token
      })
    })

  }

  async pull(): Promise<void> {
    if (!this.config) throw new Error('Not configured')

    if (this.status.isSyncing) throw new Error('Another Git operation is in progress')
    this.status.isSyncing = true
    this.status.error = undefined
    this.notifyStatusListeners()

    try {
      await this.pullRemote()

      this.status.lastSync = new Date()
      this.status.behind = 0
    } catch (error) {
      this.status.error = error instanceof Error ? error.message : 'Pull failed'
      throw error
    } finally {
      this.status.isSyncing = false
      this.notifyStatusListeners()
    }
  }

  /**
   * Push changes to remote
   */
  private async pushRemote(): Promise<void> {
    if (!this.config) throw new Error('Not configured')
    await this.ensureMounted()
    const { git, http } = await loadGitModules()
    await git.push({
      fs: this.fs,
      http,
      dir: GIT_DIR,
      url: this.getRepoUrl(),
      corsProxy: this.options.corsProxy,
      remote: 'origin',
      ref: this.config.branch,
      onAuth: () => ({
        username: this.config!.username || this.config!.token,
        password: this.config!.token
      })
    })

  }

  async push(): Promise<void> {
    if (!this.config) throw new Error('Not configured')
    if (this.status.isSyncing) throw new Error('Another Git operation is in progress')

    this.status.isSyncing = true
    this.status.error = undefined
    this.notifyStatusListeners()

    try {
      await this.pushRemote()

      this.status.lastSync = new Date()
      this.status.ahead = 0
    } catch (error) {
      this.status.error = error instanceof Error ? error.message : 'Push failed'
      throw error
    } finally {
      this.status.isSyncing = false
      this.notifyStatusListeners()
    }
  }

  /**
   * Commit changes
   */
  async commit(message: string): Promise<void> {
    if (!this.config) throw new Error('Not configured')
    if (this.status.isSyncing) throw new Error('Another Git operation is in progress')

    this.pendingWorktreeWrites++
    try {
      await this.ensureMounted()
      const { git } = await loadGitModules()

      // Stage all changes including deletions
      const statusMatrix = await git.statusMatrix({ fs: this.fs, dir: GIT_DIR })
      for (const [filepath, _head, workdir, stage] of statusMatrix) {
        if (filepath.startsWith('.git')) continue
        if (workdir !== stage) {
          if (workdir === 0) {
            // File was deleted - stage the deletion
            await git.remove({ fs: this.fs, dir: GIT_DIR, filepath })
          } else {
            // File was added or modified
            await git.add({ fs: this.fs, dir: GIT_DIR, filepath })
          }
        }
      }

      await git.commit({
        fs: this.fs,
        dir: GIT_DIR,
        message,
        author: {
          name: this.config.username || 'Siglum User',
          email: `${this.config.username || 'user'}@siglum.app`
        }
      })

      this.status.ahead++
      this.status.hasChanges = false
      this.notifyStatusListeners()
    } catch (error) {
      this.status.error = error instanceof Error ? error.message : 'Commit failed'
      throw error
    } finally {
      this.pendingWorktreeWrites--
    }
  }

  /**
   * Get list of changed files
   */
  async getChanges(): Promise<FileChange[]> {
    await this.ensureMounted()
    const { git } = await loadGitModules()
    const statusMatrix = await git.statusMatrix({ fs: this.fs, dir: GIT_DIR })
    const changes: FileChange[] = []

    for (const [filepath, head, workdir, stage] of statusMatrix) {
      if (filepath.startsWith('.git')) continue

      if (head === 0 && workdir !== 0) {
        changes.push({ path: filepath, status: stage === 0 ? 'untracked' : 'added' })
      } else if (head !== 0 && workdir === 0) {
        changes.push({ path: filepath, status: 'deleted' })
      } else if (workdir !== head) {
        changes.push({ path: filepath, status: 'modified' })
      }
    }

    this.status.hasChanges = changes.length > 0
    this.notifyStatusListeners()

    return changes
  }

  /**
   * Check for remote changes
   */
  async checkRemote(): Promise<{ hasRemoteChanges: boolean; hasLocalChanges: boolean }> {
    if (!this.config) throw new Error('Not configured')

    try {
      await this.ensureMounted()
      const localChanges = await this.getChanges()

      const { git, http } = await loadGitModules()
      await git.fetch({
        fs: this.fs,
        http,
        dir: GIT_DIR,
        url: this.getRepoUrl(),
        remote: 'origin',
        ref: this.config.branch,
        singleBranch: true,
        corsProxy: this.options.corsProxy,
        onAuth: () => ({
          username: this.config!.username || this.config!.token,
          password: this.config!.token
        })
      })

      const localHead = await git.resolveRef({ fs: this.fs, dir: GIT_DIR, ref: 'HEAD' })
      const remoteHead = await git.resolveRef({ fs: this.fs, dir: GIT_DIR, ref: `refs/remotes/origin/${this.config.branch}` })

      const hasRemoteChanges = localHead !== remoteHead
      const hasLocalChanges = localChanges.length > 0

      this.status.remoteStatus = 'ok'
      this.status.needsAuthentication = false
      this.status.error = undefined
      this.status.hasConflict = hasRemoteChanges && hasLocalChanges
      this.notifyStatusListeners()

      return { hasRemoteChanges, hasLocalChanges }
    } catch (error) {
      this.recordRemoteError(error)
      throw error
    }
  }

  /**
   * Sync with remote (pull, commit local changes, push)
   * Returns info about what changed for the UI to react to
   */
  async sync(): Promise<{ pulledFiles?: string[], hasConflict?: boolean, conflictingFiles?: ConflictingFile[] }> {
    console.log('[GitService] sync() called')
    if (!this.config) {
      throw new Error('Not configured')
    }
    if (this.status.isSyncing) {
      throw new Error('Another Git operation is in progress')
    }

    this.status.isSyncing = true
    this.status.error = undefined
    this.notifyStatusListeners()

    try {
      const { hasRemoteChanges, hasLocalChanges } = await this.checkRemote()
      console.log('[GitService] sync() - hasRemoteChanges:', hasRemoteChanges, 'hasLocalChanges:', hasLocalChanges)

      // Get list of files that would be affected
      const localChanges = await this.getChanges()
      const localChangedFiles = new Set(localChanges.map(c => c.path))

      if (hasRemoteChanges) {
        // Fetch and check which remote files changed
        const { git, http } = await loadGitModules()

        await git.fetch({
          fs: this.fs,
          http,
          dir: GIT_DIR,
          url: this.getRepoUrl(),
          ref: this.config.branch,
          singleBranch: true,
          corsProxy: this.options.corsProxy,
          onAuth: () => ({
            username: this.config!.username || this.config!.token,
            password: this.config!.token
          })
        })

        const localHead = await git.resolveRef({ fs: this.fs, dir: GIT_DIR, ref: 'HEAD' })
        const remoteHead = await git.resolveRef({
          fs: this.fs,
          dir: GIT_DIR,
          ref: `refs/remotes/origin/${this.config.branch}`
        })

        // Get files that changed on remote
        const remoteChangedFiles = await this.getChangedFilesBetweenCommits(localHead, remoteHead)

        // Check for actual conflicts (same file edited locally and remotely)
        const conflictingFilePaths = remoteChangedFiles.filter(f => localChangedFiles.has(f))

        if (conflictingFilePaths.length > 0) {
          // Real conflict - same files edited on same branch (different device)
          // Calculate line differences for each conflicting file
          const conflictingFiles: ConflictingFile[] = await Promise.all(
            conflictingFilePaths.map(async (path) => {
              const linesChanged = await this.getLineDiffCount(localHead, remoteHead, path)
              return { path, linesChanged }
            })
          )

          this.status.hasConflict = true
          this.status.conflictingFiles = conflictingFiles
          this.status.conflictSource = 'same-branch'
          this.notifyStatusListeners()
          return { hasConflict: true, conflictingFiles }
        }

        // No conflict - safe to auto-merge
        // First commit local changes if any (before pulling)
        if (hasLocalChanges) {
          await this.commitAllChanges('Auto-save from Siglum')
        }

        // Pull remote changes (this will merge with our commit)
        await this.pullRemote()
        await this.syncFileTree()

        // Push merged result (our changes + pulled changes)
        await this.pushRemote()

        this.status.hasConflict = false
        this.status.conflictingFiles = undefined
        this.status.conflictSource = undefined
        this.status.ahead = 0
        this.status.behind = 0
        this.status.lastSync = new Date()

        return { pulledFiles: remoteChangedFiles }
      }

      // No remote changes, just handle local
      if (hasLocalChanges) {
        console.log('[GitService] sync() - committing local changes')
        await this.commitAllChanges('Auto-save from Siglum')
        console.log('[GitService] sync() - pushing')
        await this.pushRemote()
        console.log('[GitService] sync() - push complete')
      } else if (this.status.ahead > 0) {
        console.log('[GitService] sync() - no local changes but ahead, pushing')
        await this.pushRemote()
      } else {
        console.log('[GitService] sync() - nothing to do')
      }

      this.status.hasConflict = false
      this.status.conflictingFiles = undefined
      this.status.conflictSource = undefined
      this.status.ahead = 0
      this.status.behind = 0
      this.status.lastSync = new Date()
      return {}
    } catch (error) {
      this.recordRemoteError(error)
      throw error
    } finally {
      this.status.isSyncing = false
      this.notifyStatusListeners()
    }
  }

  /**
   * Get list of files that changed between two commits
   */
  private async getChangedFilesBetweenCommits(oid1: string, oid2: string): Promise<string[]> {
    const changedFiles: string[] = []

    try {
      const tree1 = await this.getTreeFiles(oid1)
      const tree2 = await this.getTreeFiles(oid2)

      const allFiles = new Set([...Object.keys(tree1), ...Object.keys(tree2)])

      for (const file of allFiles) {
        if (tree1[file] !== tree2[file]) {
          changedFiles.push(file)
        }
      }
    } catch (error) {
      console.error('[GitService] getChangedFilesBetweenCommits failed:', error)
    }

    return changedFiles
  }

  /**
   * Get the number of lines that differ between two commits for a specific file
   */
  private async getLineDiffCount(oid1: string, oid2: string, filePath: string): Promise<number | undefined> {
    try {
      const { git } = await loadGitModules()

      // Get file content from both commits
      const getFileContent = async (oid: string): Promise<string | null> => {
        try {
          const { blob } = await git.readBlob({
            fs: this.fs,
            dir: GIT_DIR,
            oid,
            filepath: filePath.startsWith('/') ? filePath.slice(1) : filePath
          })
          return new TextDecoder().decode(blob)
        } catch {
          return null
        }
      }

      const content1 = await getFileContent(oid1)
      const content2 = await getFileContent(oid2)

      if (content1 === null || content2 === null) {
        return undefined
      }

      // Simple line diff: count lines that are different
      const lines1 = content1.split('\n')
      const lines2 = content2.split('\n')

      let diffCount = 0
      const maxLen = Math.max(lines1.length, lines2.length)

      for (let i = 0; i < maxLen; i++) {
        if (lines1[i] !== lines2[i]) {
          diffCount++
        }
      }

      return diffCount
    } catch (error) {
      console.error('[GitService] getLineDiffCount failed:', error)
      return undefined
    }
  }

  private async conflictHeads(config: GitConfig) {
    const { git } = await loadGitModules()
    const ref = await git.currentBranch({ fs: this.fs, dir: GIT_DIR, fullname: true })
    if (ref !== `refs/heads/${config.branch}`) throw new Error('The checked-out Git branch changed.')
    const localHead = await git.resolveRef({ fs: this.fs, dir: GIT_DIR, ref })
    const remoteHead = await git.resolveRef({ fs: this.fs, dir: GIT_DIR, ref: `refs/remotes/origin/${config.branch}` })
    return { ref, localHead, remoteHead }
  }

  private async incomingConflictPaths(localHead: string, remoteHead: string): Promise<IncomingConflictPath[]> {
    const { git } = await loadGitModules()
    const paths: IncomingConflictPath[] = []
    await git.walk({
      fs: this.fs, dir: GIT_DIR, trees: [git.TREE({ ref: localHead }), git.TREE({ ref: remoteHead })],
      map: async (path, [before, after]) => {
        if (path === '.') return
        if (before && after && await before.oid() === await after.oid() && await before.mode() === await after.mode()) return null
        const previousType = await before?.type()
        const incomingType = await after?.type()
        if ((previousType === 'tree' && (!after || incomingType === 'tree')) ||
            (incomingType === 'tree' && !before)) return
        if (!safeConflictPath(path) || (before && (previousType !== 'blob' || await before.mode() !== 0o100644)) ||
            (after && (incomingType !== 'blob' || await after.mode() !== 0o100644))) {
          throw new Error(`Resolve this Git file type or directory change outside Siglum: ${path}`)
        }
        paths.push({ path, previous: !!before, incoming: !!after })
      },
    })
    return paths
  }

  private async readConflictBytes(path: string): Promise<ConflictBytes> {
    try {
      const content = await this.fs.promises.readFile(path)
      if (typeof content === 'string') throw new Error(`Expected binary bytes for ${path}`)
      return content
    } catch (error) {
      if ((error as { code?: string }).code === 'ENOENT') return null
      throw error
    }
  }

  /** Review the fetched same-branch changes against the current editor files. */
  async getConflictReview(): Promise<GitConflictReview> {
    if (!this.config) throw new Error('Not configured')
    if (this.status.isSyncing || this.pendingWorktreeWrites) throw new Error('Another Git operation is in progress')
    const connection = this.config
    const config = { ...connection }
    this.status.isSyncing = true
    this.conflictReview = null
    this.notifyStatusListeners()
    try {
      await this.options.beforeWorkingTreeChange?.()
      await this.ensureMounted()
      const { git } = await loadGitModules()
      const { localHead, remoteHead } = await this.conflictHeads(config)
      if (localHead === remoteHead) throw new Error('There are no fetched remote changes to review.')
      if (!await git.isDescendent({ fs: this.fs, dir: GIT_DIR, oid: remoteHead, ancestor: localHead })) {
        throw new Error('The branches diverged. Merge them in Git before applying this review.')
      }

      const affected = await this.incomingConflictPaths(localHead, remoteHead)
      const workingFiles = new Map<string, ConflictBytes>()
      const conflicts: ConflictReviewState['conflicts'] = new Map()
      const files: GitConflictReview['files'] = []
      for (const { path, previous, incoming } of affected) {
        const local = await this.readConflictBytes(`${GIT_DIR}/${path}`)
        workingFiles.set(path, local)
        const base = previous
          ? (await git.readBlob({ fs: this.fs, dir: GIT_DIR, oid: localHead, filepath: path })).blob : null
        if (sameConflictBytes(local, base)) continue
        const remote = incoming
          ? (await git.readBlob({ fs: this.fs, dir: GIT_DIR, oid: remoteHead, filepath: path })).blob : null
        const localText = decodeConflictText(local)
        const remoteText = decodeConflictText(remote)
        const baseText = decodeConflictText(base)
        const isBinary = (local !== null && localText === null) ||
          (remote !== null && remoteText === null) || (base !== null && baseText === null)
        conflicts.set(path, { binary: isBinary })
        files.push({ path, localText, remoteText, baseText, isBinary, localExists: local !== null, remoteExists: remote !== null })
      }
      if (!files.length) throw new Error('There are no conflicting files to review. Sync again.')
      const id = this.generateId()
      if (this.config !== connection || this.config.branch !== config.branch) {
        throw new Error('The repository connection changed during review.')
      }
      this.conflictReview = { id, config, connection, localHead, remoteHead, affected, workingFiles, conflicts }
      return { id, branch: config.branch, localHead, remoteHead, files }
    } finally {
      this.status.isSyncing = false
      this.notifyStatusListeners()
    }
  }

  private async refreshConflictRemote(config: GitConfig): Promise<void> {
    const { git, http } = await loadGitModules()
    await git.fetch({
      fs: this.fs, http, dir: GIT_DIR, url: this.getRepoUrl(config), remote: 'origin',
      ref: config.branch, singleBranch: true, corsProxy: this.options.corsProxy,
      onAuth: () => ({ username: config.username || config.token, password: config.token }),
    })
  }

  private async writeConflictBytes(path: string, bytes: ConflictBytes): Promise<void> {
    if (bytes !== null) {
      await this.fs.promises.writeFile(path, bytes)
    } else {
      try { await this.fs.promises.unlink(path) }
      catch (error) { if ((error as { code?: string }).code !== 'ENOENT') throw error }
    }
  }

  /** Apply reviewed choices locally and leave any retained edits available for the next sync. */
  async applyConflictResolution(reviewId: string, resolutions: GitConflictResolution[]): Promise<void> {
    if (this.status.isSyncing || this.pendingWorktreeWrites) throw new Error('Another Git operation is in progress')
    const review = this.conflictReview
    if (!review || review.id !== reviewId || this.config !== review.connection ||
        this.config.branch !== review.config.branch) {
      throw new Error('The conflict review is stale. Open it again.')
    }
    const choices = new Map<string, GitConflictResolution>()
    for (const resolution of resolutions) {
      const conflict = review.conflicts.get(resolution.path)
      if (!conflict || choices.has(resolution.path) ||
          (resolution.choice !== 'local' && resolution.choice !== 'remote' &&
           (resolution.choice !== 'merged' || conflict.binary || typeof resolution.content !== 'string'))) {
        throw new Error('Choose one valid resolution for every conflicting file.')
      }
      choices.set(resolution.path, resolution)
    }
    if (choices.size !== review.conflicts.size) throw new Error('Resolve every conflicting file before applying.')

    this.status.isSyncing = true
    this.status.error = undefined
    this.notifyStatusListeners()
    try {
      await this.options.beforeWorkingTreeChange?.()
      await this.refreshConflictRemote(review.config)
      const { git } = await loadGitModules()
      const { ref, localHead, remoteHead } = await this.conflictHeads(review.config)
      if (this.config !== review.connection || this.config.branch !== review.config.branch ||
          localHead !== review.localHead || remoteHead !== review.remoteHead) {
        this.conflictReview = null
        throw new Error('A Git revision changed during review. Open the conflict again.')
      }
      const paths = review.affected.map(file => file.path)
      const status = await git.statusMatrix({ fs: this.fs, dir: GIT_DIR, filepaths: paths })
      if (status.some(([path, head, , stage]) => review.workingFiles.has(path) && head !== stage)) {
        throw new Error('Affected files have staged changes. Resolve them in Git before applying this review.')
      }
      const checkout = { fs: this.fs, dir: GIT_DIR, ref: remoteHead, filepaths: paths, noUpdateHead: true, force: true }
      await git.checkout({ ...checkout, dryRun: true })
      const indexPath = `${GIT_DIR}/.git/index`
      const previousIndex = await this.readConflictBytes(indexPath)
      for (const [path, reviewed] of review.workingFiles) {
        if (!sameConflictBytes(reviewed, await this.readConflictBytes(`${GIT_DIR}/${path}`))) {
          this.conflictReview = null
          throw new Error(`The local file changed during review: ${path}. Open the conflict again.`)
        }
      }
      const latest = await this.conflictHeads(review.config)
      if (latest.localHead !== localHead || latest.remoteHead !== remoteHead ||
          !sameConflictBytes(previousIndex, await this.readConflictBytes(indexPath))) {
        this.conflictReview = null
        throw new Error('A Git revision changed during review. Open the conflict again.')
      }

      try {
        await git.checkout(checkout)
        for (const [path, resolution] of choices) {
          if (resolution.choice === 'remote') continue
          const bytes = resolution.choice === 'local' ? review.workingFiles.get(path)! : new TextEncoder().encode(resolution.content)
          await this.writeConflictBytes(`${GIT_DIR}/${path}`, bytes)
        }
        await git.writeRef({ fs: this.fs, dir: GIT_DIR, ref, value: remoteHead, force: true })
      } catch (error) {
        // The checkout is restricted to the paths backed up in the review.
        try {
          for (const [path, bytes] of review.workingFiles) await this.writeConflictBytes(`${GIT_DIR}/${path}`, bytes)
          await this.writeConflictBytes(indexPath, previousIndex)
          if (await git.resolveRef({ fs: this.fs, dir: GIT_DIR, ref }) === remoteHead) {
            await git.writeRef({ fs: this.fs, dir: GIT_DIR, ref, value: localHead, force: true })
          }
        } catch (rollbackError) {
          throw new Error('Could not finish or fully restore the local conflict resolution.', { cause: rollbackError })
        }
        throw error
      }

      this.conflictReview = null
      this.status.hasConflict = false
      this.status.conflictingFiles = undefined
      this.status.conflictSource = undefined
      this.status.ahead = 0
      this.status.behind = 0
      await this.syncFileTree()
      await this.getChanges()
    } finally {
      this.status.isSyncing = false
      this.notifyStatusListeners()
    }
  }

  /**
   * Force pull (discard local changes)
   */
  async forcePull(): Promise<void> {
    if (!this.config) return
    if (this.status.isSyncing) throw new Error('Another Git operation is in progress')
    this.status.isSyncing = true
    this.status.error = undefined
    this.notifyStatusListeners()
    try {
      await this.cloneReplacement({ ...this.config }, 1)
      await this.syncFileTree()
      this.status.hasConflict = false
      this.status.conflictingFiles = undefined
      this.status.conflictSource = undefined
      this.status.hasChanges = false
      this.status.ahead = 0
      this.status.behind = 0
      this.status.lastSync = new Date()
    } catch (error) {
      this.status.error = error instanceof Error ? error.message : 'Pull failed'
      throw error
    } finally {
      this.status.isSyncing = false
      this.notifyStatusListeners()
    }
  }

  /** Restore the saved checkout after an interrupted replacement. */
  async recoverCheckout(): Promise<void> {
    if (this.status.isSyncing) throw new Error('Another Git operation is in progress')
    this.status.isSyncing = true
    this.status.error = undefined
    this.notifyStatusListeners()
    try {
      await this.ensureMounted()
      await recoverRepository()
      await this.syncFileTree()
    } catch (error) {
      this.status.error = error instanceof Error ? error.message : 'Recovery failed'
      throw error
    } finally {
      this.status.isSyncing = false
      this.notifyStatusListeners()
    }
  }

  /**
   * Force push (overwrite remote)
   */
  async forcePush(): Promise<void> {
    if (!this.config) return

    if (this.status.isSyncing) throw new Error('Another Git operation is in progress')
    this.status.isSyncing = true
    this.notifyStatusListeners()

    try {
      const changes = await this.getChanges()
      if (changes.length > 0) {
        await this.commitAllChanges('Auto-save from Siglum')
      }

      const { git, http } = await loadGitModules()
      await git.push({
        fs: this.fs,
        http,
        dir: GIT_DIR,
        remote: 'origin',
        ref: this.config.branch,
        force: true,
        corsProxy: this.options.corsProxy,
        onAuth: () => ({
          username: this.config!.username || this.config!.token,
          password: this.config!.token
        })
      })

      this.status.hasConflict = false
      this.status.lastSync = new Date()
    } catch (error) {
      this.status.error = error instanceof Error ? error.message : 'Push failed'
    } finally {
      this.status.isSyncing = false
      this.notifyStatusListeners()
    }
  }

  private async commitAllChanges(message: string): Promise<void> {
    if (!this.config) return

    try {
      const { git } = await loadGitModules()
      const statusMatrix = await git.statusMatrix({ fs: this.fs, dir: GIT_DIR })

      for (const [filepath, _head, workdir, stage] of statusMatrix) {
        if (filepath.startsWith('.git')) continue

        if (workdir !== stage) {
          if (workdir === 0) {
            await git.remove({ fs: this.fs, dir: GIT_DIR, filepath })
          } else {
            await git.add({ fs: this.fs, dir: GIT_DIR, filepath })
          }
        }
      }

      await git.commit({
        fs: this.fs,
        dir: GIT_DIR,
        message,
        author: {
          name: this.config.username || 'Siglum User',
          email: `${this.config.username || 'user'}@siglum.app`
        }
      })

      this.status.ahead++
      this.status.hasChanges = false
    } catch (error) {
      console.error('Commit failed:', error)
    }
  }

  /**
   * Write a file to the git repo
   */
  async writeFile(path: string, content: string): Promise<void> {
    await this.ensureMounted()
    const fullPath = path.startsWith('/') ? `${GIT_DIR}${path}` : `${GIT_DIR}/${path}`
    await this.fs.promises.writeFile(fullPath, content)
    this.status.hasChanges = true
    this.notifyStatusListeners()
  }

  /**
   * Read a file from the git repo
   */
  async readFile(path: string): Promise<string> {
    await this.ensureMounted()
    const fullPath = path.startsWith('/') ? `${GIT_DIR}${path}` : `${GIT_DIR}/${path}`
    const content = await this.fs.promises.readFile(fullPath, { encoding: 'utf8' })
    return content as string
  }

  /**
   * Get file content by path
   */
  async getFileContent(filename: string): Promise<string | null> {
    try {
      return await this.readFile(filename)
    } catch {
      // Try searching by filename if direct path fails
      const files = await this.findFilesByName(filename, GIT_DIR)
      if (files.length > 0) {
        const relativePath = files[0].replace(GIT_DIR, '')
        return await this.readFile(relativePath)
      }
      return null
    }
  }

  private async findFilesByName(name: string, dir: string): Promise<string[]> {
    const results: string[] = []

    try {
      const entries = await this.fs.promises.readdir(dir)

      for (const entry of entries) {
        if (entry === '.git') continue

        const fullPath = `${dir}/${entry}`
        const stat = await this.fs.promises.stat(fullPath)

        if (stat.isDirectory()) {
          const subResults = await this.findFilesByName(name, fullPath)
          results.push(...subResults)
        } else if (entry === name || fullPath.endsWith(`/${name}`)) {
          results.push(fullPath)
        }
      }
    } catch {
      // Ignore errors
    }

    return results
  }

  /**
   * List files in a directory
   */
  async listFiles(path: string = '/'): Promise<string[]> {
    await this.ensureMounted()
    const fullPath = path === '/' ? GIT_DIR : `${GIT_DIR}${path}`
    return this.fs.promises.readdir(fullPath)
  }

  private startAutoSync(): void {
    this.stopAutoSync()

    if (!this.config) return

    this.startRemoteCheck()

    if (this.config.syncInterval === 'manual') return

    const intervals: Record<string, number> = {
      '5min': 5 * 60 * 1000,
      '15min': 15 * 60 * 1000,
      '30min': 30 * 60 * 1000,
      '1hour': 60 * 60 * 1000
    }

    const interval = intervals[this.config.syncInterval]
    if (interval && typeof window !== 'undefined') {
      this.syncIntervalId = window.setInterval(() => {
        if (!this.status.needsAuthentication && !this.status.isSyncing) {
          void this.sync().catch(() => { /* Failure is exposed through status. */ })
        }
      }, interval)
    }
  }

  private stopAutoSync(): void {
    if (this.syncIntervalId !== null && typeof window !== 'undefined') {
      window.clearInterval(this.syncIntervalId)
      this.syncIntervalId = null
    }
    this.stopRemoteCheck()
  }

  private startRemoteCheck(): void {
    this.stopRemoteCheck()

    if (!this.config || typeof document === 'undefined') return

    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        this.checkRemoteQuietly()
      }
    }

    document.addEventListener('visibilitychange', handleVisibilityChange)
    this.remoteCheckCleanup = () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange)
    }

    this.checkRemoteQuietly()
  }

  private stopRemoteCheck(): void {
    if (this.remoteCheckCleanup) {
      this.remoteCheckCleanup()
      this.remoteCheckCleanup = null
    }
  }

  private async checkRemoteQuietly(): Promise<void> {
    if (!this.config || this.status.isSyncing || this.status.needsAuthentication) return

    try {
      const { hasRemoteChanges, hasLocalChanges } = await this.checkRemote()

      if (hasRemoteChanges) {
        // Auto-sync in the background - this will merge if no conflicts
        const result = await this.sync()

        // If there was a conflict, status is already updated by sync()
        // If files were pulled, notify listeners with the updated file tree
        if (result.pulledFiles && result.pulledFiles.length > 0) {
          // File tree already synced by sync(), status listeners notified
          // The UI can check status.lastSync to know something changed
        }
      } else {
        this.status.behind = 0
        this.status.hasChanges = hasLocalChanges
        this.notifyStatusListeners()
      }
    } catch {
      // checkRemote/sync publish the failure; avoid an unhandled background rejection.
    }
  }

  /**
   * Update sync interval
   */
  updateSyncInterval(interval: GitConfig['syncInterval']): void {
    if (this.config) {
      this.config.syncInterval = interval
      this.saveConfig()
      this.startAutoSync()
    }
  }

  // ============================================================================
  // COLLABORATIVE EDITING - Branch-per-User Model
  // ============================================================================

  private notifyCollaboratorsListeners(collaborators: Collaborator[]): void {
    this.collaboratorsListeners.forEach(listener => listener(collaborators))
  }

  /**
   * Subscribe to collaborators list changes
   */
  subscribeCollaborators(listener: CollaboratorsListener): () => void {
    this.collaboratorsListeners.add(listener)
    // Immediately fetch and notify
    this.listCollaborators().then(collaborators => listener(collaborators))
    return () => this.collaboratorsListeners.delete(listener)
  }

  /**
   * Get the draft branch name for a user
   */
  getDraftBranchName(username?: string): string {
    const user = username || this.config?.username || this.extractUsernameFromRepo() || 'anonymous'
    return `draft/${user}`
  }

  /**
   * Extract username from repo URL (e.g., "adam-weber/resume" -> "adam-weber")
   */
  private extractUsernameFromRepo(): string | null {
    if (!this.config?.repoUrl) return null
    // Handle formats like "username/repo" or "https://github.com/username/repo"
    const match = this.config.repoUrl.match(/(?:github\.com\/)?([^\/]+)\//)
    return match ? match[1] : null
  }

  /**
   * Start collaborative editing mode - creates/switches to user's draft branch
   */
  async startCollaborativeEditing(): Promise<void> {
    if (!this.config) throw new Error('Not connected')
    // Reuse the safe branch switch: an existing draft is checked out, or a new
    // draft starts from the current commit. Never reclone over local work.
    await this.switchBranch(this.getDraftBranchName())
    this.startPresenceUpdates()
    this.startCollaboratorPolling()
  }

  /**
   * List all collaborators (users with draft/* branches)
   */
  async listCollaborators(): Promise<Collaborator[]> {
    if (!this.config) return []

    try {
      const { git, http } = await loadGitModules()

      // Fetch all remote refs
      const remoteInfo = await git.getRemoteInfo({
        http,
        url: this.getRepoUrl(),
        corsProxy: this.options.corsProxy,
        onAuth: () => ({
          username: this.config!.username || this.config!.token,
          password: this.config!.token
        })
      })

      const collaborators: Collaborator[] = []
      const currentDraftBranch = this.getDraftBranchName()
      const refs = remoteInfo.refs?.heads || {}

      for (const branchName of Object.keys(refs)) {
        if (branchName.startsWith('draft/')) {
          const username = branchName.replace('draft/', '')

          collaborators.push({
            username,
            branch: branchName,
            isCurrentUser: branchName === currentDraftBranch,
            lastActivity: undefined, // Would need additional API call to get commit info
            lastCommit: undefined
          })
        }
      }

      return collaborators
    } catch (error) {
      console.error('[GitService] listCollaborators failed:', error)
      return []
    }
  }

  /**
   * Get diff between current branch and another collaborator's branch
   */
  async getCollaboratorDiff(collaboratorBranch: string): Promise<BranchDiff> {
    if (!this.config) throw new Error('Not connected')

    const diff: BranchDiff = {
      myOnly: [],
      theirOnly: [],
      conflicting: [],
      theirModified: []
    }

    try {
      const { git, http } = await loadGitModules()

      // Fetch the collaborator's branch
      await git.fetch({
        fs: this.fs,
        http,
        dir: GIT_DIR,
        url: this.getRepoUrl(),
        ref: collaboratorBranch,
        singleBranch: true,
        depth: 10,
        corsProxy: this.options.corsProxy,
        onAuth: () => ({
          username: this.config!.username || this.config!.token,
          password: this.config!.token
        })
      })

      // Get trees for both branches
      const myCommit = await git.resolveRef({ fs: this.fs, dir: GIT_DIR, ref: 'HEAD' })
      const theirCommit = await git.resolveRef({
        fs: this.fs,
        dir: GIT_DIR,
        ref: `refs/remotes/origin/${collaboratorBranch}`
      })

      // Find common ancestor (merge-base)
      const [baseCommit] = await git.findMergeBase({
        fs: this.fs,
        dir: GIT_DIR,
        oids: [myCommit, theirCommit]
      })

      if (!baseCommit) {
        // No common ancestor, treat everything as theirs
        return diff
      }

      // Compare trees using TREE walk
      const myTree = await this.getTreeFiles(myCommit)
      const theirTree = await this.getTreeFiles(theirCommit)
      const baseTree = await this.getTreeFiles(baseCommit)

      // Compute differences
      const allFiles = new Set([...Object.keys(myTree), ...Object.keys(theirTree), ...Object.keys(baseTree)])

      for (const file of allFiles) {
        const myHash = myTree[file]
        const theirHash = theirTree[file]
        const baseHash = baseTree[file]

        if (myHash && !theirHash && !baseHash) {
          // File only in my branch (I added it)
          diff.myOnly.push(file)
        } else if (!myHash && theirHash && !baseHash) {
          // File only in their branch (they added it)
          diff.theirOnly.push(file)
        } else if (myHash !== baseHash && theirHash !== baseHash && myHash !== theirHash) {
          // Both modified differently
          diff.conflicting.push(file)
        } else if (myHash === baseHash && theirHash !== baseHash) {
          // Only they modified
          diff.theirModified.push(file)
        }
      }

      return diff
    } catch (error) {
      console.error('[GitService] getCollaboratorDiff failed:', error)
      return diff
    }
  }

  private async getTreeFiles(commitOid: string): Promise<Record<string, string>> {
    const files: Record<string, string> = {}

    try {
      const { git } = await loadGitModules()

      await git.walk({
        fs: this.fs,
        dir: GIT_DIR,
        trees: [git.TREE({ ref: commitOid })],
        map: async (filepath, [entry]) => {
          if (entry && (await entry.type()) === 'blob') {
            files[filepath] = await entry.oid()
          }
          return undefined
        }
      })
    } catch {
      // Ignore errors
    }

    return files
  }

  /**
   * Merge changes from a collaborator's branch into current branch
   */
  async mergeFromCollaborator(collaboratorBranch: string, files?: string[]): Promise<void> {
    if (!this.config) throw new Error('Not connected')
    if (this.status.isSyncing) throw new Error('Another Git operation is in progress')

    this.status.isSyncing = true
    this.notifyStatusListeners()

    try {
      const { git, http } = await loadGitModules()

      // Fetch their branch
      await git.fetch({
        fs: this.fs,
        http,
        dir: GIT_DIR,
        url: this.getRepoUrl(),
        ref: collaboratorBranch,
        singleBranch: true,
        depth: 10,
        corsProxy: this.options.corsProxy,
        onAuth: () => ({
          username: this.config!.username || this.config!.token,
          password: this.config!.token
        })
      })

      if (files && files.length > 0) {
        // Cherry-pick specific files
        const theirCommit = await git.resolveRef({
          fs: this.fs,
          dir: GIT_DIR,
          ref: `refs/remotes/origin/${collaboratorBranch}`
        })

        for (const filepath of files) {
          try {
            // Read file from their commit
            const { blob } = await git.readBlob({
              fs: this.fs,
              dir: GIT_DIR,
              oid: theirCommit,
              filepath
            })

            // Write to working directory
            const content = new TextDecoder().decode(blob)
            await this.writeFile(`/${filepath}`, content)
          } catch (e) {
            console.warn(`Failed to merge file ${filepath}:`, e)
          }
        }

        // Commit the merged files
        await this.commitAllChanges(`Merge files from ${collaboratorBranch}`)
      } else {
        // Full merge
        await git.merge({
          fs: this.fs,
          dir: GIT_DIR,
          ours: this.config.branch,
          theirs: `refs/remotes/origin/${collaboratorBranch}`,
          author: {
            name: this.config.username || 'Siglum User',
            email: `${this.config.username || 'user'}@siglum.app`
          }
        })
      }

      await this.syncFileTree()
      this.status.lastSync = new Date()
    } catch (error) {
      this.status.error = error instanceof Error ? error.message : 'Merge failed'
      throw error
    } finally {
      this.status.isSyncing = false
      this.notifyStatusListeners()
    }
  }

  /**
   * Get file content from a collaborator's branch
   */
  async getCollaboratorFile(collaboratorBranch: string, filepath: string): Promise<string | null> {
    if (!this.config) return null

    try {
      const { git, http } = await loadGitModules()

      // Fetch their branch
      await git.fetch({
        fs: this.fs,
        http,
        dir: GIT_DIR,
        url: this.getRepoUrl(),
        ref: collaboratorBranch,
        singleBranch: true,
        depth: 1,
        corsProxy: this.options.corsProxy,
        onAuth: () => ({
          username: this.config!.username || this.config!.token,
          password: this.config!.token
        })
      })

      const theirCommit = await git.resolveRef({
        fs: this.fs,
        dir: GIT_DIR,
        ref: `refs/remotes/origin/${collaboratorBranch}`
      })

      const { blob } = await git.readBlob({
        fs: this.fs,
        dir: GIT_DIR,
        oid: theirCommit,
        filepath: filepath.startsWith('/') ? filepath.slice(1) : filepath
      })

      return new TextDecoder().decode(blob)
    } catch (error) {
      console.error('[GitService] getCollaboratorFile failed:', error)
      return null
    }
  }

  /**
   * Update presence info (for other collaborators to see)
   */
  async updatePresence(presence: Omit<CollaboratorPresence, 'lastSeen'>): Promise<void> {
    if (!this.config || this.status.isSyncing) return

    const presenceData: CollaboratorPresence = {
      ...presence,
      lastSeen: new Date()
    }

    this.pendingWorktreeWrites++
    try {
      // Write presence to .siglum/presence.json in working directory
      const presencePath = '/.siglum/presence.json'

      // Ensure .siglum directory exists
      try {
        await this.fs.promises.mkdir(`${GIT_DIR}/.siglum`)
      } catch {
        // Directory might already exist
      }

      await this.writeFile(presencePath, JSON.stringify(presenceData, null, 2))

      // Commit and push presence update
      await this.commitAllChanges('Update presence')
      await this.push()
    } catch (error) {
      console.warn('[GitService] updatePresence failed:', error)
    } finally {
      this.pendingWorktreeWrites--
    }
  }

  /**
   * Get presence info from a collaborator's branch
   */
  async getCollaboratorPresence(collaboratorBranch: string): Promise<CollaboratorPresence | null> {
    try {
      const content = await this.getCollaboratorFile(collaboratorBranch, '.siglum/presence.json')
      if (content) {
        const presence = JSON.parse(content)
        presence.lastSeen = new Date(presence.lastSeen)
        return presence
      }
    } catch {
      // No presence file or invalid
    }
    return null
  }

  /**
   * Publish draft to main via PR (uses GitHub API)
   */
  async publishDraft(title: string, body: string): Promise<{ prUrl: string } | null> {
    if (!this.config || this.config.provider !== 'github') {
      throw new Error('Publishing requires GitHub')
    }
    if (this.status.isSyncing) throw new Error('Another Git operation is in progress')

    const draftBranch = this.getDraftBranchName()
    const repoPath = this.config.repoUrl.replace(/^https?:\/\/github\.com\//, '').replace(/\.git$/, '')

    this.pendingWorktreeWrites++
    try {
      // First, ensure all changes are pushed
      const changes = await this.getChanges()
      if (changes.length > 0) {
        await this.commitAllChanges('Final changes before publish')
        await this.push()
      }

      // Create PR via GitHub API
      const response = await fetch(`https://api.github.com/repos/${repoPath}/pulls`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.config.token}`,
          'Accept': 'application/vnd.github+json',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          title,
          body,
          head: draftBranch,
          base: 'main'
        })
      })

      if (!response.ok) {
        const error = await response.json()
        throw new Error(error.message || 'Failed to create pull request')
      }

      const pr = await response.json()
      return { prUrl: pr.html_url }
    } catch (error) {
      console.error('[GitService] publishDraft failed:', error)
      throw error
    } finally {
      this.pendingWorktreeWrites--
    }
  }

  private startPresenceUpdates(): void {
    this.stopPresenceUpdates()

    if (typeof window === 'undefined') return

    // Update presence every 30 seconds
    this.presenceUpdateId = window.setInterval(() => {
      this.updatePresence({ status: 'active' })
    }, 30000)
  }

  private stopPresenceUpdates(): void {
    if (this.presenceUpdateId !== null && typeof window !== 'undefined') {
      window.clearInterval(this.presenceUpdateId)
      this.presenceUpdateId = null
    }
  }

  private startCollaboratorPolling(): void {
    this.stopCollaboratorPolling()

    if (typeof window === 'undefined') return

    // Poll collaborators every 60 seconds
    this.collaboratorsPollId = window.setInterval(async () => {
      const collaborators = await this.listCollaborators()

      // Fetch presence for each collaborator
      for (const collab of collaborators) {
        if (!collab.isCurrentUser) {
          collab.presence = await this.getCollaboratorPresence(collab.branch) || undefined
        }
      }

      this.notifyCollaboratorsListeners(collaborators)
    }, 60000)
  }

  private stopCollaboratorPolling(): void {
    if (this.collaboratorsPollId !== null && typeof window !== 'undefined') {
      window.clearInterval(this.collaboratorsPollId)
      this.collaboratorsPollId = null
    }
  }

  /**
   * Check if currently in collaborative editing mode (on a draft/* branch)
   */
  isCollaborativeMode(): boolean {
    return this.config?.branch?.startsWith('draft/') ?? false
  }

  /**
   * Stop collaborative editing and cleanup
   */
  stopCollaborativeEditing(): void {
    this.stopPresenceUpdates()
    this.stopCollaboratorPolling()
  }
}

// Default instance for convenience
let defaultInstance: GitService | null = null

export function getGitService(options?: GitServiceOptions): GitService {
  if (!defaultInstance) {
    defaultInstance = new GitService(options)
  }
  return defaultInstance
}
