# Git usage

The [quick start](../README.md#quick-start) shows local Git operations through
the shared filesystem adapter. Remote operations also need HTTP transport and
a CORS proxy accepted by the Git host.

## Standalone OPFS Adapter

The legacy OPFS adapter remains available for direct isomorphic-git use:

```typescript
import { createOPFSGitAdapter } from '@siglum/git'
import git from 'isomorphic-git'
import http from 'isomorphic-git/http/web'

const fs = createOPFSGitAdapter()

// Clone a repository
await git.clone({
  fs,
  http,
  dir: '/repo',
  url: 'https://github.com/user/repo',
  corsProxy: 'https://cors.isomorphic-git.org'
})

// Read files
const content = await fs.promises.readFile('/repo/README.md', 'utf8')

// Write files
await fs.promises.writeFile('/repo/new-file.txt', 'Hello, world!')

// Commit changes
await git.add({ fs, dir: '/repo', filepath: 'new-file.txt' })
await git.commit({
  fs,
  dir: '/repo',
  message: 'Add new file',
  author: { name: 'User', email: 'user@example.com' }
})
```

The adapter implements the file and directory operations isomorphic-git requires, backed by the browser's Origin Private File System (OPFS).

## GitService (Higher-Level API)

For a batteries-included experience with sync, conflict detection, and reactive subscriptions:

```typescript
import { GitService } from '@siglum/git'

const git = new GitService({
  corsProxy: 'https://cors.isomorphic-git.org',
  onFileTreeChange: (files) => console.log('Files:', files)
})

// Connect to a repository
await git.connect({
  provider: 'github',
  repoUrl: 'https://github.com/user/repo',
  branch: 'main',
  token: '<access-token>',
  username: '<github-username>',
  syncInterval: 'manual',
  conflictResolution: 'local',
  autoSync: false
})

// Read/write files
const content = await git.readFile('/main.tex')
await git.writeFile('/main.tex', 'Updated content')

// Sync with remote
await git.sync()

// Subscribe to status changes
git.subscribeStatus((status) => {
  console.log('Connected:', status.isConnected)
  console.log('Syncing:', status.isSyncing)
  console.log('Has changes:', status.hasChanges)
})
```

### GitService Features

- **Auto-sync** - Configurable sync intervals (5min, 15min, 30min, 1hour, manual)
- **Conflict detection** - Detects when both local and remote have changes
- **Status subscriptions** - Reactive updates for UI integration
- **File tree subscriptions** - Get notified when files change
- **Force push/pull** - Resolve conflicts by forcing one direction
- **Branch switching** - Switch branches or create new ones
- **GitHub integration** - Create repositories directly via GitHub API

## API

### createOPFSGitAdapter()

Creates an isomorphic-git compatible filesystem backed by OPFS.

```typescript
const fs = createOPFSGitAdapter()
```

Pass `fs` to isomorphic-git as in the complete adapter example above.

### getOPFSGitAdapter()

Returns a singleton instance of the adapter.

```typescript
const fs = getOPFSGitAdapter()
```

### GitService

| Method | Description |
|--------|-------------|
| `connect(config)` | Clone and connect to a repository |
| `disconnect()` | Disconnect and remove saved connection credentials while retaining local files and history |
| `sync()` | Pull remote changes, commit local changes, push |
| `pull()` | Pull changes from remote |
| `push()` | Push changes to remote |
| `commit(message)` | Stage and commit working-tree changes |
| `forcePull()` | Discard local changes, pull remote |
| `forcePush()` | Force push local changes to remote |
| `switchBranch(branch)` | Switch to or create a branch |
| `readFile(path)` | Read file content |
| `writeFile(path, content)` | Write file content |
| `getChanges()` | Get list of changed files |
| `subscribeStatus(listener)` | Subscribe to status changes |
| `subscribeFileTree(listener)` | Subscribe to file tree changes |

Disconnect stops automatic synchronization and removes the saved connection
configuration. The local checkout, unsynced files, and Git history remain in
browser storage.

## Storage and recovery

`GitService` mounts the shared filesystem in the isolated `siglum-git`
namespace. Repository replacement downloads into staging and preserves a
recovery snapshot before changing the live checkout. Failed installations
attempt to restore that snapshot.

If an interrupted replacement requires recovery, call
`await git.recoverCheckout()` after browser storage is available again. The
snapshot is retained in the separate `siglum-git-recovery` namespace.
