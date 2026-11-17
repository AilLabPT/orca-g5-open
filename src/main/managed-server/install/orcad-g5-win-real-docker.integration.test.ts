import type * as NativeLockModule from './remote-install-lock'
import type * as ReconciliationModule from './orcad-g5-reconciliation'
import type * as PreflightModule from './orcad-g5-docker-preflight'
import type * as ExecModule from '../../ssh/remote-exec/remote-exec-command'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir, homedir } from 'node:os'
import { join, basename } from 'node:path'
import { randomUUID } from 'node:crypto'
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
vi.mock('./orcad-g5-docker-preflight', async (original) => ({
  ...(await original<typeof PreflightModule>()),
  readPinnedG5DockerContainerId: vi.fn().mockResolvedValue('c'.repeat(64))
}))
vi.mock('./orcad-g5-reconciliation', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  readG5ReconciliationRecord: vi.fn().mockResolvedValue(null),
  publishG5ReconciliationRecord: vi.fn().mockResolvedValue(undefined),
  releaseOwnedG5Lock: vi.fn().mockResolvedValue(undefined)
}))
import { execCommand } from '../../ssh/remote-exec/remote-exec-command'
import { getRemoteHostPlatform, joinRemotePath } from '../../ssh/ssh-remote-platform'
import { unusedOrcadHostTransport } from '../../ssh/unused-host-transport.test-fixture'
import { installOrcadBundle } from './orcad-remote-install'
import { cachedOrcadSlotInstalled } from './orcad-remote-install-cached-probe'
import { isRemoteInstallComplete, finalizeInstall } from './remote-versioned-install'
import { uploadRemoteInstallDirectory } from './remote-install-transfers'
import {
  readG5ReconciliationRecord,
  publishG5ReconciliationRecord,
  releaseOwnedG5Lock
} from './orcad-g5-reconciliation'
import { acquireInstallLock } from './remote-install-lock'
import { g5ContainerLockName } from './orcad-g5-reconciliation'
import {
  orcadWindowsNodeCommandLine,
  orcadWindowsBaseDir,
  orcadWindowsPinnedNodePath
} from './orcad-remote-windows-node'
import {
  ORCAD_WINDOWS_HOST_SCRIPT,
  ORCAD_WINDOWS_HOST_SCRIPT_FILENAME
} from '../host-state/orcad-windows-host-script'
import { readPinnedG5DockerContainerId } from './orcad-g5-docker-preflight'
import { abandonInstall } from './remote-versioned-install'
const name = process.env.G5_WINDOWS_TEST_CONTAINER
const image = process.env.G5_WINDOWS_TEST_IMAGE
const adapter = process.env.G5_WINDOWS_TEST_ADAPTER
// This suite exercises real Windows PowerShell + Docker commands but intentionally
// mocks the native installer transfer/finalize layers. Never report it as an SSH E2E.
const ready = process.platform === 'win32' && Boolean(name && image && adapter)
const canonicalRoot = join(homedir(), '.orca-remote')
const command = vi.mocked(execCommand)
const host = getRemoteHostPlatform('win32-x64')
const conn = unusedOrcadHostTransport()
function launch(
  g5Docker?: { adapterPath: string; container: string; expectedImageId: string },
  slot = join(canonicalRoot, 'g5-isolated-native-slot')
) {
  return installOrcadBundle(
    {
      conn,
      host,
      localOrcadDir: 'C:/g5-isolated-test/orcad',
      target: 'win32-x64',
      nodeRuntimeArchive: async () => 'C:/g5-isolated-test/node-archive',
      recordedNodeRuntimeProbe: true,
      ...(g5Docker ? { g5Docker } : {})
    },
    '0.2.0+g5isolated',
    slot
  )
}
const option = () => ({ adapterPath: adapter!, container: name!, expectedImageId: image! })
function docker(...args: string[]): string {
  return execFileSync('docker', args, {
    encoding: 'utf8',
    timeout: 25000,
    windowsHide: true
  }).trim()
}
beforeEach(() => {
  // Reset implementations as well as call history so live Docker mocks
  // cannot leak into the following fail-closed unit qualification.
  vi.resetAllMocks()
  vi.mocked(cachedOrcadSlotInstalled).mockResolvedValue(true)
  vi.mocked(isRemoteInstallComplete).mockResolvedValue(true)
  vi.mocked(finalizeInstall).mockResolvedValue(undefined)
  vi.mocked(readG5ReconciliationRecord).mockResolvedValue(null)
  vi.mocked(readPinnedG5DockerContainerId).mockResolvedValue('c'.repeat(64))
  vi.mocked(publishG5ReconciliationRecord).mockResolvedValue(undefined)
  vi.mocked(releaseOwnedG5Lock).mockResolvedValue(undefined)
  vi.mocked(acquireInstallLock).mockResolvedValue(undefined)
  vi.mocked(abandonInstall).mockResolvedValue(true)
})
describe.skipIf(!ready)(
  'real Windows locks and Docker with mocked native transfer/finalization',
  () => {
    it('keeps native Windows install unchanged without opt-in', async () => {
      command.mockImplementation(async () => {
        throw new Error('unexpected remote call')
      })
      await expect(launch()).resolves.toBeUndefined()
      expect(command).not.toHaveBeenCalled()
    })
    it('rejects invalid image identity before a Windows host command', async () => {
      command.mockImplementation(async () => {
        throw new Error('should not run remote command')
      })
      await expect(launch({ ...option(), expectedImageId: 'sha256:bad' })).rejects.toThrow()
      expect(command).not.toHaveBeenCalled()
    })
    it('rolls out and rolls back an isolated immutable container under native locks', async () => {
      const native = await vi.importActual<typeof NativeLockModule>('./remote-install-lock')
      const reconciliation = await vi.importActual<typeof ReconciliationModule>(
        './orcad-g5-reconciliation'
      )
      const preflight = await vi.importActual<typeof PreflightModule>('./orcad-g5-docker-preflight')
      vi.mocked(readPinnedG5DockerContainerId).mockImplementation(
        preflight.readPinnedG5DockerContainerId
      )
      expect(docker('inspect', name!, '--format', '{{.Image}}')).toBe(image)
      const fixture = `g5-integration-${randomUUID()}`
      const lockDir = join(canonicalRoot, g5ContainerLockName(fixture))
      const slot = join(canonicalRoot, fixture)
      const scratch = mkdtempSync(join(tmpdir(), 'g5-native-host-'))
      const script = join(scratch, ORCAD_WINDOWS_HOST_SCRIPT_FILENAME)
      const hostBaseDir = orcadWindowsBaseDir(host, slot)
      const remotePrefix = orcadWindowsNodeCommandLine(
        orcadWindowsPinnedNodePath(host, hostBaseDir),
        [joinRemotePath(host, hostBaseDir, ORCAD_WINDOWS_HOST_SCRIPT_FILENAME)]
      )
      const localPrefix = orcadWindowsNodeCommandLine(process.execPath, [script])
      const executed: string[] = []
      const owned = new Map<string, string>()
      let containerId: string | undefined
      const assertOwned = (path: string, token: string): void => {
        expect(readFileSync(join(path, '.orca-fence-owner'), 'utf8')).toBe(token)
        expect(existsSync(join(path, '.owner'))).toBe(true)
      }
      vi.mocked(acquireInstallLock).mockImplementation(async (...args) => {
        await native.acquireInstallLock(...args)
        const path = join(args[1], args[3]?.lockName ?? '.install-lock')
        const token = args[3]?.owner?.token
        if (!token) {
          throw new Error('Missing native test lock owner')
        }
        owned.set(path, token)
        assertOwned(path, token)
      })
      vi.mocked(releaseOwnedG5Lock).mockImplementation(async (...args) => {
        assertOwned(args[2], args[3])
        await reconciliation.releaseOwnedG5Lock(...args)
        expect(existsSync(args[2])).toBe(false)
        // Host command paths may use '/' while the local Windows Map key uses '\\'.
        // Reconcile equal paths before final cleanup; never retain a released owner.
        const actualKey = [...owned.keys()].find((key) =>
          key.replaceAll('\\', '/').toLowerCase() === args[2].replaceAll('\\', '/').toLowerCase()
        )
        expect(actualKey).toBeDefined()
        owned.delete(actualKey!)
      })
      command.mockImplementation(async (_conn, line, config) => {
        expect(config?.wrapCommand).toBe(false)
        executed.push(line)
        // Simulate only transport/runtime location; execute the native host script unchanged.
        const localLine = line.startsWith(remotePrefix)
          ? localPrefix + line.slice(remotePrefix.length)
          : line
        const batchDir = mkdtempSync(join(scratch, 'command-'))
        const batch = join(batchDir, 'invoke.cmd')
        writeFileSync(batch, `@echo off\r\n${localLine}\r\n`)
        try {
          return execFileSync('cmd.exe', ['/d', '/c', batch], {
            encoding: 'utf8',
            timeout: 35000,
            windowsHide: true
          })
        } finally {
          rmSync(batchDir, { recursive: true, force: true })
        }
      })
      const config = { adapterPath: adapter!, container: fixture, expectedImageId: image! }
      const runAdapter = (action: string, token: string): string =>
        execFileSync(
          'powershell.exe',
          [
            '-NoProfile',
            '-NonInteractive',
            '-File',
            adapter!,
            '-Action',
            action,
            ...(action === 'Status' ? [] : ['-Apply']),
            '-Container',
            fixture,
            '-ExpectedImageId',
            image!,
            '-CoordinationLock',
            lockDir,
            '-OwnerToken',
            token,
            ...(containerId ? ['-ExpectedContainerId', containerId] : [])
          ],
          { encoding: 'utf8', timeout: 40000, windowsHide: true }
        )
      const waitRuntime = async (version: string): Promise<void> => {
        for (let i = 0; i < 80; i++) {
          try {
            const token = owned.get(lockDir)
            if (!token) {
              throw new Error('Missing status lock owner')
            }
            const status: unknown = JSON.parse(
              runAdapter('Status', token).trim().split(/\r?\n/u).at(-1) ?? ''
            )
            if (
              typeof status === 'object' &&
              status !== null &&
              'containerId' in status &&
              status.containerId === containerId &&
              'runningVersion' in status &&
              status.runningVersion === version &&
              'healthy' in status &&
              status.healthy === true &&
              'protocolVersion' in status &&
              status.protocolVersion === 54
            ) {
              return
            }
          } catch {}
          await new Promise((r) => setTimeout(r, 300))
        }
        throw new Error(`Isolated Docker runtime failed to qualify ${version}`)
      }
      const withLock = async (work: (token: string) => Promise<void>): Promise<void> => {
        const token = randomUUID()
        await acquireInstallLock(conn, canonicalRoot, host, {
          lockName: basename(lockDir),
          relayGcClaim: false,
          allowStaleTakeover: false,
          waitTimeoutMs: 0,
          owner: { fileName: '.orca-fence-owner', token }
        })
        try {
          await work(token)
        } finally {
          await releaseOwnedG5Lock({ conn, host }, slot, lockDir, token)
        }
      }
      try {
        writeFileSync(script, ORCAD_WINDOWS_HOST_SCRIPT)
        // The supplied fixture is read-only. Only this newly created container is mutated.
        containerId = docker(
          'create',
          '--name',
          fixture,
          '--network',
          'none',
          '--restart',
          'no',
          '--env',
          'ORCA_USER_DATA=/tmp/g5-orca-user',
          image!
        )
        expect(containerId).toMatch(/^[a-f0-9]{64}$/u)
        docker('start', containerId)
        await withLock(async (token) => {
          await waitRuntime('v11')
          expect(
            await preflight.readPinnedG5DockerContainerId(
              { conn, host, g5Docker: config },
              { lockDir, ownerToken: token }
            )
          ).toBe(containerId)
        })
        expect(docker('exec', containerId, 'readlink', '/home/node/g5-managed/active')).toBe(
          'versions/v11'
        )
        docker(
          'exec',
          containerId,
          'sh',
          '-c',
          "printf 'G5_PERSIST_246' > /home/node/g5-managed/persistence-proof.txt"
        )
        await expect(launch(config, slot)).rejects.toThrow('G5 selected but V12 not running')
        expect(
          executed.some((line) => line.includes('Ensure') && line.includes(containerId!))
        ).toBe(true)
        expect(docker('exec', containerId, 'readlink', '/home/node/g5-managed/active')).toBe(
          'versions/v12'
        )
        docker('restart', containerId)
        await withLock(async () => {
          await waitRuntime('v12')
        })
        await expect(launch(config, slot)).resolves.toBeUndefined()
        await withLock(async (token) => {
          assertOwned(lockDir, token)
          const receipt: unknown = JSON.parse(
            runAdapter('Rollback', token).trim().split(/\r?\n/u).at(-1) ?? ''
          )
          expect(receipt).toMatchObject({ active: 'v11' })
          docker('restart', containerId!)
          await waitRuntime('v11')
          expect(
            docker('exec', containerId!, 'cat', '/home/node/g5-managed/persistence-proof.txt')
          ).toBe('G5_PERSIST_246')
        })
        expect(owned.size).toBe(0)
      } finally {
        try {
          for (const [path, token] of owned) {
            assertOwned(path, token)
            await reconciliation.releaseOwnedG5Lock({ conn, host }, slot, path, token)
            expect(existsSync(path)).toBe(false)
          }
        } finally {
          try {
            if (containerId) {
              docker('rm', '-f', '-v', containerId)
            }
          } finally {
            if (existsSync(slot) && !existsSync(join(slot, '.install-lock'))) {
              rmSync(slot, { recursive: true, force: true })
            }
            rmSync(scratch, { recursive: true, force: true })
          }
        }
      }
    }, 240000)
  }
)

describe('G5 Docker bridge fail-closed status qualification', () => {
  const bridge = {
    adapterPath: 'C:\\g5-isolated-test\\adapter.ps1',
    container: 'g5-qualifier',
    expectedImageId: `sha256:${'a'.repeat(64)}`
  }
  const containerId = 'c'.repeat(64)
  const ensureReceipt = JSON.stringify({
    active: 'v12',
    runningVersion: 'v12',
    restartRequired: false,
    containerId
  })
  const healthyStatus = {
    active: 'v12',
    runningVersion: 'v12',
    fallback: true,
    image: bridge.expectedImageId,
    network: 'none',
    restart: 'no',
    containerId,
    healthy: true,
    protocolVersion: 54,
    windowsNativeUpdaterUnchanged: true
  }
  beforeEach(() => {
    command
      .mockReset()
      .mockImplementation(async (_conn, line) =>
        line.includes('Ensure') ? ensureReceipt : JSON.stringify(healthyStatus)
      )
  })

  it('requires an independent read-only Status observation after Ensure', async () => {
    command
      .mockResolvedValueOnce(ensureReceipt)
      .mockResolvedValueOnce(JSON.stringify(healthyStatus))
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
    command
      .mockResolvedValueOnce(ensureReceipt)
      .mockResolvedValueOnce(
        JSON.stringify({ ...healthyStatus, image: `sha256:${'b'.repeat(64)}` })
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
    command
      .mockResolvedValueOnce(ensureReceipt)
      .mockResolvedValueOnce(JSON.stringify({ ...healthyStatus, network: 'bridge' }))
    await expect(launch(bridge)).rejects.toThrow('Docker verification failed')
    expect(uploadRemoteInstallDirectory).toHaveBeenCalledTimes(1)
    expect(finalizeInstall).not.toHaveBeenCalled()
  })

  it('marks a fresh native install complete only after independent Docker status succeeds', async () => {
    vi.mocked(cachedOrcadSlotInstalled).mockResolvedValue(false)
    vi.mocked(isRemoteInstallComplete).mockResolvedValue(false)
    command
      .mockResolvedValueOnce(ensureReceipt)
      .mockResolvedValueOnce(JSON.stringify(healthyStatus))
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
    command
      .mockResolvedValueOnce(ensureReceipt)
      .mockResolvedValueOnce(JSON.stringify(healthyStatus))
    await expect(launch(bridge)).rejects.toThrow('simulated native finalization failure')
    expect(finalizeInstall).toHaveBeenCalledTimes(1)
    // A retry must independently qualify the sidecar again, not trust the earlier receipt.
    command
      .mockResolvedValueOnce(ensureReceipt)
      .mockResolvedValueOnce(JSON.stringify(healthyStatus))
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
    expect(
      vi.mocked(publishG5ReconciliationRecord).mock.calls.map(([, , rec]) => rec.phase)
    ).toEqual(['pending'])
    expect(finalizeInstall).not.toHaveBeenCalled()
    expect(abandonInstall).not.toHaveBeenCalled()
  })

  it('rejects an old conflicting image journal before touching native slot bytes or Docker', async () => {
    vi.mocked(cachedOrcadSlotInstalled).mockResolvedValue(false)
    vi.mocked(isRemoteInstallComplete).mockResolvedValue(false)
    vi.mocked(readG5ReconciliationRecord).mockResolvedValueOnce({
      schema: 1,
      container: bridge.container,
      imageId: `sha256:${'b'.repeat(64)}`,
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
    command
      .mockResolvedValueOnce(ensureReceipt)
      .mockResolvedValueOnce(JSON.stringify(healthyStatus))
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
    command
      .mockResolvedValueOnce(ensureReceipt)
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
    command
      .mockResolvedValueOnce(ensureReceipt)
      .mockResolvedValueOnce(JSON.stringify(healthyStatus))
    await expect(launch(bridge)).rejects.toBe(unknown)
    expect(abandonInstall).not.toHaveBeenCalled()
    expect(command).toHaveBeenCalledTimes(2)
    expect(
      vi.mocked(publishG5ReconciliationRecord).mock.calls.map(([, , rec]) => rec.phase)
    ).toEqual(['pending', 'qualified'])
  })

  it('serializes simultaneous Docker Ensure and Status operations on one complete native slot', async () => {
    const locked = new Set<string>()
    const waiters = new Map<string, (() => void)[]>()
    const norm = (value: string): string => value.replaceAll('\\', '/').toLowerCase()
    vi.mocked(acquireInstallLock).mockImplementation(async (_conn, directory, _host, opts) => {
      const key = norm(`${directory}/${opts?.lockName ?? '.install-lock'}`)
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
    command.mockImplementation(async (_conn, line) =>
      line.includes('Ensure') ? ensureReceipt : JSON.stringify(healthyStatus)
    )
    await Promise.all([launch(bridge), launch(bridge)])
    expect(
      command.mock.calls.map(([, line]) => (line.includes('Ensure') ? 'ensure' : 'status'))
    ).toEqual(['ensure', 'status', 'ensure', 'status'])
    expect(acquireInstallLock).toHaveBeenCalledTimes(4)
    expect(releaseOwnedG5Lock).toHaveBeenCalledTimes(4)
    expect(abandonInstall).not.toHaveBeenCalled()
  })

  it('rejects a replacement container with the same image digest', async () => {
    command
      .mockResolvedValueOnce(ensureReceipt)
      .mockResolvedValueOnce(JSON.stringify({ ...healthyStatus, containerId: 'd'.repeat(64) }))
    await expect(launch(bridge)).rejects.toThrow('live image/isolation/fallback/status mismatch')
  })

  it('rejects an unready V12 process despite a matching process name', async () => {
    command
      .mockResolvedValueOnce(ensureReceipt)
      .mockResolvedValueOnce(
        JSON.stringify({ ...healthyStatus, healthy: false, protocolVersion: 0 })
      )
    await expect(launch(bridge)).rejects.toThrow('Docker verification failed')
    expect(finalizeInstall).not.toHaveBeenCalled()
  })

  it('writes the verified immutable ID into pending before any Docker mutation', async () => {
    vi.mocked(cachedOrcadSlotInstalled).mockResolvedValue(false)
    vi.mocked(isRemoteInstallComplete).mockResolvedValue(false)
    command
      .mockResolvedValueOnce(ensureReceipt)
      .mockResolvedValueOnce(JSON.stringify(healthyStatus))
    await launch(bridge)
    const record = vi.mocked(publishG5ReconciliationRecord).mock.calls[0]?.[2]
    expect(record?.phase).toBe('pending')
    expect(record?.containerId).toBe('c'.repeat(64))
    expect(vi.mocked(readPinnedG5DockerContainerId).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(publishG5ReconciliationRecord).mock.invocationCallOrder[0]
    )
    expect(vi.mocked(publishG5ReconciliationRecord).mock.invocationCallOrder[0]).toBeLessThan(
      command.mock.invocationCallOrder[0]
    )
  })

  it('does not mutate Docker when a read-only immutable ID preflight fails', async () => {
    vi.mocked(cachedOrcadSlotInstalled).mockResolvedValue(false)
    vi.mocked(isRemoteInstallComplete).mockResolvedValue(false)
    vi.mocked(readPinnedG5DockerContainerId).mockRejectedValueOnce(
      new Error('immutable preflight cannot qualify')
    )
    await expect(launch(bridge)).rejects.toThrow('immutable preflight cannot qualify')
    expect(command).not.toHaveBeenCalled()
    expect(publishG5ReconciliationRecord).not.toHaveBeenCalled()
    expect(finalizeInstall).not.toHaveBeenCalled()
  })

  it('rejects missing isolation and fallback evidence', async () => {
    command
      .mockResolvedValueOnce(ensureReceipt)
      .mockResolvedValueOnce(
        JSON.stringify({ ...healthyStatus, network: 'bridge', fallback: false })
      )
    await expect(launch(bridge)).rejects.toThrow('Docker verification failed')
  })
})
