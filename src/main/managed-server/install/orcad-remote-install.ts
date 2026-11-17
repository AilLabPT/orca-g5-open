import { randomUUID } from 'node:crypto'
import { orcadWindowsNodeCommandLine } from './orcad-remote-windows-node'
import { orcadNodePtyNativeArtifacts, orcadRipgrepArtifact } from '../../../shared/orcad-artifacts'
import { orcadAgentBrowserNativeName } from '../../../shared/orcad-agent-browser-name'
import type { NodeRuntimeTarget } from '../../../shared/node-runtime-pin'
import { ensureRemoteOrcadNodeRuntime } from './orcad-remote-node-runtime'
import { recordedRemoteNodeRuntimeProbeCommand } from './orcad-remote-node-runtime-recorded-probe'
import { cachedOrcadSlotInstalled } from './orcad-remote-install-cached-probe'
import {
  execCommand,
  isUnconfirmedSshCommandTermination
} from '../../ssh/remote-exec/remote-exec-command'
import { quotePosixShell } from '../../../shared/shell-argument-quoting'
import type { OrcadHostTransport } from '../../ssh/orcad-host-transport'
import { joinRemotePath, type RemoteHostPlatform } from '../../ssh/ssh-remote-platform'
import { ORCAD_INSTALL_MODEL } from './remote-install-model'
import { acquireInstallLock } from './remote-install-lock'
import { ORCAD_FENCE_OWNER_FILENAME } from '../activation/orcad-activation-fence-scope'
import { forgetHeldOrcadFence, rememberHeldOrcadFence } from '../../ssh/orcad-held-fence-tokens'
import { exitedOwnLockProof } from '../../ssh/orcad-exited-own-lock'
import { orcadWindowsBaseDir } from './orcad-remote-windows-node'
import { uploadRemoteInstallDirectory, writeRemoteInstallFile } from './remote-install-transfers'
import {
  abandonInstall,
  finalizeInstall,
  isRemoteInstallComplete
} from './remote-versioned-install'
import {
  assertCompatibleG5ReconciliationRecord,
  g5ContainerLockDir,
  g5ContainerLockName,
  g5NativeLockDir,
  publishG5ReconciliationRecord,
  readG5ReconciliationRecord,
  releaseOwnedG5Lock,
  type G5ReconciliationRecord
} from './orcad-g5-reconciliation'

type G5Coordination = { lockDir: string; ownerToken: string }

async function ensureOptionalG5Docker(
  options: Parameters<typeof installOrcadBundle>[0],
  coordination: G5Coordination
): Promise<void> {
  const config = options.g5Docker
  if (!config) return
  if (options.host.os !== 'win32') {
    throw new Error('G5 Docker bridge requires Windows native updater host')
  }
  if (!/^sha256:[a-f0-9]{64}$/u.test(config.expectedImageId)) {
    throw new Error('G5 Docker image identity missing or invalid')
  }
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/u.test(config.container)) {
    throw new Error('G5 Docker container name invalid')
  }
  if (!/^[A-Za-z]:\\/u.test(config.adapterPath) ||
      !config.adapterPath.toLowerCase().endsWith('.ps1') ||
      config.adapterPath.split('').some((ch) =>
        ['%', '$', String.fromCharCode(10), String.fromCharCode(13),
         String.fromCharCode(34), String.fromCharCode(96)].includes(ch))) {
    throw new Error('G5 Docker adapter must use an absolute safe Windows PS1 path')
  }
  const command = orcadWindowsNodeCommandLine('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-File', config.adapterPath,
    '-Action', 'Ensure', '-Container', config.container,
    '-ExpectedImageId', config.expectedImageId, '-Apply',
    '-CoordinationLock', coordination.lockDir,
    '-OwnerToken', coordination.ownerToken
  ])
  const result = await execCommand(options.conn, command, {
    wrapCommand: false,
    signal: options.signal
  })
  const line = result.trim().split(/\r?\n/u).at(-1) ?? ''
  const parsed: unknown = JSON.parse(line)
  if (typeof parsed !== 'object' || parsed === null ||
      !('active' in parsed) || parsed.active !== 'v12' ||
      !('runningVersion' in parsed) || parsed.runningVersion !== 'v12' ||
      !('restartRequired' in parsed) || parsed.restartRequired !== false ||
      !('containerId' in parsed) || typeof parsed.containerId !== 'string' ||
      !/^[a-f0-9]{64}$/u.test(parsed.containerId)) {
    throw new Error('G5 selected but V12 not running: controlled restart and health qualification required')
  }
  await verifyOptionalG5DockerStatus(options, coordination, parsed.containerId)
}

/** A fresh read-only observation used also after an uncertain native finalization. */
async function verifyOptionalG5DockerStatus(
  options: Parameters<typeof installOrcadBundle>[0],
  coordination: G5Coordination,
  expectedContainerId?: string
): Promise<void> {
  const config = options.g5Docker
  if (!config) return
  // A mutation receipt alone is insufficient: query the adapter again without -Apply.
  // The adapter's Status path independently inspects Docker's pinned image, isolation
  // and the live PID 1 command line. Treat this as a second observation, not proof
  // of cross-system atomicity.
  const statusCommand = orcadWindowsNodeCommandLine('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-File', config.adapterPath,
    '-Action', 'Status', '-Container', config.container,
    '-ExpectedImageId', config.expectedImageId,
    '-CoordinationLock', coordination.lockDir,
    '-OwnerToken', coordination.ownerToken
  ])
  const statusOutput = await execCommand(options.conn, statusCommand, {
    wrapCommand: false,
    signal: options.signal
  })
  const statusLine = statusOutput.trim().split(/\r?\n/u).at(-1) ?? ''
  const status: unknown = JSON.parse(statusLine)
  if (typeof status !== 'object' || status === null ||
      !('active' in status) || status.active !== 'v12' ||
      !('runningVersion' in status) || status.runningVersion !== 'v12' ||
      !('fallback' in status) || status.fallback !== true ||
      !('image' in status) || status.image !== config.expectedImageId ||
      !('network' in status) || status.network !== 'none' ||
      !('restart' in status) || status.restart !== 'no' ||
      !('windowsNativeUpdaterUnchanged' in status) ||
      status.windowsNativeUpdaterUnchanged !== true ||
      !('containerId' in status) || typeof status.containerId !== 'string' ||
      !/^[a-f0-9]{64}$/u.test(status.containerId) ||
      (expectedContainerId !== undefined && status.containerId !== expectedContainerId) ||
      !('healthy' in status) || status.healthy !== true ||
      !('protocolVersion' in status) || status.protocolVersion !== 54) {
    throw new Error('G5 Docker verification failed: live image/isolation/fallback/status mismatch')
  }
}

/** Shared by all native versions of one G5 container. Locks are never stolen based on
 * age: a surviving old Docker worker cannot be proven terminated by an expired timestamp.
 * Cooperative external adapter commands must also validate this owner token.
 */
async function withG5ContainerLock(
  options: Parameters<typeof installOrcadBundle>[0],
  remoteDir: string,
  token: string,
  work: (coordination: G5Coordination) => Promise<void>
): Promise<void> {
  const config = options.g5Docker
  if (!config) return work({ lockDir: '', ownerToken: token })
  if (options.host.os !== 'win32') {
    throw new Error('G5 Docker coordination requires a Windows host')
  }
  const lockDir = g5ContainerLockDir(options, remoteDir, config.container)
  await acquireInstallLock(
    options.conn, orcadWindowsBaseDir(options.host, remoteDir), options.host, {
      signal: options.signal,
      lockName: g5ContainerLockName(config.container),
      relayGcClaim: false,
      allowStaleTakeover: false,
      waitTimeoutMs: 30_000,
      owner: { fileName: ORCAD_FENCE_OWNER_FILENAME, token }
    }
  )
  let preserve = false
  try {
    await work({ lockDir, ownerToken: token })
  } catch (error) {
    preserve = isUnconfirmedSshCommandTermination(error)
    throw error
  } finally {
    if (!preserve) {
      await releaseOwnedG5Lock(options, remoteDir, lockDir, token)
    }
  }
}

/** Reconcile interrupted deployments forward, but only against the same image and slot.
 * The journal is published atomically on the Windows host under the native slot lock.
 * No automatic Docker rollback is attempted without end-to-end mutation ownership.
 */
async function prepareG5Reconciliation(
  options: Parameters<typeof installOrcadBundle>[0],
  remoteDir: string,
  nativeVersion: string,
  token: string
): Promise<G5ReconciliationRecord | null> {
  const config = options.g5Docker
  if (!config) return null
  const current = await readG5ReconciliationRecord(options, remoteDir, token)
  assertCompatibleG5ReconciliationRecord(current, config, nativeVersion)
  const record: G5ReconciliationRecord = {
    schema: 1,
    container: config.container,
    imageId: config.expectedImageId,
    nativeVersion,
    ownerToken: token,
    phase: 'pending'
  }
  return record
}

async function reconcileG5OnSlot(
  options: Parameters<typeof installOrcadBundle>[0],
  remoteDir: string,
  fullVersion: string,
  token: string
): Promise<void> {
  const record = await prepareG5Reconciliation(options, remoteDir, fullVersion, token)
  if (!record) return
  const coordination: G5Coordination = {
    lockDir: g5ContainerLockDir(options, remoteDir, record.container),
    ownerToken: token
  }
  await publishG5ReconciliationRecord(options, remoteDir, record)
  await ensureOptionalG5Docker(options, coordination)
  await publishG5ReconciliationRecord(options, remoteDir, {
    ...record,
    phase: 'qualified'
  })
}

/** Existing complete slots must use the same per-slot lock as initial installs.
 * Concurrent G5 operations through this installer cannot interleave Ensure/Status.
 */
async function reconcileG5OnCompleteSlot(
  options: Parameters<typeof installOrcadBundle>[0],
  remoteDir: string,
  fullVersion: string
): Promise<void> {
  if (!options.g5Docker) return
  const token = randomUUID()
  rememberHeldOrcadFence(token)
  try {
    await acquireInstallLock(options.conn, remoteDir, options.host, {
      signal: options.signal,
      owner: { fileName: ORCAD_FENCE_OWNER_FILENAME, token },
      allowStaleTakeover: false
    })
  } catch (error) {
    if (!isUnconfirmedSshCommandTermination(error)) {
      forgetHeldOrcadFence(token)
    }
    throw error
  }
  let preserveInstallLock = false
  try {
    if (!(await isRemoteInstallComplete(
      options.conn, ORCAD_INSTALL_MODEL, remoteDir, options.host, {
        signal: options.signal
      }
    ))) {
      throw new Error('G5 reconciliation requires a complete native slot; retry installation')
    }
    await withG5ContainerLock(options, remoteDir, token, async () => {
      await reconcileG5OnSlot(options, remoteDir, fullVersion, token)
    })
  } catch (error) {
    preserveInstallLock = isUnconfirmedSshCommandTermination(error)
    throw error
  } finally {
    if (!preserveInstallLock) {
      await releaseOwnedG5Lock(options, remoteDir, g5NativeLockDir(options, remoteDir), token)
      forgetHeldOrcadFence(token)
    }
  }
}

export async function installOrcadBundle(
  options: {
    conn: OrcadHostTransport
    host: RemoteHostPlatform
    localOrcadDir: string
    target: NodeRuntimeTarget
    /** Lazily acquire verified runtime bytes only if the host needs them. */
    nodeRuntimeArchive: () => Promise<string>
    /** Offline archive location named when downloads fail. */
    nodeRuntimeOfflineArchivePath?: string
    /** Per-source connect budget for the host's own download fallback. */
    nodeRuntimeHostConnectTimeoutSeconds?: number
    /** WSL opt-in: reuse a matching stat signature previously hashed to this pin. */
    recordedNodeRuntimeProbe?: boolean
    /** Explicit opt-in to verified Linux G5 sidecar. Never changes native Windows runtime. */
    g5Docker?: {
      adapterPath: string
      container: string
      expectedImageId: string
    }
    signal?: AbortSignal
  },
  fullVersion: string,
  remoteDir: string
): Promise<void> {
  if (options.recordedNodeRuntimeProbe && (await cachedOrcadSlotInstalled(options, remoteDir))) {
    await reconcileG5OnCompleteSlot(options, remoteDir, fullVersion)
    return
  }
  // Existing slot bytes are unusable without their referenced runtime.
  await ensureRemoteOrcadNodeRuntime({
    conn: options.conn,
    host: options.host,
    slotDir: remoteDir,
    target: options.target,
    archivePath: options.nodeRuntimeArchive,
    offlineArchivePath: options.nodeRuntimeOfflineArchivePath,
    hostConnectTimeoutSeconds: options.nodeRuntimeHostConnectTimeoutSeconds,
    signal: options.signal,
    ...(options.recordedNodeRuntimeProbe
      ? { posixProbeCommand: recordedRemoteNodeRuntimeProbeCommand }
      : {})
  })
  if (
    await isRemoteInstallComplete(options.conn, ORCAD_INSTALL_MODEL, remoteDir, options.host, {
      signal: options.signal
    })
  ) {
    await reconcileG5OnCompleteSlot(options, remoteDir, fullVersion)
    return
  }
  // Persist the token so a relaunch can prove ownership of an interrupted upload lock.
  const token = randomUUID()
  rememberHeldOrcadFence(token)
  try {
    await acquireInstallLock(options.conn, remoteDir, options.host, {
      signal: options.signal,
      owner: { fileName: ORCAD_FENCE_OWNER_FILENAME, token },
      // G5 operations mutate a separate Docker process. A stale timestamp cannot
      // prove an old worker has stopped, so automatic takeover is forbidden.
      ...(options.g5Docker
        ? { allowStaleTakeover: false }
        : { exitedOwner: exitedOwnLockProof(options, {
            baseDir: orcadWindowsBaseDir(options.host, remoteDir),
            guardsStateMutation: false
          }) })
    })
  } catch (error) {
    if (!isUnconfirmedSshCommandTermination(error)) {
      forgetHeldOrcadFence(token)
    }
    throw error
  }
  let preserveInstallLock = false
  try {
    // A sibling may have completed deployment while this client waited for the lock.
    if (
      await isRemoteInstallComplete(options.conn, ORCAD_INSTALL_MODEL, remoteDir, options.host, {
        signal: options.signal
      })
    ) {
      await withG5ContainerLock(options, remoteDir, token, async () => {
        await reconcileG5OnSlot(options, remoteDir, fullVersion, token)
      })
      return
    }
    // Check previous durable intent before touching slot bytes.
    // A conflicting pinned image/container must not silently take over a prior attempt.
    const priorG5 = options.g5Docker
      ? await readG5ReconciliationRecord(options, remoteDir, token)
      : null
    if (options.g5Docker) {
      assertCompatibleG5ReconciliationRecord(priorG5, options.g5Docker, fullVersion)
    }
    await uploadRemoteInstallDirectory(
      options.conn,
      options.localOrcadDir,
      remoteDir,
      options.host,
      {
        signal: options.signal
      }
    )
    if (options.host.os !== 'win32') {
      await execCommand(
        options.conn,
        executablePermissionsCommand(options.host, remoteDir, options.target),
        {
          wrapCommand: options.host.commandDialect !== 'powershell',
          signal: options.signal
        }
      )
    }
    await writeRemoteInstallFile(
      options.conn,
      options.host,
      joinRemotePath(options.host, remoteDir, ORCAD_INSTALL_MODEL.versionFilename),
      fullVersion,
      { signal: options.signal }
    )
    // Publish durable intent, then independently qualify Docker before marking native complete.
    // The next attempt can resume a pending/qualified record with the same immutable pins.
    const finalizeAndReconcile = async (coordination: G5Coordination): Promise<void> => {
      if (options.g5Docker) {
        await reconcileG5OnSlot(options, remoteDir, fullVersion, token)
      }
      try {
        await finalizeInstall(options.conn, remoteDir, options.host, {
          signal: options.signal,
          releaseLock: false
        })
      } catch (error) {
        // A confirmed error can occur after the marker was actually written.
        // Recheck both authorities under the same container lock, never roll back
        // Docker without mutation ownership proof.
        if (!options.g5Docker || isUnconfirmedSshCommandTermination(error)) throw error
        const committed = await isRemoteInstallComplete(
          options.conn, ORCAD_INSTALL_MODEL, remoteDir, options.host, {
            signal: options.signal
          }
        )
        if (!committed) throw error
        await verifyOptionalG5DockerStatus(options, coordination)
      }
      // The final native slot completion can be followed by a concurrent
      // external Docker replacement. Observe once more under the coordination lock.
      if (options.g5Docker) {
        await verifyOptionalG5DockerStatus(options, coordination)
      }
    }
    if (options.g5Docker) {
      await withG5ContainerLock(options, remoteDir, token, finalizeAndReconcile)
    } else {
      await finalizeAndReconcile({ lockDir: '', ownerToken: token })
    }
  } catch (error) {
    preserveInstallLock = isUnconfirmedSshCommandTermination(error)
    throw error
  } finally {
    if (!preserveInstallLock) {
      // Retain ownership proof if interrupted cleanup cannot confirm lock removal.
      if (options.g5Docker) {
        await releaseOwnedG5Lock(options, remoteDir, g5NativeLockDir(options, remoteDir), token)
        forgetHeldOrcadFence(token)
      } else if (await abandonInstall(options.conn, remoteDir, options.host)) {
        forgetHeldOrcadFence(token)
      }
    }
  }
}

export function executablePermissionsCommand(
  host: RemoteHostPlatform,
  directory: string,
  target: NodeRuntimeTarget
): string {
  const required = [orcadRipgrepArtifact(target), ...orcadNodePtyNativeArtifacts(target)]
    .filter((artifact) => /\/(?:rg|spawn-helper)$/.test(artifact))
    .map((artifact) => joinRemotePath(host, directory, ...artifact.split('/')))
  const browsers = new Set(
    (['glibc', 'musl'] as const).map((libc) =>
      quotePosixShell(
        joinRemotePath(host, directory, orcadAgentBrowserNativeName(host.os, host.arch, libc))
      )
    )
  )
  // Restore executable modes lost by SFTP; absent optional browser binaries remain supported.
  return (
    `chmod 755 ${required.map(quotePosixShell).join(' ')} && ` +
    `for executable in ${[...browsers].join(' ')}; do ` +
    'if [ -f "$executable" ]; then chmod 755 "$executable" || exit $?; fi; done'
  )
}
