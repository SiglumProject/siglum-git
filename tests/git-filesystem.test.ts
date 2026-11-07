import { afterEach, beforeEach, expect, test, spyOn } from 'bun:test'
import * as native from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import git from 'isomorphic-git'
import { fileSystem, FileSystemService, type FileSystemBackend } from '@siglum/filesystem'
import { replaceRepository, recoverRepository } from '../src/RepositoryReplacement'
import { GitService } from '../src/GitService'
import { createFilesystemGitAdapter } from '../src/FilesystemGitAdapter'

let root: string
let service: FileSystemService
let adapter: ReturnType<typeof createFilesystemGitAdapter>
const dir = '/repo'

beforeEach(async () => {
  root = await native.mkdtemp(join(tmpdir(), 'siglum-git-test-'))
  const makeBackend = (name: string): FileSystemBackend => {
  const path = (p: string) => join(root, name, p)
  return {
    name: 'native-test',
    readFile: p => native.readFile(path(p), 'utf8'),
    readBinary: async p => new Uint8Array(await native.readFile(path(p))),
    writeFile: (p, data) => native.writeFile(path(p), data),
    writeBinary: (p, data) => native.writeFile(path(p), data),
    deleteFile: p => native.unlink(path(p)),
    exists: async p => { try { await native.stat(path(p)); return true } catch { return false } },
    stat: async p => { const s=await native.stat(path(p)); return { size:s.size,mtime:s.mtime,isFile:s.isFile(),isDirectory:s.isDirectory() } },
    mkdir: async p => { await native.mkdir(path(p), {recursive:true}) },
    rmdir: async (p, options) => {
      if (options?.recursive) await native.rm(path(p), {recursive:true})
      else await native.rmdir(path(p))
    },
    readdir: async p => (await native.readdir(path(p),{withFileTypes:true})).map(e=>({name:e.name,path:join(p,e.name),isDirectory:e.isDirectory()})),
    rename: (a,b) => native.rename(path(a),path(b)),
    copyFile: (a,b) => native.copyFile(path(a),path(b)),
  }
  }
  for (const name of ['live', 'staging', 'recovery']) await native.mkdir(join(root, name))
  const backend = makeBackend('live')
  fileSystem.mount('/git-staging', makeBackend('staging'))
  fileSystem.mount('/git-recovery', makeBackend('recovery'))
  service=new FileSystemService()
  service.mount(dir,backend)
  fileSystem.mount('/git',backend)
  adapter=createFilesystemGitAdapter(service)
})
afterEach(async () => { fileSystem.unmount('/git'); fileSystem.unmount('/git-staging'); fileSystem.unmount('/git-recovery'); await native.rm(root,{recursive:true,force:true}) })

test('rmdir preserves untracked files and reports ENOTEMPTY',async()=>{
  await service.writeFile('/repo/notes/keep.tex','important',{createParents:true})
  await expect(adapter.promises.rmdir('/repo/notes')).rejects.toMatchObject({code:'ENOTEMPTY'})
  expect(await service.readFile('/repo/notes/keep.tex')).toBe('important')
})
test('init, binary commit, changed file, and deletion work through the adapter',async()=>{
  await git.init({fs:adapter,dir,defaultBranch:'main'})
  await adapter.promises.writeFile(dir+'/main.tex','hello')
  const bytes=new Uint8Array([0,255,13,10,128,42])
  await adapter.promises.writeFile(dir+'/image.bin',bytes)
  await git.add({fs:adapter,dir,filepath:'.'})
  const oid=await git.commit({fs:adapter,dir,message:'test',author:{name:'Test',email:'test@example.test'}})
  expect((await git.readBlob({fs:adapter,dir,oid,filepath:'image.bin'})).blob).toEqual(bytes)
  expect(await git.status({fs:adapter,dir,filepath:'main.tex'})).toBe('unmodified')
  await adapter.promises.writeFile(dir+'/main.tex','changed')
  expect(await git.status({fs:adapter,dir,filepath:'main.tex'})).toBe('*modified')
  await adapter.promises.unlink(dir+'/main.tex')
  expect(await git.status({fs:adapter,dir,filepath:'main.tex'})).toBe('*deleted')
})
test('checkout preserves untracked siblings in a removed tracked directory',async()=>{
  await git.init({fs:adapter,dir,defaultBranch:'main'})
  await adapter.promises.writeFile(dir+'/main.tex','main')
  await git.add({fs:adapter,dir,filepath:'.'})
  await git.commit({fs:adapter,dir,message:'base',author:{name:'Test',email:'test@example.test'}})
  await git.branch({fs:adapter,dir,ref:'chapter',checkout:true})
  await adapter.promises.writeFile(dir+'/chapters/tracked.tex','chapter')
  await git.add({fs:adapter,dir,filepath:'.'})
  await git.commit({fs:adapter,dir,message:'chapter',author:{name:'Test',email:'test@example.test'}})
  await adapter.promises.writeFile(dir+'/chapters/unsaved.tex','keep me')
  await git.checkout({fs:adapter,dir,ref:'main'})
  expect(await adapter.promises.readFile(dir+'/chapters/unsaved.tex','utf8')).toBe('keep me')
})

async function branchFixture() {
  await git.init({ fs: adapter, dir, defaultBranch: 'main' })
  await adapter.promises.writeFile(dir + '/main.tex', 'original')
  await git.add({ fs: adapter, dir, filepath: '.' })
  const oid = await git.commit({ fs: adapter, dir, message: 'base', author: { name: 'Test', email: 'test@example.test' } })
  await git.branch({ fs: adapter, dir, ref: 'draft' })
  const service = new GitService()
  ;(service as any).config = { repoUrl: 'example/project', token: 'test-token', branch: 'main' }
  return { service, oid }
}

test('branch switch refuses unsynced work without deleting files or repository', async () => {
  const { service, oid } = await branchFixture()
  await adapter.promises.writeFile(dir + '/main.tex', 'uncommitted work')
  await expect(service.switchBranch('draft')).rejects.toThrow('Save and sync')
  expect(await adapter.promises.readFile(dir + '/main.tex', 'utf8')).toBe('uncommitted work')
  expect(await git.resolveRef({ fs: adapter, dir, ref: 'HEAD' })).toBe(oid)
  expect(service.getConfig()?.branch).toBe('main')
})

test('switching an existing local branch preserves local history without recloning', async () => {
  const { service, oid } = await branchFixture()
  await service.switchBranch('draft')
  expect(await git.currentBranch({ fs: adapter, dir })).toBe('draft')
  expect(await git.resolveRef({ fs: adapter, dir, ref: 'main' })).toBe(oid)
  expect(service.getConfig()?.branch).toBe('draft')
})

test('remote URLs exclude authentication secrets', () => {
  const service = new GitService()
  ;(service as any).config = { repoUrl: 'example/project', username: 'user', token: 'test-secret' }
  expect((service as any).getRepoUrl()).toBe('https://github.com/example/project.git')
  ;(service as any).config = { repoUrl: 'https://user:secret@git.example.test/repo.git', token: 'test-secret' }
  expect((service as any).getRepoUrl()).toBe('https://git.example.test/repo.git')
})

test('failed remote lookup leaves the existing branch and local files intact', async () => {
  const { service, oid } = await branchFixture()
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async () => { throw new Error('Simulated network failure') }) as typeof fetch
  try {
    await expect(service.switchBranch('remote-only')).rejects.toThrow()
    expect(await adapter.promises.readFile(dir + '/main.tex', 'utf8')).toBe('original')
    expect(await git.resolveRef({ fs: adapter, dir, ref: 'HEAD' })).toBe(oid)
    expect(service.getConfig()?.branch).toBe('main')
  } finally {
    globalThis.fetch = originalFetch
  }
})

for (const operation of ['connect', 'clone', 'forcePull'] as const) {
  test(`${operation}: failed download preserves checkout, history, and connection`, async () => {
    const { service, oid } = await branchFixture()
    const previous = service.getConfig()
    await adapter.promises.writeFile(dir + '/draft.tex', 'unsynced draft')
    const fetchBefore = globalThis.fetch
    globalThis.fetch = (async () => { throw new Error('Simulated network failure') }) as typeof fetch
    try {
      const operationPromise = operation === 'connect'
        ? service.connect({ ...previous!, repoUrl: 'other/project' })
        : service[operation]()
      await expect(operationPromise).rejects.toThrow()
      expect(await adapter.promises.readFile(dir + '/draft.tex', 'utf8')).toBe('unsynced draft')
      expect(await git.resolveRef({ fs: adapter, dir, ref: 'HEAD' })).toBe(oid)
      expect(service.getConfig()).toEqual(previous)
      expect(service.getStatus().isSyncing).toBe(false)
    } finally { globalThis.fetch = fetchBefore }
  })
}

test('successful replacement preserves a binary-exact recovery copy and flushes drafts', async () => {
  const { oid } = await branchFixture()
  const bytes = new Uint8Array([0, 255, 31, 139, 42])
  await fileSystem.writeBinary('/git/image.bin', bytes)
  await replaceRepository(async directory => {
    await fileSystem.writeFile(directory + '/new.tex', 'downloaded')
  }, async () => { await fileSystem.writeFile('/git/draft.tex', 'last editor change') })
  expect(await fileSystem.readFile('/git/new.tex')).toBe('downloaded')
  expect(await fileSystem.exists('/git/main.tex')).toBe(false)
  expect(await fileSystem.readFile('/git-recovery/snapshot/draft.tex')).toBe('last editor change')
  expect(await fileSystem.readBinary('/git-recovery/snapshot/image.bin', { autoDecompress: false })).toEqual(bytes)
  expect(await git.resolveRef({ fs: createFilesystemGitAdapter(fileSystem), dir: '/git-recovery/snapshot', ref: 'HEAD' })).toBe(oid)
  expect(await fileSystem.readdir('/git-staging')).toEqual([])
})

test('backup storage failure leaves live checkout untouched', async () => {
  const { oid } = await branchFixture()
  const write = fileSystem.writeBinary.bind(fileSystem)
  const mocked = spyOn(fileSystem, 'writeBinary').mockImplementation(async (path, data, options) => {
    if (path.startsWith('/git-recovery/')) throw new Error('Backup quota exhausted')
    return write(path, data, options)
  })
  try {
    await expect(replaceRepository(async directory => {
      await fileSystem.writeFile(directory + '/new.tex', 'downloaded')
    })).rejects.toThrow('Backup quota')
    expect(await fileSystem.readFile('/git/main.tex')).toBe('original')
    expect(await git.resolveRef({ fs: adapter, dir, ref: 'HEAD' })).toBe(oid)
  } finally { mocked.mockRestore() }
})

test('failed installation restores the complete previous checkout', async () => {
  const { oid } = await branchFixture()
  await fileSystem.writeFile('/git/unsynced.tex', 'keep this')
  const write = fileSystem.writeBinary.bind(fileSystem)
  const mocked = spyOn(fileSystem, 'writeBinary').mockImplementation(async (path, data, options) => {
    if (path === '/git/new.tex') throw new Error('Installation write failed')
    return write(path, data, options)
  })
  try {
    await expect(replaceRepository(async directory => {
      await fileSystem.writeFile(directory + '/new.tex', 'downloaded')
    })).rejects.toThrow('Installation write failed')
    expect(await fileSystem.readFile('/git/unsynced.tex')).toBe('keep this')
    expect(await git.resolveRef({ fs: adapter, dir, ref: 'HEAD' })).toBe(oid)
    expect(await fileSystem.readFile('/git-recovery/snapshot/unsynced.tex')).toBe('keep this')
  } finally { mocked.mockRestore() }
})

test('failed rollback retains recovery files and reports their location', async () => {
  await branchFixture()
  const write = fileSystem.writeBinary.bind(fileSystem)
  const mocked = spyOn(fileSystem, 'writeBinary').mockImplementation(async (path, data, options) => {
    if (path.startsWith('/git/')) throw new Error('Storage unavailable')
    return write(path, data, options)
  })
  try {
    await expect(replaceRepository(async directory => {
      await fileSystem.writeFile(directory + '/new.tex', 'downloaded')
    })).rejects.toThrow('/git-recovery')
    expect(await fileSystem.readFile('/git-recovery/snapshot/main.tex')).toBe('original')
    await expect(replaceRepository(async () => {})).rejects.toThrow('interrupted replacement')
    expect(await fileSystem.readFile('/git-recovery/snapshot/main.tex')).toBe('original')
  } finally { mocked.mockRestore() }
  await recoverRepository()
  expect(await fileSystem.readFile('/git/main.tex')).toBe('original')
  expect(await fileSystem.exists('/git-recovery/pending.json')).toBe(false)
})

test('disconnect retains unsynced work and local history', async () => {
  const { service, oid } = await branchFixture()
  await fileSystem.writeFile('/git/draft.tex', 'local draft')
  await service.disconnect()
  expect(service.getConfig()).toBeNull()
  expect(service.getStatus().isConnected).toBe(false)
  expect(await fileSystem.readFile('/git/draft.tex')).toBe('local draft')
  expect(await git.resolveRef({ fs: adapter, dir, ref: 'HEAD' })).toBe(oid)
})

test('starting collaboration refuses unsynced work without recloning', async () => {
  const { service, oid } = await branchFixture()
  await fileSystem.writeFile('/git/draft.tex', 'local draft')
  await expect(service.startCollaborativeEditing()).rejects.toThrow('Save and sync')
  expect(await fileSystem.readFile('/git/draft.tex')).toBe('local draft')
  expect(await git.resolveRef({ fs: adapter, dir, ref: 'HEAD' })).toBe(oid)
})

for (const code of [401, 403, 500]) {
  test(`remote HTTP ${code} cannot become a successful sync`, async () => {
    const { service } = await branchFixture()
    const lastSync = new Date('2026-01-01T00:00:00Z')
    Object.assign((service as any).status, { isConnected: true, lastSync })
    const failure = Object.assign(new Error(`HTTP Error: ${code}`), { data: { statusCode: code } })
    const fetch = spyOn(git, 'fetch').mockRejectedValue(failure)
    const push = spyOn(git, 'push').mockResolvedValue({ ok: true })
    try {
      await expect(service.sync()).rejects.toThrow(`HTTP Error: ${code}`)
      expect(service.getStatus()).toMatchObject({
        isConnected: true, isSyncing: false, lastSync, remoteStatus: 'error',
        needsAuthentication: code !== 500,
      })
      expect(service.getStatus().error).toContain(code === 500 ? '500' : 'Update your token')
      expect(push).not.toHaveBeenCalled()
      expect(await adapter.promises.readFile('/repo/main.tex', 'utf8')).toBe('original')
      if (code !== 500) {
        await (service as any).checkRemoteQuietly()
        expect(fetch).toHaveBeenCalledTimes(1)
        await expect(service.sync()).rejects.toThrow() // Explicit retry is still available.
        expect(fetch).toHaveBeenCalledTimes(2)
      }
    } finally { fetch.mockRestore(); push.mockRestore() }
  })
}

test('token replacement verifies access without replacing local files or claiming a sync', async () => {
  const { service, oid } = await branchFixture()
  await git.writeRef({ fs: adapter, dir, ref: 'refs/remotes/origin/main', value: oid })
  await adapter.promises.writeFile('/repo/main.tex', 'unsynced draft')
  Object.assign((service as any).status, { isConnected: true, needsAuthentication: true, error: 'Denied', remoteStatus: 'error' })
  const fetch = spyOn(git, 'fetch').mockImplementation(async (options: any) => {
    expect(options.onAuth().password).toBe('replacement-token')
    return {} as any
  })
  try {
    await service.updateToken(' replacement-token ')
    expect(service.getConfig()?.token).toBe('replacement-token')
    expect(service.getStatus()).toMatchObject({ remoteStatus: 'ok', needsAuthentication: false, isSyncing: false, hasChanges: true })
    expect(service.getStatus().error).toBeUndefined()
    expect(service.getStatus().lastSync).toBeUndefined()
    expect(await adapter.promises.readFile('/repo/main.tex', 'utf8')).toBe('unsynced draft')
  } finally { fetch.mockRestore() }
})

test('invalid replacement retains prior credentials and local files', async () => {
  const { service } = await branchFixture()
  const fetch = spyOn(git, 'fetch').mockRejectedValue(Object.assign(new Error('HTTP Error: 401'), { data: { statusCode: 401 } }))
  try {
    await expect(service.updateToken('bad-token')).rejects.toThrow('401')
    expect(service.getConfig()?.token).toBe('test-token')
    expect(service.getStatus()).toMatchObject({ isSyncing: false, remoteStatus: 'error', needsAuthentication: true })
    expect(await adapter.promises.readFile('/repo/main.tex', 'utf8')).toBe('original')
  } finally { fetch.mockRestore() }
})

test('verified unchanged remote completes sync and clears a prior error', async () => {
  const { service, oid } = await branchFixture()
  await git.writeRef({ fs: adapter, dir, ref: 'refs/remotes/origin/main', value: oid })
  Object.assign((service as any).status, { needsAuthentication: true, error: 'Denied' })
  const fetch = spyOn(git, 'fetch').mockResolvedValue({} as any)
  try {
    await service.sync()
    expect(service.getStatus()).toMatchObject({ remoteStatus: 'ok', needsAuthentication: false, isSyncing: false })
    expect(service.getStatus().error).toBeUndefined()
    expect(service.getStatus().lastSync).toBeInstanceOf(Date)
  } finally { fetch.mockRestore() }
})

test('sync keeps its operation lock through pull and push and propagates a failed push', async () => {
  const { service, oid } = await branchFixture()
  const lastSync = new Date('2026-01-01T00:00:00Z')
  Object.assign((service as any).status, { lastSync })
  await git.writeRef({ fs: adapter, dir, ref: 'refs/remotes/origin/main', value: oid })
  const check = spyOn(service, 'checkRemote').mockResolvedValue({ hasRemoteChanges: true, hasLocalChanges: false })
  const fetch = spyOn(git, 'fetch').mockResolvedValue({} as any)
  const pull = spyOn(git, 'pull').mockImplementation(async (options: any) => {
    expect(service.getStatus().isSyncing).toBe(true)
    expect(options.corsProxy).toBe('https://cors.isomorphic-git.org')
    expect(options.url).toBe('https://github.com/example/project.git')
  })
  const push = spyOn(git, 'push').mockImplementation(async (options: any) => {
    expect(service.getStatus().isSyncing).toBe(true)
    expect(service.getStatus().lastSync).toEqual(lastSync)
    expect(options.corsProxy).toBe('https://cors.isomorphic-git.org')
    throw Object.assign(new Error('HTTP Error: 403'), { data: { statusCode: 403 } })
  })
  try {
    await expect(service.sync()).rejects.toThrow('403')
    expect(pull).toHaveBeenCalledTimes(1)
    expect(push).toHaveBeenCalledTimes(1)
    expect(service.getStatus()).toMatchObject({ isSyncing: false, lastSync, needsAuthentication: true })
  } finally { check.mockRestore(); fetch.mockRestore(); pull.mockRestore(); push.mockRestore() }
})


test('working-tree root stat canonicalizes dot segments for browser storage', async () => {
  const original = service.stat.bind(service)
  const stat = spyOn(service, 'stat').mockImplementation(async path => {
    if (path.split('/').includes('.')) throw new Error('OPFS does not accept dot path segments')
    return original(path)
  })
  try {
    expect((await adapter.promises.lstat('/repo/.')).isDirectory()).toBe(true)
    expect(stat).toHaveBeenCalledWith('/repo')
    await git.init({ fs: adapter, dir, defaultBranch: 'main' })
    await adapter.promises.writeFile('/repo/draft.tex', 'unsynced draft')
    expect(await git.statusMatrix({ fs: adapter, dir })).toEqual([['draft.tex', 0, 2, 0]])
  } finally { stat.mockRestore() }
})

async function conflictFixture() {
  const { service: gitService, oid: base } = await branchFixture()
  await git.branch({ fs: adapter, dir, ref: 'incoming', checkout: true })
  await adapter.promises.writeFile(dir + '/main.tex', 'from remote')
  await adapter.promises.writeFile(dir + '/remote-only.tex', 'remote addition')
  await git.add({ fs: adapter, dir, filepath: '.' })
  const remote = await git.commit({ fs: adapter, dir, message: 'remote', author: { name: 'Test', email: 'test@example.test' } })
  await git.writeRef({ fs: adapter, dir, ref: 'refs/remotes/origin/main', value: remote, force: true })
  await git.checkout({ fs: adapter, dir, ref: 'main' })
  await adapter.promises.writeFile(dir + '/main.tex', 'from local')
  await adapter.promises.writeFile(dir + '/local-only.tex', 'unrelated local')
  ;(gitService as any).refreshConflictRemote = async () => {}
  return { gitService, base, remote }
}

test('review uses working bytes and applies a merged choice without a remote push', async () => {
  const { gitService, base, remote } = await conflictFixture()
  const review = await gitService.getConflictReview()
  expect(review).toMatchObject({ branch: 'main', localHead: base, remoteHead: remote, files: [{
    path: 'main.tex', localText: 'from local', remoteText: 'from remote', baseText: 'original',
    localExists: true, remoteExists: true, isBinary: false,
  }] })
  await gitService.applyConflictResolution(review.id, [{ path: 'main.tex', choice: 'merged', content: 'both edits' }])
  expect(await git.resolveRef({ fs: adapter, dir, ref: 'HEAD' })).toBe(remote)
  expect(await git.currentBranch({ fs: adapter, dir })).toBe('main')
  expect(await adapter.promises.readFile(dir + '/main.tex', 'utf8')).toBe('both edits')
  expect(await adapter.promises.readFile(dir + '/remote-only.tex', 'utf8')).toBe('remote addition')
  expect(await adapter.promises.readFile(dir + '/local-only.tex', 'utf8')).toBe('unrelated local')
  expect(await git.status({ fs: adapter, dir, filepath: 'main.tex' })).toBe('*modified')
  expect(await git.status({ fs: adapter, dir, filepath: 'remote-only.tex' })).toBe('unmodified')
})

test('review fails closed after a draft changes the affected file', async () => {
  const { gitService, base } = await conflictFixture()
  const review = await gitService.getConflictReview()
  await adapter.promises.writeFile(dir + '/main.tex', 'newer draft')
  await expect(gitService.applyConflictResolution(review.id, [{ path: 'main.tex', choice: 'remote' }])).rejects.toThrow('local file changed')
  expect(await git.resolveRef({ fs: adapter, dir, ref: 'HEAD' })).toBe(base)
  expect(await adapter.promises.readFile(dir + '/main.tex', 'utf8')).toBe('newer draft')
  expect(await service.exists(dir + '/remote-only.tex')).toBe(false)
})

test('review rejects an advanced remote revision before changing the checkout', async () => {
  const { gitService, base } = await conflictFixture()
  const review = await gitService.getConflictReview()
  await git.writeRef({ fs: adapter, dir, ref: 'refs/remotes/origin/main', value: base, force: true })
  await expect(gitService.applyConflictResolution(review.id, [{ path: 'main.tex', choice: 'remote' }])).rejects.toThrow('revision changed')
  expect(await git.resolveRef({ fs: adapter, dir, ref: 'HEAD' })).toBe(base)
  expect(await adapter.promises.readFile(dir + '/main.tex', 'utf8')).toBe('from local')
})

test('review refuses divergent committed history without replacing the checkout', async () => {
  const { gitService } = await conflictFixture()
  await git.add({ fs: adapter, dir, filepath: 'main.tex' })
  const local = await git.commit({ fs: adapter, dir, message: 'divergent local', author: { name: 'Test', email: 'test@example.test' } })
  await expect(gitService.getConflictReview()).rejects.toThrow('branches diverged')
  expect(await git.resolveRef({ fs: adapter, dir, ref: 'HEAD' })).toBe(local)
})

test('a local deletion remains a pending deletion after the local fast-forward', async () => {
  const { gitService, remote } = await conflictFixture()
  await adapter.promises.unlink(dir + '/main.tex')
  expect(await gitService.getChanges()).toContainEqual({ path: 'main.tex', status: 'deleted' })
  const review = await gitService.getConflictReview()
  expect(review.files[0]).toMatchObject({ localText: null, localExists: false, remoteText: 'from remote' })
  await gitService.applyConflictResolution(review.id, [{ path: 'main.tex', choice: 'local' }])
  expect(await git.resolveRef({ fs: adapter, dir, ref: 'HEAD' })).toBe(remote)
  expect(await service.exists(dir + '/main.tex')).toBe(false)
  expect(await gitService.getChanges()).toContainEqual({ path: 'main.tex', status: 'deleted' })
})

test('a failed branch update restores affected worktree bytes and the original index', async () => {
  const { gitService, base, remote } = await conflictFixture()
  const review = await gitService.getConflictReview()
  const originalIndex = await adapter.promises.readFile(dir + '/.git/index')
  const writeRef = git.writeRef
  const failingRef = spyOn(git, 'writeRef').mockImplementation(async options => {
    if (options.ref === 'refs/heads/main' && options.value === remote) throw new Error('simulated branch failure')
    return writeRef(options)
  })
  try {
    await expect(gitService.applyConflictResolution(review.id, [{ path: 'main.tex', choice: 'remote' }])).rejects.toThrow('simulated branch failure')
  } finally {
    failingRef.mockRestore()
  }
  expect(await git.resolveRef({ fs: adapter, dir, ref: 'HEAD' })).toBe(base)
  expect(await adapter.promises.readFile(dir + '/main.tex', 'utf8')).toBe('from local')
  expect(await adapter.promises.readFile(dir + '/local-only.tex', 'utf8')).toBe('unrelated local')
  expect(await service.exists(dir + '/remote-only.tex')).toBe(false)
  expect(await adapter.promises.readFile(dir + '/.git/index')).toEqual(originalIndex)
})

test('binary conflict offers byte-preserving choices and rejects merged text', async () => {
  const { gitService, remote } = await conflictFixture()
  const bytes = new Uint8Array([0, 255, 13, 10, 128])
  await adapter.promises.writeFile(dir + '/main.tex', bytes)
  const review = await gitService.getConflictReview()
  expect(review.files[0]).toMatchObject({ isBinary: true, localExists: true, localText: null })
  await expect(gitService.applyConflictResolution(review.id, [{ path: 'main.tex', choice: 'merged', content: 'lossy' }])).rejects.toThrow('valid resolution')
  await gitService.applyConflictResolution(review.id, [{ path: 'main.tex', choice: 'local' }])
  expect(await git.resolveRef({ fs: adapter, dir, ref: 'HEAD' })).toBe(remote)
  expect(await adapter.promises.readFile(dir + '/main.tex')).toEqual(bytes)
})
