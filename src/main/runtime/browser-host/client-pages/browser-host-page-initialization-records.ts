import type {
  BrowserClientHostedPageInventory,
  BrowserClientHostLeaseAuthority
} from '../../../../shared/browser/client-hosting/browser-client-host-protocol'
import type { RuntimeBrowserClientPlacement } from '../../../../shared/runtime-browser-placement'
import type { BrowserHostLeaseState } from '../leases/browser-host-lease-records'
import type { BrowserClientPagePlacementReservation } from '../reconciliation/browser-host-page-placement'

export type InitializationOutcome =
  | 'published'
  | 'retained-clean'
  | 'disposed'
  | 'cleanup-unknown'
  | 'route-parked'

export type InitializationDisposition =
  | 'queued'
  | 'joined-existing'
  | 'successor-pending'
  | 'closed'
  | 'stale'

export type InitializationTarget = BrowserClientHostLeaseAuthority & {
  pageHostGeneration: number
}

export type BrowserHostPageInitializationInput = {
  browserPageId: string
  browserProfileId: string
  workspaceId: string
  expected: RuntimeBrowserClientPlacement
  url: string
  pageHostGeneration?: number
  previous?: BrowserClientHostedPageInventory
  creationTimeoutMs?: number
  closeTimeoutMs?: number
  signal?: AbortSignal
  claim?(): void
  isCurrent(): boolean
  resolveExecutionHostKey(): Promise<string | null>
  publish(placement: RuntimeBrowserClientPlacement, url: string, executionHostKey: string): void
  settled?(outcome: InitializationOutcome): void
}

export type InitializationAdmission = {
  state: BrowserHostLeaseState
  connectionToken: symbol
  input: BrowserHostPageInitializationInput
  reservation?: BrowserClientPagePlacementReservation
  removeAbort(): void
}

export type Initialization = {
  admission: InitializationAdmission
  record: InitializationRecord
  controller: AbortController
  running: boolean
  executing: boolean
  detached: boolean
  resumeRequested?: boolean
  retiredTarget?: InitializationTarget
  releaseGrant?: () => void
  closing?: { target: InitializationTarget; absent: () => void; result: Promise<void> }
}

export type InitializationRecord = {
  browserPageId: string
  browserProfileId: string
  workspaceId: string
  expected: RuntimeBrowserClientPlacement
  pairedDeviceId: string
  browserHostClientId: string
  closed: boolean
  authorityRetired: boolean
  target?: InitializationTarget
  operation?: Initialization
  successor?: InitializationAdmission
  observer?: InitializationAdmission
}

export type InitializationQueue = {
  pending: Initialization[]
  active: number
  scheduled: boolean
}

export function sameInitializationTarget(
  left: InitializationTarget | undefined,
  right: InitializationTarget | undefined
): boolean {
  return Boolean(
    left &&
    right &&
    left.authorityRuntimeId === right.authorityRuntimeId &&
    left.authorityEpoch === right.authorityEpoch &&
    left.browserHostClientId === right.browserHostClientId &&
    left.browserHostGeneration === right.browserHostGeneration &&
    left.pageHostGeneration === right.pageHostGeneration
  )
}

export function sameInitializationPlacement(
  left: {
    kind: string
    browserHostClientId?: string
    browserHostGeneration?: number
    pageHostGeneration?: number
  },
  right: RuntimeBrowserClientPlacement
): left is RuntimeBrowserClientPlacement {
  return (
    left.kind === 'client' &&
    left.browserHostClientId === right.browserHostClientId &&
    left.browserHostGeneration === right.browserHostGeneration &&
    left.pageHostGeneration === right.pageHostGeneration
  )
}

export function notifyInitialization(
  record: InitializationRecord,
  outcome: InitializationOutcome
): void {
  const observer = record.observer
  if (
    observer &&
    !observer.input.signal?.aborted &&
    observer.connectionToken === observer.state.connectionToken
  ) {
    observer.input.settled?.(outcome)
  }
}

export function canContinueInitialization(
  record: InitializationRecord | undefined,
  expected: RuntimeBrowserClientPlacement,
  lease: { pairedDeviceId: string },
  live: unknown
): boolean {
  return Boolean(
    record?.authorityRetired &&
    !record.closed &&
    record.pairedDeviceId === lease.pairedDeviceId &&
    sameInitializationPlacement(record.expected, expected) &&
    !live
  )
}
