import type { BrowserHostLeaseState } from '../leases/browser-host-lease-records'
import type { InitializationTransactionAuthority } from './browser-host-page-initialization-transaction'
import type {
  Initialization,
  InitializationOutcome,
  InitializationAdmission,
  InitializationRecord,
  InitializationQueue
} from './browser-host-page-initialization-records'
import {
  sameInitializationPlacement,
  sameInitializationTarget,
  notifyInitialization
} from './browser-host-page-initialization-records'

export function settleInitialization(
  operation: Initialization,
  outcome: InitializationOutcome,
  owner: {
    authority: Omit<InitializationTransactionAuthority, 'current'>
    records: Map<string, InitializationRecord>
    queues: Map<symbol, InitializationQueue>
    retireLease(state: BrowserHostLeaseState): void
    clean(operation: Initialization): void
    releaseAdmission(admission: InitializationAdmission): void
    enqueue(record: InitializationRecord, admission: InitializationAdmission): void
    schedule(token: symbol, queue: InitializationQueue): void
  }
): void {
  operation.executing = false
  const { record, admission } = operation
  if (operation.detached || record.operation !== operation) {
    return
  }
  if (admission.state.commandLedger?.isClosed()) {
    owner.retireLease(admission.state)
    return
  }
  if (outcome === 'cleanup-unknown') {
    notifyInitialization(record, outcome)
    if (operation.resumeRequested) {
      owner.clean(operation)
    }
    return
  }
  if (record.closed) {
    const placement = owner.authority.placements.getPlacement(record.browserPageId)
    if (placement && sameInitializationPlacement(placement, record.expected)) {
      owner.authority.retirePlacement(record.browserPageId, placement)
    }
  }
  owner.releaseAdmission(admission)
  operation.releaseGrant?.()
  operation.releaseGrant = undefined
  record.operation = undefined
  const queue = owner.queues.get(admission.state.token)
  if (operation.running && queue) {
    queue.active -= 1
  }
  const successor = record.successor
  record.successor = undefined
  if (
    successor &&
    !record.closed &&
    !successor.input.signal?.aborted &&
    successor.connectionToken === successor.state.connectionToken &&
    successor.input.isCurrent()
  ) {
    record.browserHostClientId = successor.state.lease.browserHostClientId
    if (
      !record.target &&
      !sameInitializationTarget(successor.input.previous, operation.retiredTarget)
    ) {
      record.target = successor.input.previous
    }
    owner.enqueue(record, successor)
  } else {
    if (successor) {
      owner.releaseAdmission(successor)
    }
    notifyInitialization(record, record.closed ? 'disposed' : outcome)
    record.observer = undefined
    if (!record.target) {
      owner.records.delete(record.browserPageId)
    }
  }
  if (queue) {
    owner.schedule(admission.state.token, queue)
  }
}
