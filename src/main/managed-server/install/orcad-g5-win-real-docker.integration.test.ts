import type * as ExecModule from '../../ssh/remote-exec/remote-exec-command'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
vi.mock('../../ssh/remote-exec/remote-exec-command', async (original) => ({
  ...(await original<typeof ExecModule>()),
  execCommand: vi.fn()
}))
vi.mock('./orcad-remote-install-cached-probe', () => ({
  cachedOrcadSlotInstalled: vi.fn().mockResolvedValue(true)
}))
vi.mock('./orcad-remote-node-runtime', () => ({
  ensureRemoteOrcadNodeRuntime: vi.fn().mockResolvedValue(undefined)
}))
vi.mock('./remote-install-lock', () => ({
  acquireInstallLock: vi.fn().mockResolvedValue(undefined)
}))
vi.mock('./remote-install-transfers', () => ({
  uploadRemoteInstallDirectory: vi.fn().mockResolvedValue(undefined),
  writeRemoteInstallFile: vi.fn().mockResolvedValue(undefined)
}))
vi.mock('./remote-versioned-install', () => ({
  isRemoteInstallComplete: vi.fn().mockResolvedValue(false),
  finalizeInstall: vi.fn().mockResolvedValue(undefined),
  abandonInstall: vi.fn().mockResolvedValue(true)
}))
vi.mock('./orcad-g5-reconciliation', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  readG5ReconciliationRecord: vi.fn().mockResolvedValue(null),
  publishG5ReconciliationRecord: vi.fn().mockResolvedValue(undefined),
  releaseOwnedG5Lock: vi.fn().mockResolvedValue(undefined)
}))
import { execCommand } from '../../ssh/remote-exec/remote-exec-command'
import { getRemoteHostPlatform } from '../../ssh/ssh-remote-platform'
import { unusedOrcadHostTransport } from '../../ssh/unused-host-transport.test-fixture'
import { installOrcadBundle } from './orcad-remote-install'
import { cachedOrcadSlotInstalled } from './orcad-remote-install-cached-probe'
import { isRemoteInstallComplete, finalizeInstall } from './remote-versioned-install'
import { uploadRemoteInstallDirectory } from './remote-install-transfers'
import {
  assertCompatibleG5ReconciliationRecord,
  readG5ReconciliationRecord,
  publishG5ReconciliationRecord,
  releaseOwnedG5Lock
} from './orcad-g5-reconciliation'
import { acquireInstallLock } from './remote-install-lock'
import { abandonInstall } from './remote-versioned-install'
const name = process.env.G5_WINDOWS_TEST_CONTAINER
const image = process.env.G5_WINDOWS_TEST_IMAGE
const adapter = process.env.G5_WINDOWS_TEST_ADAPTER
const ready = Boolean(name && image && adapter)
const command = vi.mocked(execCommand)
const host=getRemoteHostPlatform('win32-x64')
const conn=unusedOrcadHostTransport()
function launch(g5Docker?: {adapterPath:string; container:string; expectedImageId:string}) {
  return installOrcadBundle({
    conn,host,localOrcadDir:'C:/g5-isolated-test/orcad',target:'win32-x64',
    nodeRuntimeArchive:async()=>'C:/g5-isolated-test/node-archive',
    recordedNodeRuntimeProbe:true,
    ...(g5Docker ? {g5Docker}:{})
  },'0.2.0+g5isolated','C:/g5-isolated-test/orcad-slot')
}
const option=()=>({adapterPath:adapter!,container:name!,expectedImageId:image!})
function docker(...args:string[]):string {
  return execFileSync('docker',args,{encoding:'utf8',timeout:25000}).trim()
}
beforeEach(()=>{
  vi.clearAllMocks()
  vi.mocked(cachedOrcadSlotInstalled).mockResolvedValue(true)
  vi.mocked(isRemoteInstallComplete).mockResolvedValue(true)
  vi.mocked(finalizeInstall).mockResolvedValue(undefined)
  vi.mocked(readG5ReconciliationRecord).mockResolvedValue(null)
  vi.mocked(publishG5ReconciliationRecord).mockResolvedValue(undefined)
  vi.mocked(releaseOwnedG5Lock).mockResolvedValue(undefined)
  vi.mocked(acquireInstallLock).mockResolvedValue(undefined)
  vi.mocked(abandonInstall).mockResolvedValue(true)
})
describe.skipIf(!ready)('native Orca Windows installer â†” actual Windows PowerShell Docker command',()=>{
  it('keeps native Windows install unchanged without opt-in',async()=>{
    command.mockImplementation(async()=>{throw Error('unexpected remote call')})
    await expect(launch()).resolves.toBeUndefined()
    expect(command).not.toHaveBeenCalled()
  })
  it('rejects invalid image identity before a Windows host command',async()=>{
    command.mockImplementation(async()=>{throw Error('should not run remote command')})
    await expect(launch({...option(),expectedImageId:'sha256:bad'})).rejects.toThrow()
    expect(command).not.toHaveBeenCalled()
  })
  it('invokes actual Windows command through cmd.exe, pins image and changes V12 slot',async()=>{
    const executed: string[]=[]
    command.mockImplementation(async (_conn,line,config)=>{
      expect(config?.wrapCommand).toBe(false)
      executed.push(line)
      console.log("REAL_WINDOWS_CMD", JSON.stringify(line))
      const dir=mkdtempSync(join(tmpdir(),'g5-command-'))
      const batch=join(dir,'invoke.cmd')
      writeFileSync(batch,'@echo off\r\n'+line+'\r\n')
      try {
        return execFileSync('cmd.exe',['/d','/c',batch],{
          encoding:'utf8',timeout:35000,windowsHide:true
        })
      } finally { rmSync(dir,{recursive:true,force:true}) }
    })
    expect(docker('exec',name!,'readlink','/home/node/g5-managed/active')).toBe('versions/v11')
    docker('exec',name!,'sh','-c',"printf 'G5_PERSIST_246' > /home/node/g5-managed/persistence-proof.txt")
    await expect(launch(option())).rejects.toThrow('G5 selected but V12 not running')
    expect(executed.some((line) => line.includes('powershell') && line.includes('Ensure'))).toBe(true)
    expect(docker('exec',name!,'readlink','/home/node/g5-managed/active')).toBe('versions/v12')
    const previous=docker('exec',name!,'sh','-c','ps -o args= -p 1')
    expect(previous).toContain('/opt/g5-sources/v11/')
    docker('restart',name!)
    let newRuntime=false
    for(let i=0;i<50;i++) {
      try {
        const current=docker('exec',name!,'sh','-c','ps -o args= -p 1')
        if(current.includes('/opt/g5-sources/v12/')) {newRuntime=true;break}
      } catch {}
      await new Promise(r=>setTimeout(r,300))
    }
    expect(newRuntime).toBe(true)
    await expect(launch(option())).resolves.toBeUndefined()
    console.log(JSON.stringify({realWindowsCommand:true,pinnedDocker:true,
      selected:'v12',running:'v12',unactivatedV12Rejected:true}))
  },120000)
  it('rolls back the real V12 process to V11 and keeps persistent host data', async()=>{
    expect(docker('exec',name!,'readlink','/home/node/g5-managed/active')).toBe('versions/v12')
    const result=execFileSync('powershell.exe',[
      '-NoProfile','-NonInteractive','-File',adapter!,
      '-Action','Rollback','-Apply','-Container',name!,
      '-ExpectedImageId',image!
    ],{encoding:'utf8',timeout:40000,windowsHide:true})
    const receipt=JSON.parse(result.trim())
    expect(receipt.active).toBe('v11')
    // Selection alone is not a live runtime upgrade: prove new process after restart.
    const pre=docker('exec',name!,'sh','-c','ps -o args= -p 1')
    expect(pre).toContain('/opt/g5-sources/v12/')
    docker('restart',name!)
    let healthy=false
    for(let i=0;i<80;i++){
      try {
        const cmd=docker('exec',name!,'sh','-c','ps -o args= -p 1')
        const marker=docker('exec',name!,'cat','/home/node/g5-managed/persistence-proof.txt')
        if(!cmd.includes('/opt/g5-sources/v11/') || marker!=='G5_PERSIST_246') {
          await new Promise(r=>setTimeout(r,300))
          continue
        }
        const started=docker('inspect',name!,'--format','{{.State.StartedAt}}')
        const log=docker('logs','--since',started,name!)
        const ready=log.split(/\r?\n/).map((line)=>{
          try {return JSON.parse(line)} catch {return null}
        }).filter((event)=>event?.type==='orca_server_ready')
        const latest=ready.at(-1)
        if(latest?.health?.terminalDaemon?.selfTest?.ok===true &&
           latest?.health?.terminalDaemon?.protocolVersion===54 &&
           latest?.health?.terminalDaemon?.state==='live' &&
           String(latest?.health?.terminalDaemon?.entryPath).includes('/opt/g5-sources/v11/')){
          healthy=true
          break
        }
      }catch{}
      await new Promise(r=>setTimeout(r,300))
    }
    expect(healthy).toBe(true)
    console.log(JSON.stringify({rollback:'v11',ptyHealthy:true,protocol:54,
      persistentMarkerPreserved:true,containerNetwork:'none'}))
  },120000)
})



describe('G5 Docker bridge fail-closed status qualification', () => {
  const bridge = {
    adapterPath: 'C:\\g5-isolated-test\\adapter.ps1',
    container: 'g5-qualifier',
    expectedImageId: 'sha256:' + 'a'.repeat(64)
  }
  const containerId = 'c'.repeat(64)
  const ensureReceipt = JSON.stringify({
    active: 'v12', runningVersion: 'v12', restartRequired: false,
    containerId
  })
  const healthyStatus = {
    active: 'v12', runningVersion: 'v12', fallback: true,
    image: bridge.expectedImageId, network: 'none', restart: 'no',
    containerId, healthy: true, protocolVersion: 54,
    windowsNativeUpdaterUnchanged: true
  }
  beforeEach(() => {
    command.mockReset().mockImplementation(async (_conn, line) =>
      line.includes('Ensure') ? ensureReceipt : JSON.stringify(healthyStatus)
    )
  })

  it('requires an independent read-only Status observation after Ensure', async () => {
    command.mockResolvedValueOnce(ensureReceipt).mockResolvedValueOnce(JSON.stringify(healthyStatus))
    await expect(launch(bridge)).resolves.toBeUndefined()
    expect(command).toHaveBeenCalledTimes(2)
    const [ensureArgs, statusArgs] = command.mock.calls
    expect(ensureArgs[1]).toContain('Ensure')
    expect(ensureArgs[1]).toContain('Apply')
    expect(statusArgs[1]).toContain('Status')
    expect(statusArgs[1]).not.toContain('Apply')
    expect(statusArgs[2]?.wrapCommand).toBe(false)
  })

  it('rejects forged or stale status even if Ensure reports a successful mutation', async () => {
    command.mockResolvedValueOnce(ensureReceipt).mockResolvedValueOnce(
      JSON.stringify({ ...healthyStatus, image: 'sha256:' + 'b'.repeat(64) })
    )
    await expect(launch(bridge)).rejects.toThrow('live image/isolation/fallback/status mismatch')
    expect(command).toHaveBeenCalledTimes(2)
  })

  it('does not query Status when Ensure already reports a pending restart', async () => {
    command.mockResolvedValueOnce(
      JSON.stringify({ active: 'v12', runningVersion: 'v11', restartRequired: true })
    )
    await expect(launch(bridge)).rejects.toThrow('V12 not running')
    expect(command).toHaveBeenCalledTimes(1)
  })

  it('never marks a fresh native install complete when Docker verification fails', async () => {
    vi.mocked(cachedOrcadSlotInstalled).mockResolvedValue(false)
    vi.mocked(isRemoteInstallComplete).mockResolvedValue(false)
    command.mockResolvedValueOnce(ensureReceipt).mockResolvedValueOnce(
      JSON.stringify({ ...healthyStatus, network: 'bridge' })
    )
    await expect(launch(bridge)).rejects.toThrow('Docker verification failed')
    expect(uploadRemoteInstallDirectory).toHaveBeenCalledTimes(1)
    expect(finalizeInstall).not.toHaveBeenCalled()
  })

  it('marks a fresh native install complete only after independent Docker status succeeds', async () => {
    vi.mocked(cachedOrcadSlotInstalled).mockResolvedValue(false)
    vi.mocked(isRemoteInstallComplete).mockResolvedValue(false)
    command.mockResolvedValueOnce(ensureReceipt).mockResolvedValueOnce(JSON.stringify(healthyStatus))
    await expect(launch(bridge)).resolves.toBeUndefined()
    expect(finalizeInstall).toHaveBeenCalledTimes(1)
    expect(command).toHaveBeenCalledTimes(3) // Ensure, Status, post-commit Status
    expect(command.mock.invocationCallOrder[1]).toBeLessThan(
      vi.mocked(finalizeInstall).mock.invocationCallOrder[0]
    )
    expect(command.mock.invocationCallOrder[2]).toBeGreaterThan(
      vi.mocked(finalizeInstall).mock.invocationCallOrder[0]
    )
  })

  it('supports an explicit forward retry after native finalization fails without claiming atomic rollback', async () => {
    vi.mocked(cachedOrcadSlotInstalled).mockResolvedValue(false)
    vi.mocked(isRemoteInstallComplete).mockResolvedValue(false)
    vi.mocked(finalizeInstall)
      .mockRejectedValueOnce(new Error('simulated native finalization failure'))
      .mockResolvedValueOnce(undefined)
    command.mockResolvedValueOnce(ensureReceipt).mockResolvedValueOnce(JSON.stringify(healthyStatus))
    await expect(launch(bridge)).rejects.toThrow('simulated native finalization failure')
    expect(finalizeInstall).toHaveBeenCalledTimes(1)
    // A retry must independently qualify the sidecar again, not trust the earlier receipt.
    command.mockResolvedValueOnce(ensureReceipt).mockResolvedValueOnce(JSON.stringify(healthyStatus))
    await expect(launch(bridge)).resolves.toBeUndefined()
    expect(finalizeInstall).toHaveBeenCalledTimes(2)
    expect(command).toHaveBeenCalledTimes(5)
  })

  it('keeps a durable pending journal if independent Docker status becomes uncertain', async () => {
    vi.mocked(cachedOrcadSlotInstalled).mockResolvedValue(false)
    vi.mocked(isRemoteInstallComplete).mockResolvedValue(false)
    const unknown = Object.assign(new Error('SSH outcome unknown'), {
      sshChannelCloseConfirmed: false
    })
    command.mockResolvedValueOnce(ensureReceipt).mockRejectedValueOnce(unknown)
    await expect(launch(bridge)).rejects.toBe(unknown)
    expect(vi.mocked(publishG5ReconciliationRecord).mock.calls.map(([, , rec]) => rec.phase))
      .toEqual(['pending'])
    expect(finalizeInstall).not.toHaveBeenCalled()
    expect(abandonInstall).not.toHaveBeenCalled()
  })

  it('rejects an old conflicting image journal before touching native slot bytes or Docker', async () => {
    vi.mocked(cachedOrcadSlotInstalled).mockResolvedValue(false)
    vi.mocked(isRemoteInstallComplete).mockResolvedValue(false)
    vi.mocked(readG5ReconciliationRecord).mockResolvedValueOnce({
      schema: 1,
      container: bridge.container,
      imageId: 'sha256:' + 'b'.repeat(64),
      nativeVersion: '0.2.0+g5isolated',
      ownerToken: '00000000-0000-0000-0000-000000000000',
      phase: 'pending'
    })
    await expect(launch(bridge)).rejects.toThrow('G5 reconciliation conflict')
    expect(uploadRemoteInstallDirectory).not.toHaveBeenCalled()
    expect(command).not.toHaveBeenCalled()
    expect(finalizeInstall).not.toHaveBeenCalled()
  })

  it('writes pending and qualified durable phases before native finalization', async () => {
    vi.mocked(cachedOrcadSlotInstalled).mockResolvedValue(false)
    vi.mocked(isRemoteInstallComplete).mockResolvedValue(false)
    command.mockResolvedValueOnce(ensureReceipt).mockResolvedValueOnce(JSON.stringify(healthyStatus))
    await launch(bridge)
    const journal = vi.mocked(publishG5ReconciliationRecord)
    expect(journal.mock.calls.map(([, , rec]) => rec.phase)).toEqual(['pending', 'qualified'])
    expect(journal.mock.calls[1]?.[2].ownerToken).toBe(journal.mock.calls[0]?.[2].ownerToken)
    expect(journal.mock.invocationCallOrder[1]).toBeLessThan(
      vi.mocked(finalizeInstall).mock.invocationCallOrder[0]!
    )
  })

  it('reconciles a lost native finalize reply when both authorities confirm commit', async () => {
    vi.mocked(cachedOrcadSlotInstalled).mockResolvedValue(false)
    vi.mocked(isRemoteInstallComplete)
      .mockResolvedValueOnce(false) // before native lock
      .mockResolvedValueOnce(false) // inside native lock
      .mockResolvedValueOnce(true) // after lost response
    vi.mocked(finalizeInstall).mockRejectedValueOnce(new Error('known finalize reply lost'))
    command.mockResolvedValueOnce(ensureReceipt)
      .mockResolvedValueOnce(JSON.stringify(healthyStatus))
      .mockResolvedValueOnce(JSON.stringify(healthyStatus))
    await expect(launch(bridge)).resolves.toBeUndefined()
    expect(command).toHaveBeenCalledTimes(4) // Ensure, Status, post-error Status, post-commit Status
    expect(finalizeInstall).toHaveBeenCalledTimes(1)
    expect(releaseOwnedG5Lock).toHaveBeenCalledTimes(2) // global then native, owner checked
    expect(abandonInstall).not.toHaveBeenCalled()
  })

  it('preserves the native lock on an unconfirmed finalization without compensating Docker', async () => {
    vi.mocked(cachedOrcadSlotInstalled).mockResolvedValue(false)
    vi.mocked(isRemoteInstallComplete).mockResolvedValue(false)
    const unknown = Object.assign(new Error('finalize outcome unknown'), {
      sshChannelCloseConfirmed: false
    })
    vi.mocked(finalizeInstall).mockRejectedValueOnce(unknown)
    command.mockResolvedValueOnce(ensureReceipt).mockResolvedValueOnce(JSON.stringify(healthyStatus))
    await expect(launch(bridge)).rejects.toBe(unknown)
    expect(abandonInstall).not.toHaveBeenCalled()
    expect(command).toHaveBeenCalledTimes(2)
    expect(vi.mocked(publishG5ReconciliationRecord).mock.calls.map(([, , rec]) => rec.phase))
      .toEqual(['pending', 'qualified'])
  })

  it('serializes simultaneous Docker Ensure and Status operations on one complete native slot', async () => {
    const locked = new Set<string>()
    const waiters = new Map<string, (() => void)[]>()
    const norm = (value: string): string => value.replaceAll('\\', '/').toLowerCase()
    vi.mocked(acquireInstallLock).mockImplementation(async (_conn, directory, _host, opts) => {
      const key = norm(directory + '/' + (opts?.lockName ?? '.install-lock'))
      while (locked.has(key)) {
        await new Promise<void>((resolve) => {
          const pending = waiters.get(key) ?? []
          pending.push(resolve)
          waiters.set(key, pending)
        })
      }
      locked.add(key)
    })
    vi.mocked(releaseOwnedG5Lock).mockImplementation(async (_target, _slot, lockDir) => {
      const key = norm(lockDir)
      expect(locked.has(key)).toBe(true)
      locked.delete(key)
      waiters.get(key)?.shift()?.()
    })
    command.mockImplementation(async (_conn, line) => line.includes('Ensure')
      ? ensureReceipt
      : JSON.stringify(healthyStatus))
    await Promise.all([launch(bridge), launch(bridge)])
    expect(command.mock.calls.map(([, line]) => line.includes('Ensure') ? 'ensure' : 'status'))
      .toEqual(['ensure', 'status', 'ensure', 'status'])
    expect(acquireInstallLock).toHaveBeenCalledTimes(4)
    expect(releaseOwnedG5Lock).toHaveBeenCalledTimes(4)
    expect(abandonInstall).not.toHaveBeenCalled()
  })

  it('rejects a replacement container with the same image digest', async () => {
    command.mockResolvedValueOnce(ensureReceipt).mockResolvedValueOnce(
      JSON.stringify({ ...healthyStatus, containerId: 'd'.repeat(64) })
    )
    await expect(launch(bridge)).rejects.toThrow('live image/isolation/fallback/status mismatch')
  })

  it('rejects an unready V12 process despite a matching process name', async () => {
    command.mockResolvedValueOnce(ensureReceipt).mockResolvedValueOnce(
      JSON.stringify({ ...healthyStatus, healthy: false, protocolVersion: 0 })
    )
    await expect(launch(bridge)).rejects.toThrow('Docker verification failed')
    expect(finalizeInstall).not.toHaveBeenCalled()
  })

  it('rejects missing isolation and fallback evidence', async () => {
    command.mockResolvedValueOnce(ensureReceipt).mockResolvedValueOnce(
      JSON.stringify({ ...healthyStatus, network: 'bridge', fallback: false })
    )
    await expect(launch(bridge)).rejects.toThrow('Docker verification failed')
  })
})
