/**
 * OPFS Git Adapter
 *
 * Provides a Node.js fs-like interface for isomorphic-git using OPFS.
 * This allows git operations to use OPFS storage instead of LightningFS.
 *
 * Usage:
 * ```typescript
 * import { createOPFSGitAdapter } from '@siglum/filesystem'
 *
 * const fs = createOPFSGitAdapter()
 * await git.clone({ fs, dir: '/repo', ... })
 * ```
 */
type Encoding = 'utf8' | null;
interface Stats {
    type: 'file' | 'dir';
    mode: number;
    size: number;
    ino: number;
    mtimeMs: number;
    ctimeMs?: number;
    uid: number;
    gid: number;
    dev: number;
    isFile(): boolean;
    isDirectory(): boolean;
    isSymbolicLink(): boolean;
}
/**
 * Creates an isomorphic-git compatible filesystem adapter backed by OPFS
 */
export declare function createOPFSGitAdapter(): {
    promises: {
        readFile(filepath: string, options?: {
            encoding?: Encoding;
        } | Encoding): Promise<Uint8Array | string>;
        writeFile(filepath: string, data: Uint8Array | string, _options?: {
            encoding?: Encoding;
            mode?: number;
        }): Promise<void>;
        unlink(filepath: string): Promise<void>;
        readdir(filepath: string): Promise<string[]>;
        mkdir(filepath: string, _options?: {
            mode?: number;
        }): Promise<void>;
        rmdir(filepath: string): Promise<void>;
        stat(filepath: string): Promise<Stats>;
        lstat(filepath: string): Promise<Stats>;
        readlink(_filepath: string): Promise<string>;
        symlink(_target: string, _filepath: string): Promise<void>;
        chmod(_filepath: string, _mode: number): Promise<void>;
        rename(oldPath: string, newPath: string): Promise<void>;
    };
};
export declare function getOPFSGitAdapter(): ReturnType<typeof createOPFSGitAdapter>;
export {};
//# sourceMappingURL=OPFSGitAdapter.d.ts.map