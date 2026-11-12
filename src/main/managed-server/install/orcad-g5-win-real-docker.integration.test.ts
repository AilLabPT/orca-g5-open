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
import { execCommand } from '../../ssh/remote-exec/remote-exec-command'
import { getRemoteHostPlatform } from '../../ssh/ssh-remote-platform'
import { unusedOrcadHostTransport } from '../../ssh/unused-host-transport.test-fixture'
import { installOrcadBundle } from './orcad-remote-install'
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
beforeEach(()=>{vi.clearAllMocks()})
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
    let executed=''
    command.mockImplementation(async (_conn,line,config)=>{
      expect(config?.wrapCommand).toBe(false)
      executed=line
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
    expect(executed).toContain('powershell')
    expect(executed).toContain('Ensure')
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

