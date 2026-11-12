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

async function ensureOptionalG5Docker(
  options: Parameters<typeof installOrcadBundle>[0]
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
    '-ExpectedImageId', config.expectedImageId, '-Apply'
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
      !('restartRequired' in parsed) || parsed.restartRequired !== false) {
    throw new Error('G5 selected but V12 not running: controlled restart and health qualification required')
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
    await ensureOptionalG5Docker(options)
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
    await ensureOptionalG5Docker(options)
    return
  }
  // Persist the token so a relaunch can prove ownership of an interrupted upload lock.
  const token = randomUUID()
  rememberHeldOrcadFence(token)
  try {
    await acquireInstallLock(options.conn, remoteDir, options.host, {
      signal: options.signal,
      owner: { fileName: ORCAD_FENCE_OWNER_FILENAME, token },
      // SFTP uploads and chmod leave no host workload after this client exits.
      exitedOwner: exitedOwnLockProof(options, {
        baseDir: orcadWindowsBaseDir(options.host, remoteDir),
        guardsStateMutation: false
      })
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
      await ensureOptionalG5Docker(options)
      return
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
    await finalizeInstall(options.conn, remoteDir, options.host, {
      signal: options.signal,
      releaseLock: false
    })
    await ensureOptionalG5Docker(options)
  } catch (error) {
    preserveInstallLock = isUnconfirmedSshCommandTermination(error)
    throw error
  } finally {
    if (!preserveInstallLock) {
      // Retain ownership proof if interrupted cleanup cannot confirm lock removal.
      if (await abandonInstall(options.conn, remoteDir, options.host)) {
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
