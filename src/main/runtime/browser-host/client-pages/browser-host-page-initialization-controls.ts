import { BrowserHostPagePartitionPreparation } from './browser-host-page-partition-preparation'
import { BrowserHostInitializationCompletion } from './browser-host-page-initialization-completion'
import type {
  InitializationAdmission,
  BrowserHostPageInitializationInput
} from './browser-host-page-initialization-records'
import type { RuntimeBrowserClientPlacement } from '../../../../shared/runtime-browser-placement'
import type { BrowserHostLeaseState } from '../leases/browser-host-lease-records'
import {
  sameInitializationPlacement,
  type Initialization,
  type InitializationRecord
} from './browser-host-page-initialization-records'

/** Presentation and controls refer to the same current initializer records as transaction scheduling. */
export abstract class BrowserHostPageInitializationControls {
  protected readonly preparation = new BrowserHostPagePartitionPreparation()
  protected readonly completion = new BrowserHostInitializationCompletion()
  protected readonly attachments = new Map<string, BrowserHostLeaseState>()
  protected readonly records = new Map<string, InitializationRecord>()
  constructor(
    protected readonly requireState: (state: BrowserHostLeaseState) => void,
    protected readonly changed: (workspaceId: string) => void
  ) {}
  protected abstract cancelOperation(operation: Initialization): void
  protected abstract releaseAdmission(admission: InitializationAdmission): void
  protected abstract startClosedCleanup(
    record: InitializationRecord,
    state: BrowserHostLeaseState,
    releaseGrant?: () => void
  ): void

  protected observer(
    state: BrowserHostLeaseState,
    input: BrowserHostPageInitializationInput
  ): InitializationAdmission {
    return { state, input, connectionToken: state.connectionToken, removeAbort: () => {} }
  }

  assertCreationAdmission(id: string): void {
    if (this.records.has(id)) {
      throw new Error('browser_page_replacement_requires_retirement')
    }
  }

  whenPrepared(
    state: BrowserHostLeaseState,
    profile: string,
    key: string,
    signal: AbortSignal,
    admit: () => void
  ): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      let generation = 0
      let settled = false
      let remove = (): void => {}
      const finish = (error?: unknown): void => {
        if (settled) {
          return
        }
        settled = true
        signal.removeEventListener('abort', abort)
        remove()
        if (error === undefined) {
          resolve()
        } else {
          reject(error)
        }
      }
      const abort = (): void => finish(signal.reason)
      const register = (): void => {
        const ticket = ++generation
        const unregister = this.preparation.wait(
          state,
          profile,
          key,
          () => {
            try {
              this.requireState(state)
              signal.throwIfAborted()
              // Earlier ready listeners can synchronously replace/unseal this connection.
              if (!this.preparation.isPrepared(state, profile, key)) {
                register()
                return
              }
              admit()
              finish()
            } catch (error) {
              finish(error)
            }
          },
          () => finish(new Error('browser_host_lease_stale'))
        )
        if (settled || ticket !== generation) {
          unregister()
        } else {
          remove = unregister
        }
      }
      signal.addEventListener('abort', abort, { once: true })
      if (signal.aborted) {
        abort()
      } else {
        register()
      }
    })
  }

  status(id: string, expected: RuntimeBrowserClientPlacement): 'pending' | 'stopped' | undefined {
    const record = this.records.get(id)
    return record && sameInitializationPlacement(record.expected, expected)
      ? this.presentation(record)
      : undefined
  }

  lease(id: string, expected: RuntimeBrowserClientPlacement) {
    const record = this.records.get(id)
    if (
      !record ||
      record.closed ||
      !sameInitializationPlacement(record.expected, expected) ||
      !record.scope
    ) {
      return undefined
    }
    try {
      this.requireState(record.scope)
      return record.scope.lease
    } catch {
      return undefined
    }
  }

  capture(
    id: string,
    expected: RuntimeBrowserClientPlacement
  ): ((placement: RuntimeBrowserClientPlacement) => boolean) | undefined {
    const record = this.records.get(id)
    if (!record || !this.lease(id, expected)) {
      return undefined
    }
    return (placement) =>
      !record.closed &&
      !record.authorityRetired &&
      sameInitializationPlacement(record.expected, placement)
  }

  stop(id: string, expected: RuntimeBrowserClientPlacement): boolean {
    const record = this.records.get(id)
    if (!record || !this.lease(id, expected)) {
      return false
    }
    if (record.stopped && !record.successor) {
      return true
    }
    record.stopped = true
    if (record.successor) {
      this.releaseAdmission(record.successor)
      record.successor = undefined
    }
    if (record.operation) {
      this.cancelOperation(record.operation)
    }
    this.changed(record.workspaceId)
    return true
  }

  cancel(id: string, expected: RuntimeBrowserClientPlacement): boolean {
    const record = this.records.get(id)
    if (!record || !sameInitializationPlacement(record.expected, expected)) {
      return false
    }
    if (record.authorityRetired && !record.operation && !record.successor) {
      this.completion.settle(record, 'disposed')
      this.records.delete(id)
      return true
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
        record.releaseCleanup?.()
        this.completion.settle(record, 'disposed')
        this.records.delete(id)
      }
    }
    return true
  }

  fence(state: BrowserHostLeaseState): void {
    const changed = new Set<string>()
    for (const record of this.records.values()) {
      if (record.operation?.admission.state === state) {
        if (this.presentation(record)) {
          changed.add(record.workspaceId)
        }
        this.cancelOperation(record.operation)
      }
    }
    for (const workspace of changed) {
      this.changed(workspace)
    }
  }

  protected presentation(
    record: InitializationRecord | undefined
  ): 'pending' | 'stopped' | undefined {
    if (!record || record.closed || record.authorityRetired || !record.scope) {
      return undefined
    }
    try {
      this.requireState(record.scope)
    } catch {
      return undefined
    }
    if (record.stopped) {
      return 'stopped'
    }
    const operation = record.operation
    const admission = record.successor ?? operation?.admission
    if (
      !admission ||
      admission.input.signal?.aborted ||
      admission.connectionToken !== admission.state.connectionToken
    ) {
      return undefined
    }
    if (record.successor) {
      return 'pending'
    }
    return operation &&
      !operation.controller.signal.aborted &&
      !operation.cleanupFailed &&
      operation.phase !== 'published'
      ? 'pending'
      : undefined
  }
}
