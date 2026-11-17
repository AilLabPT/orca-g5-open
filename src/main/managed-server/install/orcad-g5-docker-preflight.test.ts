import type * as ExecModule from '../../ssh/remote-exec/remote-exec-command'
import { beforeEach, describe, expect, it, vi } from 'vitest'
vi.mock('../../ssh/remote-exec/remote-exec-command', async (original) => ({
  ...(await original<typeof ExecModule>()),
  execCommand: vi.fn()
}))
import { execCommand } from '../../ssh/remote-exec/remote-exec-command'
import { getRemoteHostPlatform } from '../../ssh/ssh-remote-platform'
import { unusedOrcadHostTransport } from '../../ssh/unused-host-transport.test-fixture'
import { executeG5DockerOperation, readPinnedG5DockerContainerId } from './orcad-g5-docker-preflight'

const pinned='c'.repeat(64)
const container='g5-isolated'
const image=`sha256:${'a'.repeat(64)}`
const config={
  conn: unusedOrcadHostTransport(),
  host: getRemoteHostPlatform('win32-x64'),
  g5Docker: {
    adapterPath: 'C:\\g5\\adapter.ps1',
    container,
    expectedImageId: image
  }
}
const coordination={lockDir:'C:\\Users\\ASUS\\.orca-remote\\.g5-container-test.lock',
  ownerToken:'00000000-0000-0000-0000-000000000001'}
const status={
  containerId:pinned, image, network:'none', restart:'no', fallback:true, healthy:true,
  protocolVersion:54, windowsNativeUpdaterUnchanged:true, active:'v11', runningVersion:'v11'
}
const command=vi.mocked(execCommand)
beforeEach(()=>{
  command.mockReset().mockResolvedValue(JSON.stringify(status))
})
describe('G5 immutable Docker read-only preflight',()=>{
  it.each([
    { name: 'invalid digest', override: { expectedImageId: 'sha256:bad' } },
    { name: 'unsafe container', override: { container: 'unsafe;name' } },
    { name: 'unsafe adapter path', override: { adapterPath: 'C:\\bad%path\\adapter.ps1' } },
    { name: 'relative adapter path', override: { adapterPath: 'adapter.ps1' } }
  ])('rejects $name before the first remote command', async ({override}) => {
    await expect(readPinnedG5DockerContainerId({
      ...config,
      g5Docker: {...config.g5Docker, ...override}
    }, coordination)).rejects.toThrow()
    expect(command).not.toHaveBeenCalled()
  })
  it('rejects a missing owner token before the first remote command', async () => {
    await expect(readPinnedG5DockerContainerId(config, {
      ...coordination, ownerToken: ''
    })).rejects.toThrow('authority')
    expect(command).not.toHaveBeenCalled()
  })
  it('observes a healthy pinned container before mutation with no Apply',async()=>{
    await expect(readPinnedG5DockerContainerId(config,coordination)).resolves.toBe(pinned)
    expect(command).toHaveBeenCalledTimes(1)
    const shell=command.mock.calls[0]?.[1] ?? ''
    expect(shell).toContain('Status')
    expect(shell).toContain('ExpectedImageId')
    expect(shell).toContain('CoordinationLock')
    expect(shell).toContain('OwnerToken')
    expect(shell).not.toContain('Apply')
    expect(command.mock.calls[0]?.[2]?.wrapCommand).toBe(false)
  })
  it.each([
    {containerId:'bad'},
    {containerId:'d'.repeat(64),network:'bridge'},
    {healthy:false},
    {fallback:false},
    {image:`sha256:${'b'.repeat(64)}`},
    {protocolVersion:0}
  ])('fails closed on invalid Docker preflight evidence %#',async(override)=>{
    command.mockResolvedValueOnce(JSON.stringify({...status,...override}))
    await expect(readPinnedG5DockerContainerId(config,coordination))
      .rejects.toThrow('could not pin')
  })
})

describe('G5 Docker broker transport', () => {
  const brokerConfig = {
    ...config.g5Docker,
    broker: { clientPath: 'C:\\g5\\client.ps1', pipeName: 'g5-test-broker', serverPid: 42 }
  }

  it.each(['Status', 'Ensure', 'Recover', 'Rollback'] as const)(
    'sends %s to the authenticated broker client',
    async (operation) => {
      await executeG5DockerOperation(config, brokerConfig, coordination, operation, pinned)
      const shell = command.mock.calls[0]?.[1] ?? ''
      expect(shell).toContain(brokerConfig.broker.clientPath)
      expect(shell).toContain(operation)
      expect(shell).toContain(pinned)
      expect(shell).not.toContain(config.g5Docker.adapterPath)
    }
  )

  it('holds the installer fences when the broker mutation outcome is unknown', async () => {
    command.mockRejectedValueOnce(new Error('broker client disconnected'))
    await expect(
      executeG5DockerOperation(config, brokerConfig, coordination, 'Ensure', pinned)
    ).rejects.toMatchObject({ sshChannelCloseConfirmed: false })
  })
})
