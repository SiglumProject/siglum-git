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
/**
 * Wraps an error to ensure it has a string `code` property for isomorphic-git compatibility.
 * OPFS/DOMException errors have numeric codes (and read-only), but isomorphic-git expects strings like 'ENOENT'.
 * We create a new Error object since DOMException.code is a read-only getter.
 */
function wrapError(err, filepath) {
    // Check if it's already a compatible error with string code
    if (err instanceof Error && typeof err.code === 'string') {
        return err;
    }
    // Map DOMException names to Node.js-like error codes
    let code = 'EIO';
    let message = err instanceof Error ? err.message : String(err);
    if (err instanceof DOMException) {
        if (err.name === 'NotFoundError') {
            code = 'ENOENT';
            message = `ENOENT: no such file or directory, '${filepath}'`;
        }
        else if (err.name === 'TypeMismatchError') {
            code = 'ENOTDIR';
            message = `ENOTDIR: not a directory, '${filepath}'`;
        }
        else if (err.name === 'InvalidModificationError') {
            code = 'ENOTEMPTY';
            message = `ENOTEMPTY: directory not empty, '${filepath}'`;
        }
    }
    // Create a new error with the code property
    const newError = new Error(message);
    newError.code = code;
    if (err instanceof Error) {
        newError.stack = err.stack;
    }
    return newError;
}
/**
 * Creates an isomorphic-git compatible filesystem adapter backed by OPFS
 */
export function createOPFSGitAdapter() {
    let rootPromise = null;
    async function getRoot() {
        if (!rootPromise) {
            rootPromise = navigator.storage.getDirectory();
        }
        return rootPromise;
    }
    function normalizePath(filepath) {
        // Remove leading slash for OPFS
        let normalized = filepath;
        if (normalized.startsWith('/')) {
            normalized = normalized.slice(1);
        }
        // Remove trailing slash
        if (normalized.endsWith('/') && normalized.length > 0) {
            normalized = normalized.slice(0, -1);
        }
        // Remove trailing /. (current directory reference)
        if (normalized.endsWith('/.')) {
            normalized = normalized.slice(0, -2);
        }
        return normalized;
    }
    function getPathParts(filepath) {
        const normalized = normalizePath(filepath);
        if (!normalized)
            return [];
        // Filter out empty parts and '.' (current directory)
        return normalized.split('/').filter(part => part.length > 0 && part !== '.');
    }
    async function getParentAndName(filepath, options = {}) {
        const parts = getPathParts(filepath);
        if (parts.length === 0) {
            throw new Error('Invalid path: ' + filepath);
        }
        const name = parts.pop();
        const root = await getRoot();
        let parent = root;
        for (const part of parts) {
            parent = await parent.getDirectoryHandle(part, { create: options.create });
        }
        return { parent, name };
    }
    async function ensureDir(filepath) {
        const parts = getPathParts(filepath);
        const root = await getRoot();
        let current = root;
        for (const part of parts) {
            current = await current.getDirectoryHandle(part, { create: true });
        }
    }
    // The promises API that isomorphic-git uses
    const promises = {
        async readFile(filepath, options) {
            try {
                const { parent, name } = await getParentAndName(filepath);
                const fileHandle = await parent.getFileHandle(name);
                const file = await fileHandle.getFile();
                const encoding = typeof options === 'string' ? options : options?.encoding;
                if (encoding === 'utf8') {
                    return file.text();
                }
                const buffer = await file.arrayBuffer();
                return new Uint8Array(buffer);
            }
            catch (err) {
                throw wrapError(err, filepath);
            }
        },
        async writeFile(filepath, data, _options) {
            try {
                // Ensure parent directories exist
                const parts = getPathParts(filepath);
                if (parts.length > 1) {
                    await ensureDir(parts.slice(0, -1).join('/'));
                }
                const { parent, name } = await getParentAndName(filepath, { create: true });
                const fileHandle = await parent.getFileHandle(name, { create: true });
                const writable = await fileHandle.createWritable();
                await writable.write(data);
                await writable.close();
            }
            catch (err) {
                throw wrapError(err, filepath);
            }
        },
        async unlink(filepath) {
            try {
                const { parent, name } = await getParentAndName(filepath);
                await parent.removeEntry(name);
            }
            catch (err) {
                throw wrapError(err, filepath);
            }
        },
        async readdir(filepath) {
            try {
                const parts = getPathParts(filepath);
                const root = await getRoot();
                let dir = root;
                for (const part of parts) {
                    dir = await dir.getDirectoryHandle(part);
                }
                const entries = [];
                // Cast to async iterable since TS types may be incomplete
                const dirAsIterable = dir;
                for await (const [name] of dirAsIterable) {
                    entries.push(name);
                }
                return entries;
            }
            catch (err) {
                throw wrapError(err, filepath);
            }
        },
        async mkdir(filepath, _options) {
            try {
                await ensureDir(filepath);
            }
            catch (err) {
                throw wrapError(err, filepath);
            }
        },
        async rmdir(filepath) {
            try {
                const { parent, name } = await getParentAndName(filepath);
                await parent.removeEntry(name, { recursive: true });
            }
            catch (err) {
                throw wrapError(err, filepath);
            }
        },
        async stat(filepath) {
            const parts = getPathParts(filepath);
            if (parts.length === 0) {
                // Root directory
                return createStats('dir', 0);
            }
            try {
                const { parent, name } = await getParentAndName(filepath);
                // Try as file first
                try {
                    const fileHandle = await parent.getFileHandle(name);
                    const file = await fileHandle.getFile();
                    return createStats('file', file.size, file.lastModified);
                }
                catch {
                    // Try as directory
                    await parent.getDirectoryHandle(name);
                    return createStats('dir', 0);
                }
            }
            catch (err) {
                throw wrapError(err, filepath);
            }
        },
        async lstat(filepath) {
            // OPFS doesn't support symlinks, so lstat is same as stat
            return promises.stat(filepath);
        },
        async readlink(_filepath) {
            // OPFS doesn't support symlinks
            const err = new Error('OPFS does not support symlinks');
            err.code = 'ENOTSUP';
            throw err;
        },
        async symlink(_target, _filepath) {
            // OPFS doesn't support symlinks
            const err = new Error('OPFS does not support symlinks');
            err.code = 'ENOTSUP';
            throw err;
        },
        async chmod(_filepath, _mode) {
            // OPFS doesn't support permissions, ignore
        },
        async rename(oldPath, newPath) {
            // OPFS doesn't have native rename, so read/write/delete
            const data = await promises.readFile(oldPath);
            await promises.writeFile(newPath, data);
            await promises.unlink(oldPath);
        }
    };
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
    // Return object with promises property (isomorphic-git uses fs.promises)
    return { promises };
}
/**
 * Singleton instance for shared use
 */
let sharedAdapter = null;
export function getOPFSGitAdapter() {
    if (!sharedAdapter) {
        sharedAdapter = createOPFSGitAdapter();
    }
    return sharedAdapter;
}
//# sourceMappingURL=OPFSGitAdapter.js.map