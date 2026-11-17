import { orcadWindowsNodeCommandLine } from './orcad-remote-windows-node'
import { execCommand } from '../../ssh/remote-exec/remote-exec-command'
import type { OrcadHostTransport } from '../../ssh/orcad-host-transport'
import type { RemoteHostPlatform } from '../../ssh/ssh-remote-platform'

export type G5DockerConfig = {
  adapterPath: string
  container: string
  expectedImageId: string
  broker?: { clientPath: string; pipeName: string; serverPid: number }
}

type G5DockerExecution = {
  conn: OrcadHostTransport
  signal?: AbortSignal
}

type G5DockerCoordination = { lockDir: string; ownerToken: string }

export async function executeG5DockerOperation(
  options: G5DockerExecution,
  config: G5DockerConfig,
  coordination: G5DockerCoordination,
  action: 'Status' | 'Ensure' | 'Recover' | 'Rollback',
  expectedContainerId?: string
): Promise<string> {
  const broker = config.broker
  if (!broker) {
    const command = orcadWindowsNodeCommandLine('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-File', config.adapterPath,
      '-Action', action, '-Container', config.container,
      '-ExpectedImageId', config.expectedImageId,
      ...(action === 'Status' ? [] : ['-Apply']),
      '-CoordinationLock', coordination.lockDir, '-OwnerToken', coordination.ownerToken,
      ...(expectedContainerId ? ['-ExpectedContainerId', expectedContainerId] : [])
    ])
    return execCommand(options.conn, command, { wrapCommand: false, signal: options.signal })
  }
  if (!/^[A-Za-z]:\\/u.test(broker.clientPath) ||
      !broker.clientPath.toLowerCase().endsWith('.ps1') ||
      /[%$"`\r\n]/u.test(broker.clientPath) ||
      !/^g5-[a-z0-9-]{8,52}$/u.test(broker.pipeName) ||
      !Number.isInteger(broker.serverPid) || broker.serverPid < 1 || broker.serverPid > 2147483647 ||
      !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u.test(coordination.ownerToken) ||
      (action !== 'Status' && !expectedContainerId) ||
      (expectedContainerId !== undefined && !/^[a-f0-9]{64}$/u.test(expectedContainerId))) {
    throw new Error('G5 scoped Docker broker configuration is invalid')
  }
  const command = orcadWindowsNodeCommandLine('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-File', broker.clientPath,
    '-PipeName', broker.pipeName, '-ExpectedServerPid', String(broker.serverPid),
    '-Operation', action, '-OwnerToken', coordination.ownerToken,
    '-TimeoutMs', '120000',
    ...(expectedContainerId ? ['-ExpectedContainerId', expectedContainerId] : [])
  ])
  try {
    return await execCommand(options.conn, command, {
      wrapCommand: false, signal: options.signal, timeoutMs: 250_000
    })
  } catch (error) {
    if (action === 'Status') throw error
    // An SSH client exit cannot prove the broker's Docker worker stopped.
    throw Object.assign(new Error('G5 broker mutation completion unknown', { cause: error }), {
      sshChannelCloseConfirmed: false
    })
  }
}

/** Read-only immutable Docker container pin before any native journal or mutation.
 * Called while both native-slot and shared container locks are held.
 * The subsequent Ensure must reuse this verified immutable ID and fail on replacement.
 */
export async function readPinnedG5DockerContainerId(
  options: {
    conn: OrcadHostTransport
    host: RemoteHostPlatform
    signal?: AbortSignal
    g5Docker: G5DockerConfig
  },
  coordination: { lockDir: string; ownerToken: string }
): Promise<string> {
  if (options.host.os !== 'win32') {
    throw new Error('G5 Docker preflight requires a Windows host')
  }
  const config = options.g5Docker
  // This is the FIRST remote command in G5 reconciliation: reject unsafe
  // configuration before invoking PowerShell, not only before Docker Ensure.
  if (!/^sha256:[a-f0-9]{64}$/u.test(config.expectedImageId)) {
    throw new Error('G5 Docker image identity missing or invalid')
  }
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/u.test(config.container)) {
    throw new Error('G5 Docker container name invalid')
  }
  const unsafe = (s: string): boolean =>
    ['%', '$', '`', '"', '\n', '\r'].some((char) => s.includes(char))
  if (!/^[A-Za-z]:\\/u.test(config.adapterPath) ||
      !config.adapterPath.toLowerCase().endsWith('.ps1') ||
      unsafe(config.adapterPath) ||
      !/^[A-Za-z]:[\\/]/u.test(coordination.lockDir) ||
      unsafe(coordination.lockDir) ||
      !/^[a-f0-9-]{36}$/u.test(coordination.ownerToken)) {
    throw new Error('G5 Docker preflight Windows authority configuration invalid')
  }
  const output = await executeG5DockerOperation(options, config, coordination, 'Status')
  const last = output.trim().split(/\r?\n/u).at(-1) ?? ''
  const parsed: unknown = JSON.parse(last)
  if (typeof parsed !== 'object' || parsed === null ||
      !('containerId' in parsed) || typeof parsed.containerId !== 'string' ||
      !/^[a-f0-9]{64}$/u.test(parsed.containerId) ||
      !('image' in parsed) || parsed.image !== config.expectedImageId ||
      !('network' in parsed) || parsed.network !== 'none' ||
      !('restart' in parsed) || parsed.restart !== 'no' ||
      !('fallback' in parsed) || parsed.fallback !== true ||
      !('healthy' in parsed) || parsed.healthy !== true ||
      !('protocolVersion' in parsed) || parsed.protocolVersion !== 54 ||
      !('windowsNativeUpdaterUnchanged' in parsed) ||
      parsed.windowsNativeUpdaterUnchanged !== true) {
    throw new Error('G5 Docker preflight could not pin a healthy isolated immutable container')
  }
  return parsed.containerId
}
