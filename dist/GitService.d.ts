/**
 * GitService - Git operations using siglum-filesystem
 *
 * Uses @siglum/filesystem for git repository storage, providing a unified
 * storage layer shared with the rest of the application.
 *
 * isomorphic-git is lazily loaded on first git operation to reduce initial bundle.
 */
import type { GitConfig, GitStatus, FileChange, GitStatusListener, FileTreeListener, Collaborator, CollaboratorPresence, CollaboratorsListener, BranchDiff, ConflictingFile, GitConflictReview, GitConflictResolution } from './types';
export interface GitServiceOptions {
    /** CORS proxy URL for git operations */
    corsProxy?: string;
    /** Storage key for config persistence */
    storageKey?: string;
    /** Flush editor drafts before switching the working tree. */
    beforeBranchSwitch?: () => Promise<void>;
    /** Flush editor drafts before reconnect, clone, or force pull. */
    beforeWorkingTreeChange?: () => Promise<void>;
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
    private collaboratorsListeners;
    private remoteCheckCleanup;
    private collaboratorsPollId;
    private presenceUpdateId;
    private options;
    private conflictReview;
    private pendingWorktreeWrites;
    constructor(options?: GitServiceOptions);
    private loadConfig;
    private recordRemoteError;
    /** Validate new credentials without cloning or replacing any local files. */
    updateToken(token: string): Promise<void>;
    private saveConfig;
    private notifyStatusListeners;
    private notifyFileTreeListeners;
    /**
     * Subscribe to status changes
     */
    subscribeStatus(listener: GitStatusListener): () => void;
    /**
     * Change the branch (requires reconnect to take effect)
     */
    setBranch(branch: string): void;
    /**
     * Subscribe to file tree changes
     */
    subscribeFileTree(listener: FileTreeListener): () => void;
    getConfig(): GitConfig | null;
    getStatus(): GitStatus;
    get isConnected(): boolean;
    /**
     * Ensure the git filesystem is mounted with its own isolated namespace
     */
    private ensureMounted;
    private getRepoUrl;
    /**
     * Connect to a git repository
     */
    connect(config: GitConfig): Promise<void>;
    private cloneReplacement;
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
    private pullRemote;
    pull(): Promise<void>;
    /**
     * Push changes to remote
     */
    private pushRemote;
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
     * Returns info about what changed for the UI to react to
     */
    sync(): Promise<{
        pulledFiles?: string[];
        hasConflict?: boolean;
        conflictingFiles?: ConflictingFile[];
    }>;
    /**
     * Get list of files that changed between two commits
     */
    private getChangedFilesBetweenCommits;
    /**
     * Get the number of lines that differ between two commits for a specific file
     */
    private getLineDiffCount;
    private conflictHeads;
    private incomingConflictPaths;
    private readConflictBytes;
    /** Review the fetched same-branch changes against the current editor files. */
    getConflictReview(): Promise<GitConflictReview>;
    private refreshConflictRemote;
    private writeConflictBytes;
    /** Apply reviewed choices locally and leave any retained edits available for the next sync. */
    applyConflictResolution(reviewId: string, resolutions: GitConflictResolution[]): Promise<void>;
    /**
     * Force pull (discard local changes)
     */
    forcePull(): Promise<void>;
    /** Restore the saved checkout after an interrupted replacement. */
    recoverCheckout(): Promise<void>;
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
    private notifyCollaboratorsListeners;
    /**
     * Subscribe to collaborators list changes
     */
    subscribeCollaborators(listener: CollaboratorsListener): () => void;
    /**
     * Get the draft branch name for a user
     */
    getDraftBranchName(username?: string): string;
    /**
     * Extract username from repo URL (e.g., "adam-weber/resume" -> "adam-weber")
     */
    private extractUsernameFromRepo;
    /**
     * Start collaborative editing mode - creates/switches to user's draft branch
     */
    startCollaborativeEditing(): Promise<void>;
    /**
     * List all collaborators (users with draft/* branches)
     */
    listCollaborators(): Promise<Collaborator[]>;
    /**
     * Get diff between current branch and another collaborator's branch
     */
    getCollaboratorDiff(collaboratorBranch: string): Promise<BranchDiff>;
    private getTreeFiles;
    /**
     * Merge changes from a collaborator's branch into current branch
     */
    mergeFromCollaborator(collaboratorBranch: string, files?: string[]): Promise<void>;
    /**
     * Get file content from a collaborator's branch
     */
    getCollaboratorFile(collaboratorBranch: string, filepath: string): Promise<string | null>;
    /**
     * Update presence info (for other collaborators to see)
     */
    updatePresence(presence: Omit<CollaboratorPresence, 'lastSeen'>): Promise<void>;
    /**
     * Get presence info from a collaborator's branch
     */
    getCollaboratorPresence(collaboratorBranch: string): Promise<CollaboratorPresence | null>;
    /**
     * Publish draft to main via PR (uses GitHub API)
     */
    publishDraft(title: string, body: string): Promise<{
        prUrl: string;
    } | null>;
    private startPresenceUpdates;
    private stopPresenceUpdates;
    private startCollaboratorPolling;
    private stopCollaboratorPolling;
    /**
     * Check if currently in collaborative editing mode (on a draft/* branch)
     */
    isCollaborativeMode(): boolean;
    /**
     * Stop collaborative editing and cleanup
     */
    stopCollaborativeEditing(): void;
}
export declare function getGitService(options?: GitServiceOptions): GitService;
//# sourceMappingURL=GitService.d.ts.map