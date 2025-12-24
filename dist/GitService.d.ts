/**
 * GitService - Git operations using OPFS storage
 *
 * Uses OPFS (Origin Private File System) for git repository storage,
 * providing fast, persistent file access without in-memory caching.
 *
 * isomorphic-git is lazily loaded on first git operation to reduce initial bundle.
 */
import type { GitConfig, GitStatus, FileChange, GitStatusListener, FileTreeListener } from './types';
export interface GitServiceOptions {
    /** CORS proxy URL for git operations */
    corsProxy?: string;
    /** Storage key for config persistence */
    storageKey?: string;
    /** Callback when file tree changes */
    onFileTreeChange?: FileTreeListener;
}
export declare class GitService {
    private fs;
    private config;
    private status;
    private syncIntervalId;
    private statusListeners;
    private fileTreeListeners;
    private remoteCheckCleanup;
    private options;
    constructor(options?: GitServiceOptions);
    private loadConfig;
    private saveConfig;
    private notifyStatusListeners;
    private notifyFileTreeListeners;
    /**
     * Subscribe to status changes
     */
    subscribeStatus(listener: GitStatusListener): () => void;
    /**
     * Subscribe to file tree changes
     */
    subscribeFileTree(listener: FileTreeListener): () => void;
    getConfig(): GitConfig | null;
    getStatus(): GitStatus;
    get isConnected(): boolean;
    private getRepoUrl;
    /**
     * Clear the git directory in OPFS
     */
    private clearGitDir;
    /**
     * Connect to a git repository
     */
    connect(config: GitConfig): Promise<void>;
    /**
     * Create a new repository on GitHub
     */
    createRepo(repoName: string, isPrivate?: boolean): Promise<void>;
    /**
     * Switch to a different branch
     */
    switchBranch(branch: string): Promise<void>;
    private syncFileTree;
    private buildFileTree;
    private generateId;
    /**
     * Disconnect from the repository
     */
    disconnect(): Promise<void>;
    /**
     * Clone the repository
     */
    clone(): Promise<void>;
    /**
     * Pull changes from remote
     */
    pull(): Promise<void>;
    /**
     * Push changes to remote
     */
    push(): Promise<void>;
    /**
     * Commit changes
     */
    commit(message: string): Promise<void>;
    /**
     * Get list of changed files
     */
    getChanges(): Promise<FileChange[]>;
    /**
     * Check for remote changes
     */
    checkRemote(): Promise<{
        hasRemoteChanges: boolean;
        hasLocalChanges: boolean;
    }>;
    /**
     * Sync with remote (pull, commit local changes, push)
     */
    sync(): Promise<void>;
    /**
     * Force pull (discard local changes)
     */
    forcePull(): Promise<void>;
    /**
     * Force push (overwrite remote)
     */
    forcePush(): Promise<void>;
    private commitAllChanges;
    /**
     * Write a file to the git repo
     */
    writeFile(path: string, content: string): Promise<void>;
    /**
     * Read a file from the git repo
     */
    readFile(path: string): Promise<string>;
    /**
     * Get file content by path
     */
    getFileContent(filename: string): Promise<string | null>;
    private findFilesByName;
    /**
     * List files in a directory
     */
    listFiles(path?: string): Promise<string[]>;
    private startAutoSync;
    private stopAutoSync;
    private startRemoteCheck;
    private stopRemoteCheck;
    private checkRemoteQuietly;
    /**
     * Update sync interval
     */
    updateSyncInterval(interval: GitConfig['syncInterval']): void;
}
export declare function getGitService(options?: GitServiceOptions): GitService;
//# sourceMappingURL=GitService.d.ts.map