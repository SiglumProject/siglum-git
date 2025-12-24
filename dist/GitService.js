/**
 * GitService - Git operations using OPFS storage
 *
 * Uses OPFS (Origin Private File System) for git repository storage,
 * providing fast, persistent file access without in-memory caching.
 *
 * isomorphic-git is lazily loaded on first git operation to reduce initial bundle.
 */
import { Buffer } from 'buffer';
import { createOPFSGitAdapter } from './OPFSGitAdapter';
if (typeof globalThis.Buffer === 'undefined') {
    globalThis.Buffer = Buffer;
}
// Lazy-loaded git modules
let gitModule = null;
let httpModule = null;
async function loadGitModules() {
    if (!gitModule || !httpModule) {
        const [gitImport, httpImport] = await Promise.all([
            import('isomorphic-git'),
            import('isomorphic-git/http/web')
        ]);
        gitModule = gitImport.default;
        httpModule = httpImport.default;
    }
    return { git: gitModule, http: httpModule };
}
// Git directory within OPFS
const GIT_DIR = '/git';
export class GitService {
    constructor(options = {}) {
        this.config = null;
        this.status = {
            isConnected: false,
            isSyncing: false,
            ahead: 0,
            behind: 0,
            hasChanges: false,
            hasConflict: false
        };
        this.syncIntervalId = null;
        this.statusListeners = new Set();
        this.fileTreeListeners = new Set();
        this.remoteCheckCleanup = null;
        this.options = {
            corsProxy: 'https://cors.isomorphic-git.org',
            storageKey: 'siglum-git-config',
            ...options
        };
        this.fs = createOPFSGitAdapter();
        if (options.onFileTreeChange) {
            this.fileTreeListeners.add(options.onFileTreeChange);
        }
        this.loadConfig();
    }
    loadConfig() {
        if (typeof localStorage === 'undefined')
            return;
        const saved = localStorage.getItem(this.options.storageKey);
        if (saved) {
            try {
                this.config = JSON.parse(saved);
                if (this.config?.token) {
                    this.status.isConnected = true;
                    this.startRemoteCheck();
                }
            }
            catch {
                // Invalid config
            }
        }
    }
    saveConfig() {
        if (typeof localStorage === 'undefined')
            return;
        if (this.config) {
            localStorage.setItem(this.options.storageKey, JSON.stringify(this.config));
        }
        else {
            localStorage.removeItem(this.options.storageKey);
        }
    }
    notifyStatusListeners() {
        this.statusListeners.forEach(listener => listener({ ...this.status }));
    }
    notifyFileTreeListeners(files) {
        this.fileTreeListeners.forEach(listener => listener(files));
    }
    /**
     * Subscribe to status changes
     */
    subscribeStatus(listener) {
        this.statusListeners.add(listener);
        listener({ ...this.status });
        return () => this.statusListeners.delete(listener);
    }
    /**
     * Subscribe to file tree changes
     */
    subscribeFileTree(listener) {
        this.fileTreeListeners.add(listener);
        return () => this.fileTreeListeners.delete(listener);
    }
    getConfig() {
        return this.config;
    }
    getStatus() {
        return { ...this.status };
    }
    get isConnected() {
        return this.status.isConnected;
    }
    getRepoUrl() {
        if (!this.config)
            throw new Error('Not configured');
        if (this.config.provider === 'github') {
            const repoPath = this.config.repoUrl.replace(/^https?:\/\/github\.com\//, '').replace(/\.git$/, '');
            const authUser = this.config.username || this.config.token;
            return `https://${authUser}:${this.config.token}@github.com/${repoPath}.git`;
        }
        if (this.config.repoUrl.startsWith('https://') && this.config.token) {
            const url = new URL(this.config.repoUrl);
            url.username = this.config.username || 'git';
            url.password = this.config.token;
            return url.toString();
        }
        return this.config.repoUrl;
    }
    /**
     * Clear the git directory in OPFS
     */
    async clearGitDir() {
        try {
            await this.fs.promises.rmdir(GIT_DIR);
        }
        catch {
            // Directory might not exist
        }
        await this.fs.promises.mkdir(GIT_DIR);
    }
    /**
     * Connect to a git repository
     */
    async connect(config) {
        this.config = config;
        this.status.isSyncing = true;
        this.status.error = undefined;
        this.notifyStatusListeners();
        try {
            await this.clearGitDir();
            const { git, http } = await loadGitModules();
            await git.clone({
                fs: this.fs,
                http,
                dir: GIT_DIR,
                url: this.getRepoUrl(),
                ref: config.branch,
                singleBranch: true,
                depth: 1,
                corsProxy: this.options.corsProxy,
                onAuth: () => ({
                    username: config.username || config.token,
                    password: config.token
                })
            });
            await this.syncFileTree();
            this.status.isConnected = true;
            this.status.lastSync = new Date();
            this.saveConfig();
            this.startAutoSync();
        }
        catch (error) {
            // Check for 404 errors (repo not found)
            const httpError = error;
            const errorMessage = error instanceof Error ? error.message : String(error);
            if (httpError?.data?.statusCode === 404 || errorMessage.includes('404')) {
                this.status.error = 'Repository not found';
                const repoNotFoundError = new Error('REPO_NOT_FOUND');
                repoNotFoundError.repoUrl = config.repoUrl;
                throw repoNotFoundError;
            }
            this.status.error = errorMessage || 'Connection failed';
            this.config = null;
            throw error;
        }
        finally {
            this.status.isSyncing = false;
            this.notifyStatusListeners();
        }
    }
    /**
     * Create a new repository on GitHub
     */
    async createRepo(repoName, isPrivate = true) {
        if (!this.config?.token)
            throw new Error('No token configured');
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
        });
        if (!response.ok) {
            const error = await response.json();
            throw new Error(error.message || 'Failed to create repository');
        }
        await new Promise(resolve => setTimeout(resolve, 1500));
        await this.connect(this.config);
    }
    /**
     * Switch to a different branch
     */
    async switchBranch(branch) {
        if (!this.config)
            throw new Error('Not connected');
        this.status.isSyncing = true;
        this.status.error = undefined;
        this.notifyStatusListeners();
        try {
            await this.clearGitDir();
            const { git, http } = await loadGitModules();
            let branchExists = true;
            try {
                await git.clone({
                    fs: this.fs,
                    http,
                    dir: GIT_DIR,
                    url: this.getRepoUrl(),
                    ref: branch,
                    singleBranch: true,
                    depth: 1,
                    corsProxy: this.options.corsProxy,
                    onAuth: () => ({
                        username: this.config.username || this.config.token,
                        password: this.config.token
                    })
                });
            }
            catch {
                branchExists = false;
            }
            if (!branchExists) {
                const currentBranch = this.config.branch;
                await this.clearGitDir();
                await git.clone({
                    fs: this.fs,
                    http,
                    dir: GIT_DIR,
                    url: this.getRepoUrl(),
                    ref: currentBranch,
                    singleBranch: true,
                    depth: 1,
                    corsProxy: this.options.corsProxy,
                    onAuth: () => ({
                        username: this.config.username || this.config.token,
                        password: this.config.token
                    })
                });
                await git.branch({ fs: this.fs, dir: GIT_DIR, ref: branch });
                await git.checkout({ fs: this.fs, dir: GIT_DIR, ref: branch });
                await git.push({
                    fs: this.fs,
                    http,
                    dir: GIT_DIR,
                    remote: 'origin',
                    ref: branch,
                    corsProxy: this.options.corsProxy,
                    onAuth: () => ({
                        username: this.config.username || this.config.token,
                        password: this.config.token
                    })
                });
            }
            this.config.branch = branch;
            this.saveConfig();
            await this.syncFileTree();
            this.status.lastSync = new Date();
        }
        catch (error) {
            this.status.error = error instanceof Error ? error.message : 'Branch switch failed';
            throw error;
        }
        finally {
            this.status.isSyncing = false;
            this.notifyStatusListeners();
        }
    }
    async syncFileTree() {
        const fileTree = await this.buildFileTree(GIT_DIR);
        this.notifyFileTreeListeners(fileTree);
    }
    async buildFileTree(dir, relativePath = '') {
        const items = [];
        try {
            const entries = await this.fs.promises.readdir(dir);
            for (const name of entries) {
                if (name === '.git')
                    continue;
                const fullPath = `${dir}/${name}`;
                const itemPath = relativePath ? `${relativePath}/${name}` : `/${name}`;
                try {
                    const stat = await this.fs.promises.stat(fullPath);
                    if (stat.isDirectory()) {
                        const children = await this.buildFileTree(fullPath, itemPath);
                        items.push({
                            id: this.generateId(),
                            name,
                            path: itemPath,
                            type: 'folder',
                            children
                        });
                    }
                    else {
                        items.push({
                            id: this.generateId(),
                            name,
                            path: itemPath,
                            type: 'file'
                        });
                    }
                }
                catch {
                    // Skip files we can't stat
                }
            }
        }
        catch {
            // Directory might not exist
        }
        return items;
    }
    generateId() {
        return `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    }
    /**
     * Disconnect from the repository
     */
    async disconnect() {
        this.stopAutoSync();
        this.config = null;
        await this.clearGitDir();
        this.status = {
            isConnected: false,
            isSyncing: false,
            ahead: 0,
            behind: 0,
            hasChanges: false,
            hasConflict: false
        };
        if (typeof localStorage !== 'undefined') {
            localStorage.removeItem(this.options.storageKey);
        }
        this.notifyFileTreeListeners([]);
        this.notifyStatusListeners();
    }
    /**
     * Clone the repository
     */
    async clone() {
        if (!this.config)
            throw new Error('Not configured');
        this.status.isSyncing = true;
        this.status.error = undefined;
        this.notifyStatusListeners();
        try {
            await this.clearGitDir();
            const { git, http } = await loadGitModules();
            await git.clone({
                fs: this.fs,
                http,
                dir: GIT_DIR,
                url: this.getRepoUrl(),
                ref: this.config.branch,
                singleBranch: true,
                depth: 10,
                onAuth: () => ({
                    username: this.config.username || this.config.token,
                    password: this.config.token
                })
            });
            this.status.lastSync = new Date();
        }
        catch (error) {
            this.status.error = error instanceof Error ? error.message : 'Clone failed';
            throw error;
        }
        finally {
            this.status.isSyncing = false;
            this.notifyStatusListeners();
        }
    }
    /**
     * Pull changes from remote
     */
    async pull() {
        if (!this.config)
            throw new Error('Not configured');
        this.status.isSyncing = true;
        this.status.error = undefined;
        this.notifyStatusListeners();
        try {
            const { git, http } = await loadGitModules();
            await git.pull({
                fs: this.fs,
                http,
                dir: GIT_DIR,
                ref: this.config.branch,
                singleBranch: true,
                author: {
                    name: this.config.username || 'Siglum User',
                    email: `${this.config.username || 'user'}@siglum.app`
                },
                onAuth: () => ({
                    username: this.config.username || this.config.token,
                    password: this.config.token
                })
            });
            this.status.lastSync = new Date();
            this.status.behind = 0;
        }
        catch (error) {
            this.status.error = error instanceof Error ? error.message : 'Pull failed';
            throw error;
        }
        finally {
            this.status.isSyncing = false;
            this.notifyStatusListeners();
        }
    }
    /**
     * Push changes to remote
     */
    async push() {
        if (!this.config)
            throw new Error('Not configured');
        this.status.isSyncing = true;
        this.status.error = undefined;
        this.notifyStatusListeners();
        try {
            const { git, http } = await loadGitModules();
            await git.push({
                fs: this.fs,
                http,
                dir: GIT_DIR,
                remote: 'origin',
                ref: this.config.branch,
                onAuth: () => ({
                    username: this.config.username || this.config.token,
                    password: this.config.token
                })
            });
            this.status.lastSync = new Date();
            this.status.ahead = 0;
        }
        catch (error) {
            this.status.error = error instanceof Error ? error.message : 'Push failed';
            throw error;
        }
        finally {
            this.status.isSyncing = false;
            this.notifyStatusListeners();
        }
    }
    /**
     * Commit changes
     */
    async commit(message) {
        if (!this.config)
            throw new Error('Not configured');
        try {
            const { git } = await loadGitModules();
            await git.add({ fs: this.fs, dir: GIT_DIR, filepath: '.' });
            await git.commit({
                fs: this.fs,
                dir: GIT_DIR,
                message,
                author: {
                    name: this.config.username || 'Siglum User',
                    email: `${this.config.username || 'user'}@siglum.app`
                }
            });
            this.status.ahead++;
            this.status.hasChanges = false;
            this.notifyStatusListeners();
        }
        catch (error) {
            this.status.error = error instanceof Error ? error.message : 'Commit failed';
            throw error;
        }
    }
    /**
     * Get list of changed files
     */
    async getChanges() {
        try {
            const { git } = await loadGitModules();
            const statusMatrix = await git.statusMatrix({ fs: this.fs, dir: GIT_DIR });
            const changes = [];
            for (const [filepath, head, workdir, stage] of statusMatrix) {
                if (filepath.startsWith('.git'))
                    continue;
                // Status values: 0=absent, 1=same as HEAD, 2=different from HEAD
                if (head === 0 && workdir === 2 && stage === 0) {
                    changes.push({ path: filepath, status: 'untracked' });
                }
                else if (head === 0 && workdir === 2 && stage === 2) {
                    changes.push({ path: filepath, status: 'added' });
                }
                else if (head === 1 && workdir === 2 && stage === 1) {
                    changes.push({ path: filepath, status: 'modified' });
                }
                else if (head === 1 && workdir === 0 && stage === 0) {
                    changes.push({ path: filepath, status: 'deleted' });
                }
            }
            this.status.hasChanges = changes.length > 0;
            this.notifyStatusListeners();
            return changes;
        }
        catch {
            return [];
        }
    }
    /**
     * Check for remote changes
     */
    async checkRemote() {
        if (!this.config)
            return { hasRemoteChanges: false, hasLocalChanges: false };
        try {
            const localChanges = await this.getChanges();
            const { git, http } = await loadGitModules();
            await git.fetch({
                fs: this.fs,
                http,
                dir: GIT_DIR,
                remote: 'origin',
                ref: this.config.branch,
                singleBranch: true,
                corsProxy: this.options.corsProxy,
                onAuth: () => ({
                    username: this.config.username || this.config.token,
                    password: this.config.token
                })
            });
            const localHead = await git.resolveRef({ fs: this.fs, dir: GIT_DIR, ref: 'HEAD' });
            const remoteHead = await git.resolveRef({ fs: this.fs, dir: GIT_DIR, ref: `refs/remotes/origin/${this.config.branch}` });
            const hasRemoteChanges = localHead !== remoteHead;
            const hasLocalChanges = localChanges.length > 0;
            this.status.hasConflict = hasRemoteChanges && hasLocalChanges;
            this.notifyStatusListeners();
            return { hasRemoteChanges, hasLocalChanges };
        }
        catch (error) {
            console.error('[GitService] checkRemote failed:', error);
            return { hasRemoteChanges: false, hasLocalChanges: false };
        }
    }
    /**
     * Sync with remote (pull, commit local changes, push)
     */
    async sync() {
        if (!this.config)
            return;
        if (this.status.isSyncing)
            return;
        this.status.isSyncing = true;
        this.status.error = undefined;
        this.notifyStatusListeners();
        try {
            const { hasRemoteChanges, hasLocalChanges } = await this.checkRemote();
            if (hasRemoteChanges && hasLocalChanges) {
                this.status.hasConflict = true;
                this.status.error = 'Conflict: both local and remote have changes';
                this.notifyStatusListeners();
                return;
            }
            if (hasLocalChanges) {
                await this.commitAllChanges('Auto-save from Siglum');
            }
            if (hasRemoteChanges) {
                await this.pull();
                await this.syncFileTree();
            }
            if (this.status.ahead > 0) {
                await this.push();
            }
            this.status.hasConflict = false;
            this.status.lastSync = new Date();
        }
        catch (error) {
            this.status.error = error instanceof Error ? error.message : 'Sync failed';
        }
        finally {
            this.status.isSyncing = false;
            this.notifyStatusListeners();
        }
    }
    /**
     * Force pull (discard local changes)
     */
    async forcePull() {
        if (!this.config)
            return;
        this.status.isSyncing = true;
        this.notifyStatusListeners();
        try {
            await this.clearGitDir();
            const { git, http } = await loadGitModules();
            await git.clone({
                fs: this.fs,
                http,
                dir: GIT_DIR,
                url: this.getRepoUrl(),
                ref: this.config.branch,
                singleBranch: true,
                depth: 1,
                corsProxy: this.options.corsProxy,
                onAuth: () => ({
                    username: this.config.username || this.config.token,
                    password: this.config.token
                })
            });
            await this.syncFileTree();
            this.status.hasConflict = false;
            this.status.lastSync = new Date();
        }
        catch (error) {
            this.status.error = error instanceof Error ? error.message : 'Pull failed';
        }
        finally {
            this.status.isSyncing = false;
            this.notifyStatusListeners();
        }
    }
    /**
     * Force push (overwrite remote)
     */
    async forcePush() {
        if (!this.config)
            return;
        this.status.isSyncing = true;
        this.notifyStatusListeners();
        try {
            const changes = await this.getChanges();
            if (changes.length > 0) {
                await this.commitAllChanges('Auto-save from Siglum');
            }
            const { git, http } = await loadGitModules();
            await git.push({
                fs: this.fs,
                http,
                dir: GIT_DIR,
                remote: 'origin',
                ref: this.config.branch,
                force: true,
                corsProxy: this.options.corsProxy,
                onAuth: () => ({
                    username: this.config.username || this.config.token,
                    password: this.config.token
                })
            });
            this.status.hasConflict = false;
            this.status.lastSync = new Date();
        }
        catch (error) {
            this.status.error = error instanceof Error ? error.message : 'Push failed';
        }
        finally {
            this.status.isSyncing = false;
            this.notifyStatusListeners();
        }
    }
    async commitAllChanges(message) {
        if (!this.config)
            return;
        try {
            const { git } = await loadGitModules();
            const statusMatrix = await git.statusMatrix({ fs: this.fs, dir: GIT_DIR });
            for (const [filepath, _head, workdir, stage] of statusMatrix) {
                if (filepath.startsWith('.git'))
                    continue;
                if (workdir !== stage) {
                    if (workdir === 0) {
                        await git.remove({ fs: this.fs, dir: GIT_DIR, filepath });
                    }
                    else {
                        await git.add({ fs: this.fs, dir: GIT_DIR, filepath });
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
            });
            this.status.ahead++;
            this.status.hasChanges = false;
        }
        catch (error) {
            console.error('Commit failed:', error);
        }
    }
    /**
     * Write a file to the git repo
     */
    async writeFile(path, content) {
        const fullPath = path.startsWith('/') ? `${GIT_DIR}${path}` : `${GIT_DIR}/${path}`;
        await this.fs.promises.writeFile(fullPath, content);
        this.status.hasChanges = true;
        this.notifyStatusListeners();
    }
    /**
     * Read a file from the git repo
     */
    async readFile(path) {
        const fullPath = path.startsWith('/') ? `${GIT_DIR}${path}` : `${GIT_DIR}/${path}`;
        const content = await this.fs.promises.readFile(fullPath, { encoding: 'utf8' });
        return content;
    }
    /**
     * Get file content by path
     */
    async getFileContent(filename) {
        try {
            return await this.readFile(filename);
        }
        catch {
            // Try searching by filename if direct path fails
            const files = await this.findFilesByName(filename, GIT_DIR);
            if (files.length > 0) {
                const relativePath = files[0].replace(GIT_DIR, '');
                return await this.readFile(relativePath);
            }
            return null;
        }
    }
    async findFilesByName(name, dir) {
        const results = [];
        try {
            const entries = await this.fs.promises.readdir(dir);
            for (const entry of entries) {
                if (entry === '.git')
                    continue;
                const fullPath = `${dir}/${entry}`;
                const stat = await this.fs.promises.stat(fullPath);
                if (stat.isDirectory()) {
                    const subResults = await this.findFilesByName(name, fullPath);
                    results.push(...subResults);
                }
                else if (entry === name || fullPath.endsWith(`/${name}`)) {
                    results.push(fullPath);
                }
            }
        }
        catch {
            // Ignore errors
        }
        return results;
    }
    /**
     * List files in a directory
     */
    async listFiles(path = '/') {
        const fullPath = path === '/' ? GIT_DIR : `${GIT_DIR}${path}`;
        return this.fs.promises.readdir(fullPath);
    }
    startAutoSync() {
        this.stopAutoSync();
        if (!this.config)
            return;
        this.startRemoteCheck();
        if (this.config.syncInterval === 'manual')
            return;
        const intervals = {
            '5min': 5 * 60 * 1000,
            '15min': 15 * 60 * 1000,
            '30min': 30 * 60 * 1000,
            '1hour': 60 * 60 * 1000
        };
        const interval = intervals[this.config.syncInterval];
        if (interval && typeof window !== 'undefined') {
            this.syncIntervalId = window.setInterval(() => this.sync(), interval);
        }
    }
    stopAutoSync() {
        if (this.syncIntervalId !== null && typeof window !== 'undefined') {
            window.clearInterval(this.syncIntervalId);
            this.syncIntervalId = null;
        }
        this.stopRemoteCheck();
    }
    startRemoteCheck() {
        this.stopRemoteCheck();
        if (!this.config || typeof document === 'undefined')
            return;
        const handleVisibilityChange = () => {
            if (document.visibilityState === 'visible') {
                this.checkRemoteQuietly();
            }
        };
        document.addEventListener('visibilitychange', handleVisibilityChange);
        this.remoteCheckCleanup = () => {
            document.removeEventListener('visibilitychange', handleVisibilityChange);
        };
        this.checkRemoteQuietly();
    }
    stopRemoteCheck() {
        if (this.remoteCheckCleanup) {
            this.remoteCheckCleanup();
            this.remoteCheckCleanup = null;
        }
    }
    async checkRemoteQuietly() {
        if (!this.config || this.status.isSyncing)
            return;
        try {
            const { hasRemoteChanges, hasLocalChanges } = await this.checkRemote();
            if (hasRemoteChanges) {
                this.status.behind = 1;
            }
            else {
                this.status.behind = 0;
            }
            this.status.hasChanges = hasLocalChanges;
            this.notifyStatusListeners();
        }
        catch {
            // Silently ignore errors during background check
        }
    }
    /**
     * Update sync interval
     */
    updateSyncInterval(interval) {
        if (this.config) {
            this.config.syncInterval = interval;
            this.saveConfig();
            this.startAutoSync();
        }
    }
}
// Default instance for convenience
let defaultInstance = null;
export function getGitService(options) {
    if (!defaultInstance) {
        defaultInstance = new GitService(options);
    }
    return defaultInstance;
}
//# sourceMappingURL=GitService.js.map