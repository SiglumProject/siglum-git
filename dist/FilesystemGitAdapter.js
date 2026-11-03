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
/**
 * Wraps an error to ensure it has a string `code` property for isomorphic-git compatibility.
 */
function wrapError(err, filepath) {
    if (err instanceof Error && typeof err.code === 'string') {
        return err;
    }
    let code = 'EIO';
    let message = err instanceof Error ? err.message : String(err);
    // Map error messages from @siglum/filesystem to Node.js-like error codes
    if (message.includes('No filesystem mounted') || message.includes('ENOENT')) {
        code = 'ENOENT';
        message = `ENOENT: no such file or directory, '${filepath}'`;
    }
    else if (message.includes('not a directory') || message.includes('ENOTDIR')) {
        code = 'ENOTDIR';
        message = `ENOTDIR: not a directory, '${filepath}'`;
    }
    else if (message.includes('not empty') || message.includes('ENOTEMPTY')) {
        code = 'ENOTEMPTY';
        message = `ENOTEMPTY: directory not empty, '${filepath}'`;
    }
    const newError = new Error(message);
    newError.code = code;
    if (err instanceof Error) {
        newError.stack = err.stack;
    }
    return newError;
}
function createStats(type, size, mtimeMs = Date.now()) {
    return {
        type,
        mode: type === 'file' ? 0o100644 : 0o40755,
        size,
        ino: 0,
        mtimeMs,
        ctimeMs: mtimeMs,
        uid: 1000,
        gid: 1000,
        dev: 0,
        isFile: () => type === 'file',
        isDirectory: () => type === 'dir',
        isSymbolicLink: () => false
    };
}
/**
 * Creates an isomorphic-git compatible filesystem adapter backed by siglum-filesystem.
 *
 * @param fs - The FileSystemService instance to wrap
 * @returns An object with a promises property compatible with isomorphic-git
 */
export function createFilesystemGitAdapter(fs) {
    const promises = {
        async readFile(filepath, options) {
            try {
                const encoding = typeof options === 'string' ? options : options?.encoding;
                if (encoding === 'utf8') {
                    return await fs.readFile(filepath);
                }
                return await fs.readBinary(filepath, { autoDecompress: false });
            }
            catch (err) {
                throw wrapError(err, filepath);
            }
        },
        async writeFile(filepath, data, _options) {
            try {
                if (typeof data === 'string') {
                    await fs.writeFile(filepath, data, { createParents: true, silent: true });
                }
                else {
                    await fs.writeBinary(filepath, data, { createParents: true, silent: true });
                }
            }
            catch (err) {
                throw wrapError(err, filepath);
            }
        },
        async unlink(filepath) {
            try {
                await fs.deleteFile(filepath, { silent: true });
            }
            catch (err) {
                throw wrapError(err, filepath);
            }
        },
        async readdir(filepath) {
            try {
                const entries = await fs.readdir(filepath);
                return entries.map((entry) => entry.name);
            }
            catch (err) {
                throw wrapError(err, filepath);
            }
        },
        async mkdir(filepath, _options) {
            try {
                await fs.mkdir(filepath, { silent: true });
            }
            catch (err) {
                throw wrapError(err, filepath);
            }
        },
        async rmdir(filepath) {
            try {
                await fs.rmdir(filepath, { silent: true });
            }
            catch (err) {
                throw wrapError(err, filepath);
            }
        },
        async stat(filepath) {
            try {
                const stats = await fs.stat(filepath);
                return createStats(stats.isDirectory ? 'dir' : 'file', stats.size ?? 0, stats.mtime?.getTime() ?? Date.now());
            }
            catch (err) {
                throw wrapError(err, filepath);
            }
        },
        async lstat(filepath) {
            // siglum-filesystem doesn't support symlinks, so lstat is same as stat
            return promises.stat(filepath);
        },
        async readlink(_filepath) {
            const err = new Error('Symlinks not supported');
            err.code = 'ENOTSUP';
            throw err;
        },
        async symlink(_target, _filepath) {
            const err = new Error('Symlinks not supported');
            err.code = 'ENOTSUP';
            throw err;
        },
        async chmod(_filepath, _mode) {
            // siglum-filesystem doesn't support permissions, ignore
        },
        async rename(oldPath, newPath) {
            try {
                await fs.rename(oldPath, newPath);
            }
            catch (err) {
                throw wrapError(err, oldPath);
            }
        }
    };
    return { promises };
}
//# sourceMappingURL=FilesystemGitAdapter.js.map