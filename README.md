# @siglum/git

[![npm version](https://img.shields.io/npm/v/@siglum/git)](https://www.npmjs.com/package/@siglum/git)
[![weekly npm downloads](https://img.shields.io/npm/dw/@siglum/git)](https://www.npmjs.com/package/@siglum/git)

Browser Git operations backed by `@siglum/filesystem` and isomorphic-git.
Use the filesystem adapter directly, or `GitService` for synchronization,
status subscriptions, and conflict handling.

## Install

```sh
npm install @siglum/git @siglum/filesystem isomorphic-git
```

## Quick start

```typescript
import git from 'isomorphic-git'
import { fileSystem } from '@siglum/filesystem'
import { createFilesystemGitAdapter } from '@siglum/git'

await fileSystem.mountAuto('/repo', { namespace: 'example-repo' })
const fs = createFilesystemGitAdapter(fileSystem)

await git.init({ fs, dir: '/repo', defaultBranch: 'main' })
await fs.promises.writeFile('/repo/hello.txt', 'Hello, world!')
await git.add({ fs, dir: '/repo', filepath: 'hello.txt' })

const commit = await git.commit({
  fs,
  dir: '/repo',
  message: 'Add hello.txt',
  author: { name: 'Your name', email: 'you@example.com' }
})
console.log(commit)
```

This creates a local repository in browser storage. Remote synchronization
and the higher-level service are covered in the usage guide.

## Documentation

- [Adapters, GitService, and recovery](docs/usage.md)
- [Development and project map](docs/development.md)
- [Contributor instructions](AGENTS.md)

## License

MIT, as declared in the [package metadata](package.json).
