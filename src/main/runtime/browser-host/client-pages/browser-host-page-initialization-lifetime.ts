import type { BrowserHostLeaseState } from '../leases/browser-host-lease-records'
import type {
  InitializationAdmission,
  InitializationRecord,
  InitializationQueue
} from './browser-host-page-initialization-records'

export function retireInitializationAuthority(
  records: Map<string, InitializationRecord>,
  queues: Map<symbol, InitializationQueue>,
  attachments: Map<string, BrowserHostLeaseState>,
  releaseAdmission: (admission: InitializationAdmission) => void,
  state: BrowserHostLeaseState
): void {
  if (attachments.get(state.lease.browserHostClientId) === state) {
    attachments.delete(state.lease.browserHostClientId)
  }
  for (const record of records.values()) {
    const operation = record.operation
    if (!operation && record.browserHostClientId === state.lease.browserHostClientId) {
      record.observer = undefined
      record.authorityRetired = true
    }
    if (operation?.admission.state !== state) {
      continue
    }
    operation.detached = true
    operation.controller.abort()
    releaseAdmission(operation.admission)
    operation.releaseGrant?.()
    operation.releaseGrant = undefined
    operation.closing?.absent()
    if (record.successor) {
      releaseAdmission(record.successor)
    }
    record.successor = undefined
    record.observer = undefined
    record.operation = undefined
    record.authorityRetired = true
    if (record.closed && !record.target) {
      records.delete(record.browserPageId)
    }
  }
  queues.delete(state.token)
}
