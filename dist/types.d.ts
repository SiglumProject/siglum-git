/**
 * Git service types
 */
export interface GitConfig {
    /** Git provider (github for GitHub API features, git for generic git) */
    provider: 'github' | 'git';
    /** Repository URL */
    repoUrl: string;
    /** Branch to use */
    branch: string;
    /** Authentication token */
    token: string;
    /** Username for commits */
    username: string;
    /** Sync interval */
    syncInterval: 'manual' | '5min' | '15min' | '30min' | '1hour';
    /** Conflict resolution strategy */
    conflictResolution: 'local' | 'remote' | 'newest';
    /** Auto-sync enabled */
    autoSync: boolean;
}
export interface GitStatus {
    /** Whether connected to a repository */
    isConnected: boolean;
    /** Whether currently syncing */
    isSyncing: boolean;
    /** Last sync timestamp */
    lastSync?: Date;
    /** Number of commits ahead of remote */
    ahead: number;
    /** Number of commits behind remote */
    behind: number;
    /** Whether there are uncommitted changes */
    hasChanges: boolean;
    /** Whether there's a conflict */
    hasConflict: boolean;
    /** Error message if any */
    error?: string;
}
export interface FileChange {
    path: string;
    status: 'added' | 'modified' | 'deleted' | 'untracked';
}
export interface FileItem {
    id: string;
    name: string;
    /** Full path relative to git root (e.g., '/src/main.tex') */
    path: string;
    type: 'file' | 'folder';
    children?: FileItem[];
}
export type GitStatusListener = (status: GitStatus) => void;
export type FileTreeListener = (files: FileItem[]) => void;
//# sourceMappingURL=types.d.ts.map