import { orcadWindowsNodeCommandLine } from './orcad-remote-windows-node'
import { execCommand } from '../../ssh/remote-exec/remote-exec-command'
import type { OrcadHostTransport } from '../../ssh/orcad-host-transport'
import type { RemoteHostPlatform } from '../../ssh/ssh-remote-platform'

/** Read-only immutable Docker container pin before any native journal or mutation.
 * Called while both native-slot and shared container locks are held.
 * The subsequent Ensure must reuse this verified immutable ID and fail on replacement.
 */
export async function readPinnedG5DockerContainerId(
  options: {
    conn: OrcadHostTransport
    host: RemoteHostPlatform
    signal?: AbortSignal
    g5Docker: { adapterPath: string; container: string; expectedImageId: string }
  },
  coordination: { lockDir: string; ownerToken: string }
): Promise<string> {
  if (options.host.os !== 'win32') {
    throw new Error('G5 Docker preflight requires a Windows host')
  }
  const config = options.g5Docker
  const command = orcadWindowsNodeCommandLine('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-File', config.adapterPath,
    '-Action', 'Status', '-Container', config.container,
    '-ExpectedImageId', config.expectedImageId,
    '-CoordinationLock', coordination.lockDir,
    '-OwnerToken', coordination.ownerToken
  ])
  const output = await execCommand(options.conn, command, {
    wrapCommand: false,
    signal: options.signal
  })
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
