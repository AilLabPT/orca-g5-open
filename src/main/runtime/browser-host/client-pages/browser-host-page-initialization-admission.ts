import { BROWSER_CLIENT_PAGE_INITIALIZATION_CAPABILITY } from '../../../../shared/browser/client-hosting/browser-client-host-protocol'
import type { BrowserHostLeaseState } from '../leases/browser-host-lease-records'
import type { BrowserHostPagePlacementRegistry } from '../reconciliation/browser-host-page-placement'
import type {
  Initialization,
  InitializationRecord,
  InitializationAdmission,
  BrowserHostPageInitializationInput,
  InitializationDisposition
} from './browser-host-page-initialization-records'
import { sameInitializationPlacement } from './browser-host-page-initialization-records'

export type InitializationAdmissionOwner = {
  records: Map<string, InitializationRecord>
  join(state: BrowserHostLeaseState, record: InitializationRecord): void
  placements: BrowserHostPagePlacementRegistry
  requireState(state: BrowserHostLeaseState): void
  observer(
    state: BrowserHostLeaseState,
    input: BrowserHostPageInitializationInput
  ): InitializationAdmission
  cancelOperation(operation: Initialization): void
  releaseAdmission(admission: InitializationAdmission): void
  enqueue(record: InitializationRecord, admission: InitializationAdmission): void
  resume(state: BrowserHostLeaseState): void
  startClosedCleanup(record: InitializationRecord, state: BrowserHostLeaseState): void
}

export function admitInitialization(
  owner: InitializationAdmissionOwner,
  state: BrowserHostLeaseState,
  input: BrowserHostPageInitializationInput
): InitializationDisposition {
  owner.requireState(state)
  if (!state.lease.hostCapabilities.includes(BROWSER_CLIENT_PAGE_INITIALIZATION_CAPABILITY)) {
    throw new Error('browser_client_page_initialization_unsupported')
  }
  if (input.signal?.aborted || !input.isCurrent()) {
    return 'stale'
  }
  let record = owner.records.get(input.browserPageId)
  if (record && record.pairedDeviceId !== state.lease.pairedDeviceId) {
    return 'stale'
  }
  if (record) {
    owner.join(state, record)
  }
  if (record?.closed) {
    record.observer = owner.observer(state, input)
    owner.resume(state)
    return 'closed'
  }
  if (record && !sameInitializationPlacement(record.expected, input.expected)) {
    return 'stale'
  }
  const operation = record?.operation
  if (
    operation &&
    operation.admission.state === state &&
    operation.admission.connectionToken === state.connectionToken &&
    !operation.controller.signal.aborted
  ) {
    record!.observer = owner.observer(state, input)
    return 'joined-existing'
  }
  if (operation) {
    owner.cancelOperation(operation)
  }
  if (record?.successor) {
    owner.releaseAdmission(record.successor)
  }
  const admission = owner.observer(state, input)
  admission.reservation = owner.placements.reserveNewClientPage(
    input.browserPageId,
    state.lease,
    input.pageHostGeneration
  )
  if (!record) {
    record = {
      browserPageId: input.browserPageId,
      browserProfileId: input.browserProfileId,
      workspaceId: input.workspaceId,
      expected: input.expected,
      pairedDeviceId: state.lease.pairedDeviceId,
      browserHostClientId: state.lease.browserHostClientId,
      closed: false,
      authorityRetired: false,
      scope: state,
      target: input.previous
    }
    owner.records.set(input.browserPageId, record)
  }
  record.releaseCleanup ??= owner.placements.claimClientPageCleanup(input.browserPageId)
  owner.join(state, record)
  const owned = record
  const abort = (): void => {
    if (owned.successor === admission) {
      owned.successor = undefined
      owner.releaseAdmission(admission)
    }
    if (owned.operation?.admission === admission) {
      owner.cancelOperation(owned.operation)
    }
  }
  admission.removeAbort = () => input.signal?.removeEventListener('abort', abort)
  input.signal?.addEventListener('abort', abort, { once: true })
  record.observer = admission
  try {
    input.claim?.()
  } catch (error) {
    owner.releaseAdmission(admission)
    if (!operation) {
      record.releaseCleanup?.()
      owner.records.delete(input.browserPageId)
    }
    throw error
  }
  if (operation) {
    record.successor = admission
    owner.resume(state)
    return 'successor-pending'
  }
  if (record.authorityRetired) {
    record.target = undefined
  }
  record.browserHostClientId = state.lease.browserHostClientId
  record.authorityRetired = false
  record.target ??= input.previous
  owner.enqueue(record, admission)
  return 'queued'
}

export function retireUnpublishedInitialization(
  owner: InitializationAdmissionOwner,
  state: BrowserHostLeaseState,
  input: BrowserHostPageInitializationInput
): void {
  const placement = input.expected
  const record: InitializationRecord = {
    browserPageId: input.browserPageId,
    browserProfileId: input.browserProfileId,
    workspaceId: input.workspaceId,
    expected: placement,
    pairedDeviceId: state.lease.pairedDeviceId,
    browserHostClientId: state.lease.browserHostClientId,
    closed: true,
    authorityRetired: false,
    scope: state,
    target: {
      ...placement,
      authorityRuntimeId: state.lease.authorityRuntimeId,
      authorityEpoch: state.lease.authorityEpoch
    }
  }
  if (owner.records.has(input.browserPageId)) {
    throw new Error('browser_page_reconciliation_reservation_pending')
  }
  if (state.commandLedger?.isClosed()) {
    return
  }
  record.releaseCleanup = owner.placements.claimClientPageCleanup(input.browserPageId)
  owner.records.set(input.browserPageId, record)
  owner.join(state, record)
  owner.startClosedCleanup(record, state)
}
