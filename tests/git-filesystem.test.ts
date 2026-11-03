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
