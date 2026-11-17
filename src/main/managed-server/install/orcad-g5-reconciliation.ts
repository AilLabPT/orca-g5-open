import { createHash, randomUUID } from 'node:crypto'
import {
  joinRemotePath,
  type RemoteHostPlatform
} from '../../ssh/ssh-remote-platform'
import type { OrcadHostTransport } from '../../ssh/orcad-host-transport'
import {
  execCommand,
  isUnconfirmedSshCommandTermination
} from '../../ssh/remote-exec/remote-exec-command'
import {
  orcadWindowsBaseDir,
  orcadWindowsSlotOpCommand,
  readOrcadWindowsEncodedAnswer
} from './orcad-remote-windows-node'
import { RELAY_INSTALL_LOCK_NAME } from '../../../shared/relay-install-lock-name'
import { writeRemoteInstallFile } from './remote-install-transfers'

/** Native-slot journal, not a claim of atomic Docker/Windows commit.
 * A retry may only reconcile the same pinned image, container and native version.
 */
export const G5_RECONCILIATION_RECORD = '.g5-docker-reconciliation.json'
const RECORD_PRESENT = '__ORCAD_RECORD_PRESENT__'
const RECORD_ABSENT = '__ORCAD_RECORD_ABSENT__'
const MAX_RECORD_BYTES = 4096

export type G5ReconciliationRecord = {
  schema: 1
  container: string
  imageId: string
  /** Immutable Docker container ID retained across interrupted native commit. */
  containerId?: string
  nativeVersion: string
  ownerToken: string
  phase: 'pending' | 'qualified'
}

type ReconciliationTarget = {
  conn: OrcadHostTransport
  host: RemoteHostPlatform
  signal?: AbortSignal
}

/** All native slots referring to one G5 container use this same host-level lock.
 * No automatic stale lock takeover is allowed: old Docker workers cannot be fenced
 * across independent processes without proving their termination.
 */
export function g5ContainerLockName(container: string): string {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/u.test(container)) {
    throw new Error('Unsafe G5 container lock name')
  }
  const digest = createHash('sha256').update(container).digest('hex')
  return `.g5-container-${digest.slice(0, 24)}.lock`
}

export function g5ContainerLockDir(
  target: ReconciliationTarget,
  slotDir: string,
  container: string
): string {
  return joinRemotePath(
    target.host,
    orcadWindowsBaseDir(target.host, slotDir),
    g5ContainerLockName(container)
  )
}

/** Release only the lock that still has our exact token. Never blindly rm a successor.
 * The host's g5-lock-release op renames the lock aside before deleting it.
 */
export async function releaseOwnedG5Lock(
  target: ReconciliationTarget,
  slotDir: string,
  lockDir: string,
  ownerToken: string
): Promise<void> {
  const response = await execCommand(
    target.conn,
    orcadWindowsSlotOpCommand(
      target.host, slotDir, 'g5-lock-release', [lockDir, ownerToken],
      { lockDir, token: ownerToken }
    ),
    { wrapCommand: false, signal: target.signal }
  )
  if (response.trim().split(/\r?\n/u).at(-1) !== 'RELEASED') {
    throw new Error('G5 lock release cannot prove owner identity; preserving lock')
  }
}

export function g5NativeLockDir(target: ReconciliationTarget, slotDir: string): string {
  return joinRemotePath(target.host, slotDir, RELAY_INSTALL_LOCK_NAME)
}

function recordPath(target: ReconciliationTarget, slotDir: string): string {
  if (target.host.os !== 'win32') {
    throw new Error('G5 reconciliation journal requires a Windows host')
  }
  return joinRemotePath(target.host, slotDir, G5_RECONCILIATION_RECORD)
}

function verifiedRecord(value: unknown): G5ReconciliationRecord {
  if (typeof value !== 'object' || value === null) {
    throw new Error('G5 reconciliation record is not an object')
  }
  if (!('schema' in value) || value.schema !== 1 ||
      !('container' in value) || typeof value.container !== 'string' ||
      !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/u.test(value.container) ||
      !('imageId' in value) || typeof value.imageId !== 'string' ||
      !/^sha256:[a-f0-9]{64}$/u.test(value.imageId) ||
      ('containerId' in value &&
        (typeof value.containerId !== 'string' ||
         !/^[a-f0-9]{64}$/u.test(value.containerId))) ||
      (!('containerId' in value) && value.phase === 'qualified') ||
      !('nativeVersion' in value) || typeof value.nativeVersion !== 'string' ||
      value.nativeVersion.length < 1 || value.nativeVersion.length > 200 ||
      !('ownerToken' in value) || typeof value.ownerToken !== 'string' ||
      !/^[a-f0-9-]{36}$/u.test(value.ownerToken) ||
      !('phase' in value) || (value.phase !== 'pending' && value.phase !== 'qualified')) {
    throw new Error('G5 reconciliation record is malformed')
  }
  return {
    schema: 1,
    container: value.container,
    imageId: value.imageId,
    ...('containerId' in value && typeof value.containerId === 'string'
      ? { containerId: value.containerId } : {}),
    nativeVersion: value.nativeVersion,
    ownerToken: value.ownerToken,
    phase: value.phase
  }
}

export function assertCompatibleG5ReconciliationRecord(
  record: G5ReconciliationRecord | null,
  expected: { container: string; expectedImageId: string },
  nativeVersion: string
): void {
  if (record && (record.container !== expected.container ||
                 record.imageId !== expected.expectedImageId ||
                 record.nativeVersion !== nativeVersion)) {
    throw new Error(
      'G5 reconciliation conflict: existing native slot is bound to another container, image or version'
    )
  }
}

export async function readG5ReconciliationRecord(
  target: ReconciliationTarget,
  slotDir: string,
  ownerToken: string
): Promise<G5ReconciliationRecord | null> {
  const path = recordPath(target, slotDir)
  const lockDir = g5NativeLockDir(target, slotDir)
  const command = orcadWindowsSlotOpCommand(target.host, slotDir, 'record-read', [
    path, String(MAX_RECORD_BYTES)
  ], { lockDir, token: ownerToken })
  const response = await execCommand(target.conn, command, {
    wrapCommand: false, signal: target.signal
  })
  if (response.split(/\r?\n/u).some((line) => line.trim() === RECORD_ABSENT)) return null
  const raw = readOrcadWindowsEncodedAnswer(response, RECORD_PRESENT)
  if (raw === null || Buffer.byteLength(raw) > MAX_RECORD_BYTES) {
    throw new Error('G5 reconciliation record is unreadable or oversized')
  }
  return verifiedRecord(JSON.parse(raw))
}

export async function publishG5ReconciliationRecord(
  target: ReconciliationTarget,
  slotDir: string,
  record: G5ReconciliationRecord
): Promise<void> {
  const bytes = JSON.stringify(verifiedRecord(record))
  const path = recordPath(target, slotDir)
  const stagedPath = `${path}.partial.${process.pid}.${randomUUID()}`
  await writeRemoteInstallFile(target.conn, target.host, stagedPath, bytes, {
    signal: target.signal
  })
  try {
    await execCommand(
      target.conn,
      orcadWindowsSlotOpCommand(target.host, slotDir, 'record-publish', [
        stagedPath, path, g5NativeLockDir(target, slotDir), record.ownerToken
      ], { lockDir: g5NativeLockDir(target, slotDir), token: record.ownerToken }),
      { wrapCommand: false, signal: target.signal }
    )
  } catch (error) {
    // Unconfirmed writes may still be running; never remove a possibly-live stage.
    if (!isUnconfirmedSshCommandTermination(error)) {
      await execCommand(
        target.conn,
        orcadWindowsSlotOpCommand(
          target.host, slotDir, 'remove-file', [stagedPath],
          { lockDir: g5NativeLockDir(target, slotDir), token: record.ownerToken }
        ),
        { wrapCommand: false }
      ).catch(() => {})
    }
    throw error
  }
}
