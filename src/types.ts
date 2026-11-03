/**
 * Git service types
 */

export interface GitConfig {
  /** Git provider (github for GitHub API features, git for generic git) */
  provider: 'github' | 'git'
  /** Repository URL */
  repoUrl: string
  /** Branch to use */
  branch: string
  /** Authentication token */
  token: string
  /** Username for commits */
  username: string
  /** Sync interval */
  syncInterval: 'manual' | '5min' | '15min' | '30min' | '1hour'
  /** Conflict resolution strategy */
  conflictResolution: 'local' | 'remote' | 'newest'
  /** Auto-sync enabled */
  autoSync: boolean
}

export interface GitStatus {
  /** Whether connected to a repository */
  isConnected: boolean
  /** Whether currently syncing */
  isSyncing: boolean
  /** Last sync timestamp */
  lastSync?: Date
  /** Number of commits ahead of remote */
  ahead: number
  /** Number of commits behind remote */
  behind: number
  /** Whether there are uncommitted changes */
  hasChanges: boolean
  /** Whether there's a conflict */
  hasConflict: boolean
  /** Files with conflicts (both edited locally and remotely) */
  conflictingFiles?: ConflictingFile[]
  /** Source of conflict: 'same-branch' (same user, different device) or branch name (different user) */
  conflictSource?: 'same-branch' | string
  /** Error message if any */
  error?: string
}

export interface FileChange {
  path: string
  status: 'added' | 'modified' | 'deleted' | 'untracked'
}

export interface ConflictingFile {
  path: string
  linesChanged?: number
}

export interface FileItem {
  id: string
  name: string
  /** Full path relative to git root (e.g., '/src/main.tex') */
  path: string
  type: 'file' | 'folder'
  children?: FileItem[]
}

export type GitStatusListener = (status: GitStatus) => void
export type FileTreeListener = (files: FileItem[]) => void

/**
 * Collaborator information for branch-per-user model
 */
export interface Collaborator {
  /** Username (extracted from branch name) */
  username: string
  /** Branch name (e.g., 'draft/alice') */
  branch: string
  /** Last commit timestamp on this branch */
  lastActivity?: Date
  /** Last commit message */
  lastCommit?: string
  /** Whether this is the current user */
  isCurrentUser: boolean
  /** Presence status from .siglum/presence.json */
  presence?: CollaboratorPresence
}

export interface CollaboratorPresence {
  /** Currently editing file path */
  currentFile?: string
  /** Cursor line number */
  cursorLine?: number
  /** Last seen timestamp */
  lastSeen: Date
  /** User status */
  status: 'active' | 'idle' | 'away'
}

export interface BranchDiff {
  /** Files only in my branch */
  myOnly: string[]
  /** Files only in their branch */
  theirOnly: string[]
  /** Files modified in both (potential conflicts) */
  conflicting: string[]
  /** Files modified only by them */
  theirModified: string[]
}

export type CollaboratorsListener = (collaborators: Collaborator[]) => void
