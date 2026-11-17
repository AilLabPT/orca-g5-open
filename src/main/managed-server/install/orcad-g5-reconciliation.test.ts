import { randomUUID } from 'node:crypto'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { getRemoteHostPlatform } from '../../ssh/ssh-remote-platform'
import { unusedOrcadHostTransport } from '../../ssh/unused-host-transport.test-fixture'
import type * as ExecCommandModule from '../../ssh/remote-exec/remote-exec-command'

vi.mock('../../ssh/remote-exec/remote-exec-command', async (original) => ({
  ...(await original<typeof ExecCommandModule>()),
  execCommand: vi.fn()
}))
vi.mock('./remote-install-transfers', () => ({
  writeRemoteInstallFile: vi.fn()
}))

import { execCommand } from '../../ssh/remote-exec/remote-exec-command'
import { writeRemoteInstallFile } from './remote-install-transfers'
import {
  assertCompatibleG5ReconciliationRecord,
  publishG5ReconciliationRecord,
  readG5ReconciliationRecord,
  type G5ReconciliationRecord
} from './orcad-g5-reconciliation'

const conn = unusedOrcadHostTransport()
const target = { conn, host: getRemoteHostPlatform('win32-x64') }
const slot = 'C:/Users/u/.orca-remote/orcad-g5-test'
const mockExec = vi.mocked(execCommand)
const mockWrite = vi.mocked(writeRemoteInstallFile)
const record = (): G5ReconciliationRecord => ({
  schema: 1,
  container: 'g5-staging',
  imageId: 'sha256:' + 'a'.repeat(64),
  nativeVersion: '0.2.0+g5test',
  ownerToken: randomUUID(),
  phase: 'pending'
})

beforeEach(() => {
  mockExec.mockReset().mockResolvedValue('')
  mockWrite.mockReset().mockResolvedValue(undefined)
})

describe('G5 native-slot durable reconciliation journal', () => {
  it('distinguishes a missing record from an unreadable one', async () => {
    mockExec.mockResolvedValueOnce('__ORCAD_RECORD_ABSENT__\r\n')
    await expect(readG5ReconciliationRecord(target, slot, record().ownerToken)).resolves.toBeNull()
    mockExec.mockResolvedValueOnce('unexpected record response')
    await expect(readG5ReconciliationRecord(target, slot, record().ownerToken)).rejects.toThrow('unreadable')
  })

  it('reads and checks a versioned complete record schema', async () => {
    const saved = record()
    mockExec.mockResolvedValueOnce(
      '__ORCAD_RECORD_PRESENT__ ' + Buffer.from(JSON.stringify(saved)).toString('base64')
    )
    await expect(readG5ReconciliationRecord(target, slot, record().ownerToken)).resolves.toEqual(saved)
    mockExec.mockResolvedValueOnce(
      '__ORCAD_RECORD_PRESENT__ ' + Buffer.from('{"schema":1,"phase":"unknown"}').toString('base64')
    )
    await expect(readG5ReconciliationRecord(target, slot, record().ownerToken)).rejects.toThrow('malformed')
  })

  it('refuses to resume a conflicting image, container or native version', () => {
    const saved = record()
    expect(() => assertCompatibleG5ReconciliationRecord(saved, {
      container: saved.container, expectedImageId: saved.imageId
    }, saved.nativeVersion)).not.toThrow()
    expect(() => assertCompatibleG5ReconciliationRecord(saved, {
      container: saved.container, expectedImageId: 'sha256:' + 'b'.repeat(64)
    }, saved.nativeVersion)).toThrow('conflict')
    expect(() => assertCompatibleG5ReconciliationRecord(saved, {
      container: 'other', expectedImageId: saved.imageId
    }, saved.nativeVersion)).toThrow('conflict')
    expect(() => assertCompatibleG5ReconciliationRecord(saved, {
      container: saved.container, expectedImageId: saved.imageId
    }, '0.3.0')).toThrow('conflict')
  })

  it('uploads a temporary record and atomically publishes it on Windows', async () => {
    const saved = record()
    const steps: string[] = []
    mockWrite.mockImplementation(async (_conn, _host, partialPath, bytes) => {
      steps.push('write')
      expect(partialPath).toContain('.g5-docker-reconciliation.json.partial.')
      expect(JSON.parse(bytes)).toEqual(saved)
    })
    mockExec.mockImplementation(async (_conn, command, opts) => {
      steps.push('publish')
      expect(command).toContain('record-publish')
      expect(opts?.wrapCommand).toBe(false)
      return ''
    })
    await publishG5ReconciliationRecord(target, slot, saved)
    expect(steps).toEqual(['write', 'publish'])
  })

  it('cleans up a known failed publish, without masking its error', async () => {
    const known = new Error('publish command failed')
    mockExec.mockRejectedValueOnce(known).mockResolvedValueOnce('')
    await expect(publishG5ReconciliationRecord(target, slot, record())).rejects.toBe(known)
    expect(mockExec).toHaveBeenCalledTimes(2)
    expect(mockExec.mock.calls[1]?.[1]).toContain('remove-file')
  })

  it('preserves an in-flight staged write if remote termination is uncertain', async () => {
    const uncertain = Object.assign(new Error('remote status unknown'), {
      sshChannelCloseConfirmed: false
    })
    mockExec.mockRejectedValueOnce(uncertain)
    await expect(publishG5ReconciliationRecord(target, slot, record())).rejects.toBe(uncertain)
    expect(mockExec).toHaveBeenCalledTimes(1)
  })

  it('rejects an invalid journal before staging bytes', async () => {
    const invalid = { ...record(), imageId: 'sha256:incorrect' }
    await expect(publishG5ReconciliationRecord(target, slot, invalid)).rejects.toThrow('malformed')
    expect(mockWrite).not.toHaveBeenCalled()
    expect(mockExec).not.toHaveBeenCalled()
  })
})
