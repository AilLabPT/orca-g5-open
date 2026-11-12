import { settleInitialization } from './browser-host-page-initialization-settlement'
import { scheduleInitializationQueue } from './browser-host-page-initialization-queue'
import {
  admitInitialization,
  retireUnpublishedInitialization,
  type InitializationAdmissionOwner
} from './browser-host-page-initialization-admission'
import { retireInitializationAuthority } from './browser-host-page-initialization-lifetime'
import type { BrowserClientHostedPageInventory } from '../../../../shared/browser/client-hosting/browser-client-host-protocol'
import type { RuntimeBrowserClientPlacement } from '../../../../shared/runtime-browser-placement'
import type {
  BrowserHostLeaseIdentity,
  BrowserHostLeaseState
} from '../leases/browser-host-lease-records'
import type {
  InitializationAdmission,
  Initialization,
  InitializationRecord,
  InitializationQueue,
  InitializationDisposition,
  InitializationOutcome,
  BrowserHostPageInitializationInput
} from './browser-host-page-initialization-records'
import {
  canContinueInitialization,
  sameInitializationPlacement
} from './browser-host-page-initialization-records'
import { closeInitializationGuest } from './browser-host-page-initialization-commands'
import { observeInitializationAttach } from './browser-host-page-initialization-attachment'
import {
  runInitializationTransaction,
  type InitializationTransactionAuthority
} from './browser-host-page-initialization-transaction'
export type { BrowserHostPageInitializationInput } from './browser-host-page-initialization-records'

export class BrowserHostPageInitializations {
  private readonly records = new Map<string, InitializationRecord>()
  private readonly queues = new Map<symbol, InitializationQueue>()
  private readonly attachments = new Map<string, BrowserHostLeaseState>()

  constructor(
    private readonly authority: Omit<InitializationTransactionAuthority, 'current'>,
    private readonly requireState: (state: BrowserHostLeaseState) => void,
    private readonly retireLease: (state: BrowserHostLeaseState) => void
  ) {}

  canContinue(
    id: string,
    expected: RuntimeBrowserClientPlacement,
    lease: BrowserHostLeaseIdentity
  ): boolean {
    return canContinueInitialization(
      this.records.get(id),
      expected,
      lease,
      this.authority.placements.getPlacement(id)
    )
  }

  observeAttach(
    state: BrowserHostLeaseState,
    inventory: readonly BrowserClientHostedPageInventory[] | undefined
  ): void {
    this.attachments.set(state.lease.browserHostClientId, state)
    observeInitializationAttach(this.records, state, inventory, (operation) =>
      this.cancelOperation(operation)
    )
  }

  resume(state: BrowserHostLeaseState): void {
    for (const record of this.records.values()) {
      const operation = record.operation
      if (operation?.admission.state === state && operation.controller.signal.aborted) {
        if (operation.executing) {
          operation.resumeRequested = true
        } else {
          this.clean(operation)
        }
      } else if (
        !operation &&
        record.closed &&
        record.target &&
        record.browserHostClientId === state.lease.browserHostClientId
      ) {
        this.startClosedCleanup(record, state)
      }
    }
  }

  admit(
    state: BrowserHostLeaseState,
    input: BrowserHostPageInitializationInput
  ): InitializationDisposition {
    return admitInitialization(this.admissionOwner(), state, input)
  }

  retireUnpublished(state: BrowserHostLeaseState, input: BrowserHostPageInitializationInput): void {
    retireUnpublishedInitialization(this.admissionOwner(), state, input)
  }

  retireAuthority(state: BrowserHostLeaseState): void {
    retireInitializationAuthority(
      this.records,
      this.queues,
      this.attachments,
      (admission) => this.releaseAdmission(admission),
      state
    )
  }

  private admissionOwner(): InitializationAdmissionOwner {
    return {
      records: this.records,
      placements: this.authority.placements,
      requireState: this.requireState,
      observer: (state, input) => this.observer(state, input),
      cancelOperation: (operation) => this.cancelOperation(operation),
      releaseAdmission: (admission) => this.releaseAdmission(admission),
      enqueue: (record, admission) => this.enqueue(record, admission),
      resume: (state) => this.resume(state),
      startClosedCleanup: (record, state) => this.startClosedCleanup(record, state)
    }
  }

  cancel(id: string, expected: RuntimeBrowserClientPlacement): boolean {
    const record = this.records.get(id)
    if (!record || !sameInitializationPlacement(record.expected, expected)) {
      return false
    }
    record.closed = true
    if (record.successor) {
      this.releaseAdmission(record.successor)
      record.successor = undefined
    }
    if (record.operation) {
      this.cancelOperation(record.operation)
    } else {
      const state = this.attachments.get(record.browserHostClientId)
      if (state && record.target) {
        this.startClosedCleanup(record, state)
      } else if (!record.target) {
        this.records.delete(id)
      }
    }
    return true
  }

  fence(state: BrowserHostLeaseState): void {
    for (const record of this.records.values()) {
      if (record.operation?.admission.state === state) {
        this.cancelOperation(record.operation)
      }
    }
  }

  private observer(
    state: BrowserHostLeaseState,
    input: BrowserHostPageInitializationInput
  ): InitializationAdmission {
    return { state, input, connectionToken: state.connectionToken, removeAbort: () => {} }
  }

  private enqueue(record: InitializationRecord, admission: InitializationAdmission): void {
    const operation: Initialization = {
      record,
      admission,
      controller: new AbortController(),
      running: false,
      executing: false,
      detached: false
    }
    record.operation = operation
    const queue = this.queues.get(admission.state.token) ?? {
      pending: [],
      active: 0,
      scheduled: false
    }
    this.queues.set(admission.state.token, queue)
    queue.pending.push(operation)
    this.schedule(admission.state.token, queue)
  }

  private schedule(token: symbol, queue: InitializationQueue): void {
    scheduleInitializationQueue(
      this.queues,
      token,
      queue,
      (operation) =>
        runInitializationTransaction(operation, {
          ...this.authority,
          current: (op) => this.current(op)
        }),
      (operation, outcome) => this.settle(operation, outcome)
    )
  }

  private current(operation: Initialization): void {
    const { admission, record } = operation
    this.requireState(admission.state)
    if (
      operation.detached ||
      record.operation !== operation ||
      record.closed ||
      operation.controller.signal.aborted ||
      admission.connectionToken !== admission.state.connectionToken ||
      !admission.input.isCurrent()
    ) {
      throw new Error('browser_client_page_initialization_stale')
    }
  }

  private cancelOperation(operation: Initialization): void {
    if (operation.detached) {
      return
    }
    operation.controller.abort()
    if (operation.admission.reservation) {
      this.authority.placements.cancelClientPageReservation(operation.admission.reservation)
    }
    if (!operation.running) {
      const queue = this.queues.get(operation.admission.state.token)
      const index = queue?.pending.indexOf(operation) ?? -1
      if (index >= 0) {
        queue?.pending.splice(index, 1)
      }
      this.clean(operation)
    }
  }

  private clean(operation: Initialization): void {
    if (operation.executing || operation.detached) {
      return
    }
    operation.executing = true
    operation.resumeRequested = false
    void Promise.resolve()
      .then(() => closeInitializationGuest(operation))
      .then(
        () => this.settle(operation, operation.record.closed ? 'disposed' : 'retained-clean'),
        () => this.settle(operation, 'cleanup-unknown')
      )
  }

  private startClosedCleanup(record: InitializationRecord, state: BrowserHostLeaseState): void {
    const admission = this.observer(state, {
      browserPageId: record.browserPageId,
      browserProfileId: record.browserProfileId,
      workspaceId: record.workspaceId,
      expected: record.expected,
      url: '',
      isCurrent: () => false,
      resolveExecutionHostKey: async () => null,
      publish: () => {}
    })
    const operation: Initialization = {
      record,
      admission,
      controller: new AbortController(),
      running: false,
      executing: false,
      detached: false
    }
    operation.controller.abort()
    record.operation = operation
    // A rebound native close is charged to the current dispatcher; no replacement is created.
    const queue = this.queues.get(state.token) ?? { pending: [], active: 0, scheduled: false }
    this.queues.set(state.token, queue)
    queue.pending.push(operation)
    this.schedule(state.token, queue)
  }

  private settle(operation: Initialization, outcome: InitializationOutcome): void {
    settleInitialization(operation, outcome, {
      authority: this.authority,
      records: this.records,
      queues: this.queues,
      retireLease: this.retireLease,
      clean: (op) => this.clean(op),
      releaseAdmission: (admission) => this.releaseAdmission(admission),
      enqueue: (record, admission) => this.enqueue(record, admission),
      schedule: (token, queue) => this.schedule(token, queue)
    })
  }

  private releaseAdmission(admission: InitializationAdmission): void {
    admission.removeAbort()
    if (admission.reservation) {
      this.authority.placements.cancelClientPageReservation(admission.reservation)
    }
  }
}
