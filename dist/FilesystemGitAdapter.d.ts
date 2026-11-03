/**
 * FilesystemGitAdapter
 *
 * Provides an isomorphic-git compatible filesystem adapter that wraps siglum-filesystem.
 * This allows git operations to use the same filesystem as the rest of the application,
 * creating a unified storage layer.
 *
 * Usage:
 * ```typescript
 * import { createFilesystemGitAdapter } from '@siglum/git'
 * import { fileSystem, getBestBackend } from '@siglum/filesystem'
 *
 * // Mount the filesystem first
 * const backend = await getBestBackend()
 * fileSystem.mount('/project', backend)
 *
 * // Create the adapter
 * const fs = createFilesystemGitAdapter(fileSystem)
 *
 * // Use with isomorphic-git
 * await git.clone({ fs, dir: '/project', ... })
 * ```
 */
import type { FileSystemService } from '@siglum/filesystem';
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
 * Creates an isomorphic-git compatible filesystem adapter backed by siglum-filesystem.
 *
 * @param fs - The FileSystemService instance to wrap
 * @returns An object with a promises property compatible with isomorphic-git
 */
export declare function createFilesystemGitAdapter(fs: FileSystemService): {
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
export type FilesystemGitAdapter = ReturnType<typeof createFilesystemGitAdapter>;
export {};
//# sourceMappingURL=FilesystemGitAdapter.d.ts.map