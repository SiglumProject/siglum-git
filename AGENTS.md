# Contributor Guide

This repository publishes the MIT-licensed `@siglum/git` browser library. It
connects isomorphic-git to `@siglum/filesystem` and provides `GitService` for
repository synchronization. The project map in `docs/development.md` links the editor, engine, and filesystem
repositories.

## Working in the Repository

- Read `package.json` for the public export map and available commands.
- Change TypeScript in `src/`. `bun run build` generates JavaScript and
  declarations in `dist/`.
- Use `src/index.ts` for public exports and `src/types.ts` for shared contracts.
- Follow the existing style, with single quotes, no semicolons, and readable
  types. The TypeScript build uses strict checks.
- Keep unrelated local changes intact, including generated files.

## Repository and Storage Changes

`src/FilesystemGitAdapter.ts` implements the filesystem interface used by
isomorphic-git. `src/GitService.ts` manages connection state, synchronization,
branches, conflicts, and subscriptions. `src/RepositoryReplacement.ts` stages
downloads and preserves recovery snapshots before replacing the live checkout.

Preserve unsynced work and local history when operations fail or the user
disconnects. Treat connection credentials separately from repository contents.
Keep Git error codes compatible with isomorphic-git and preserve the shared
filesystem's backend selection and namespace isolation. Review retries and
concurrent operations when changing repository replacement or synchronization.

Use synthetic repositories for checks. `tests/git-filesystem.test.ts` creates
temporary directories, mounts test backends, exercises actual isomorphic-git
operations, and cleans up after each test. Browser storage behavior may need
separate browser verification.

## Commands and Documentation

The local package override references `../siglum-filesystem`. Keep that sibling
checkout available and build it before building this package.

```bash
bun install
bun run build
bun test
```

Run the build and tests for source changes. A focused run can use
`bun test tests/git-filesystem.test.ts`. `bun run dev` watches TypeScript.

Update the README quick start and `docs/usage.md` when behavior changes. Verify
examples against `src/index.ts` and the package export map.
Keep publication procedures in private maintainer notes.

Keep evergreen README and contributor instructions free of fixed current package
versions and release dates. Use unversioned install commands and link to package
metadata, registry badges, or release notes for current versions. Keep schema
versions and numeric API examples when they explain actual behavior.
