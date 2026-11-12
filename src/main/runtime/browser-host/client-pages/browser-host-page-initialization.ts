import { BROWSER_CLIENT_PAGE_INITIALIZATION_CAPABILITY } from '../../../../shared/browser/client-hosting/browser-client-host-protocol'
import {
  type BrowserHostPageInitializationInput,
  type Initialization,
  issueInitializationCommand,
  closeInitializationGuest,
  closeInitializationReplacement,
  sameInitializationPlacement,
  awaitInitializationResult
} from './browser-host-page-initialization-commands'
export type { BrowserHostPageInitializationInput } from './browser-host-page-initialization-commands'
import type { RuntimeBrowserClientPlacement } from '../../../../shared/runtime-browser-placement'
import type {
  BrowserHostLeaseIdentity,
  BrowserHostLeaseState
} from '../leases/browser-host-lease-records'
import type { BrowserHostPagePlacementRegistry } from '../reconciliation/browser-host-page-placement'
import type { BrowserClientPageExecutionHostGrant } from './browser-host-client-page-creation'
import {
  clientPageCreationTimeout,
  waitForClientPageCreationResult
} from './browser-host-client-page-creation'
import { browserHostClientProfileFor } from '../profiles/browser-host-client-profile-metadata'

type InitializationQueue = { pending: Initialization[]; active: number }

/** One permit covers the entire native transaction, including cancellation's destruction join. */
export class BrowserHostPageInitializations {
  private readonly operations = new Map<string, Initialization>()
  private readonly queues = new Map<symbol, InitializationQueue>()

  constructor(
    private readonly placements: BrowserHostPagePlacementRegistry,
    private readonly grants: Map<string, BrowserClientPageExecutionHostGrant>,
    private readonly retirePlacement: (
      browserPageId: string,
      placement: RuntimeBrowserClientPlacement
    ) => void,
    private readonly requireState: (state: BrowserHostLeaseState) => void
  ) {}

  has(browserPageId: string): boolean {
    return this.operations.has(browserPageId)
  }

  admit(state: BrowserHostLeaseState, input: BrowserHostPageInitializationInput): boolean {
    if (!state.lease.hostCapabilities.includes(BROWSER_CLIENT_PAGE_INITIALIZATION_CAPABILITY)) {
      throw new Error('browser_client_page_initialization_unsupported')
    }
    const existing = this.operations.get(input.browserPageId)
    if (existing) {
      if (
        existing.unresolved &&
        existing.cleanup &&
        existing.state.lease.browserHostClientId === state.lease.browserHostClientId &&
        existing.state.lease.pairedDeviceId === state.lease.pairedDeviceId
      ) {
        existing.unresolved = false
        void existing.cleanup(state).then(
          () => {
            this.finish(existing, 'retained')
            if (!input.signal?.aborted && input.isCurrent()) {
              this.admit(state, { ...input, previous: undefined, pageHostGeneration: undefined })
            }
          },
          () => {
            existing.unresolved = true
            input.settled?.('unknown')
          }
        )
      }
      return false
    }
    this.requireState(state)
    if (input.signal?.aborted || !input.isCurrent()) {
      return false
    }
    const host = state.lease
    const reservation =
      input.pageHostGeneration === undefined
        ? this.placements.reserveNewClientPage(input.browserPageId, host)
        : this.placements.reserveClientPage(input.browserPageId, host, input.pageHostGeneration)
    const controller = new AbortController()
    const abort = (): void => {
      this.cancel(input.browserPageId, input.expected)
    }
    const operation: Initialization = {
      state,
      input,
      reservation,
      controller,
      connectionToken: state.connectionToken,
      running: false,
      createIssued: false,
      removeAbort: () => input.signal?.removeEventListener('abort', abort)
    }
    this.operations.set(input.browserPageId, operation)
    input.signal?.addEventListener('abort', abort, { once: true })
    const queue = this.queues.get(state.token) ?? { pending: [], active: 0 }
    this.queues.set(state.token, queue)
    queue.pending.push(operation)
    this.drain(state.token, queue)
    return true
  }

  cancel(browserPageId: string, expected: RuntimeBrowserClientPlacement): boolean {
    const operation = this.operations.get(browserPageId)
    if (
      !operation ||
      (operation.input.expected !== expected &&
        !sameInitializationPlacement(operation.input.expected, expected))
    ) {
      return false
    }
    this.placements.cancelClientPageReservation(operation.reservation)
    operation.controller.abort()
    if (!operation.running) {
      const queue = this.queues.get(operation.state.token)
      const index = queue?.pending.indexOf(operation) ?? -1
      if (index >= 0) {
        queue?.pending.splice(index, 1)
      }
      if (operation.input.previous) {
        operation.cleanup = (state) =>
          closeInitializationGuest(operation, operation.input.previous!, state)
        try {
          void operation.cleanup().then(
            () => this.finish(operation, 'retained'),
            () => {
              operation.unresolved = true
              operation.input.settled?.('unknown')
            }
          )
        } catch {
          operation.unresolved = true
          operation.input.settled?.('unknown')
        }
      } else {
        this.finish(operation, 'retained')
      }
    }
    return true
  }

  fence(state: BrowserHostLeaseState): void {
    for (const operation of this.operations.values()) {
      if (operation.state === state) {
        this.cancel(operation.input.browserPageId, operation.input.expected)
      }
    }
  }

  private drain(token: symbol, queue: InitializationQueue): void {
    while (queue.active < 4 && queue.pending.length > 0) {
      const operation = queue.pending.shift()!
      operation.running = true
      queue.active += 1
      void this.run(operation).then(
        (outcome) => this.finish(operation, outcome),
        () => {
          if (operation.closing) {
            void operation.closing.then(
              () => this.finish(operation, 'retained'),
              () => {
                operation.unresolved = true
                operation.input.settled?.('unknown')
              }
            )
          } else {
            operation.unresolved = true
            operation.input.settled?.('unknown')
          }
        }
      )
    }
    if (queue.active === 0 && queue.pending.length === 0) {
      this.queues.delete(token)
    }
  }

  private current(operation: Initialization): void {
    this.requireState(operation.state)
    if (
      this.operations.get(operation.input.browserPageId) !== operation ||
      operation.controller.signal.aborted ||
      operation.connectionToken !== operation.state.connectionToken ||
      !operation.input.isCurrent()
    ) {
      throw new Error('browser_client_page_initialization_stale')
    }
  }

  private async run(operation: Initialization): Promise<'published' | 'retained'> {
    const { input, state, reservation } = operation
    let releaseGrant: (() => void) | undefined
    let published = false
    try {
      this.current(operation)
      const executionHostKey = await input.resolveExecutionHostKey()
      this.current(operation)
      if (executionHostKey === null) {
        return 'retained'
      }
      releaseGrant = state.executionHostGrants.retain(executionHostKey).release
      if (input.previous) {
        operation.cleanup = (cleanupState) =>
          closeInitializationGuest(operation, input.previous!, cleanupState)
        await awaitInitializationResult(operation.cleanup(), operation.controller.signal)
        operation.cleanup = undefined
        operation.closing = undefined
      }
      this.current(operation)
      const previous = this.placements.getPlacement(input.browserPageId)
      if (previous) {
        if (!sameInitializationPlacement(previous, input.expected)) {
          throw new Error('browser_page_placement_stale')
        }
        this.retirePlacement(input.browserPageId, previous as RuntimeBrowserClientPlacement)
      }
      operation.cleanup = async (cleanupState) => {
        await closeInitializationReplacement(operation, cleanupState)
        releaseGrant?.()
        releaseGrant = undefined
      }
      await waitForClientPageCreationResult(
        issueInitializationCommand(
          operation,
          () => this.current(operation),
          reservation.placement.pageHostGeneration,
          {
            type: 'createPage',
            browserProfileId: input.browserProfileId,
            ...browserHostClientProfileFor(state.lease, input.browserProfileId),
            executionHostKey,
            workspaceId: input.workspaceId,
            initialUrl: input.url
          }
        ),
        clientPageCreationTimeout(input.creationTimeoutMs)
      )
      this.current(operation)
      const result = await issueInitializationCommand(
        operation,
        () => this.current(operation),
        reservation.placement.pageHostGeneration,
        {
          type: 'navigate',
          url: input.url
        }
      )
      this.current(operation)
      if (typeof result.value !== 'string') {
        throw new Error('browser_client_page_initialization_result_invalid')
      }
      const placement = this.placements.commitClientPageReservation(reservation)
      const grant = { placement, executionHostKey, release: releaseGrant }
      this.grants.set(input.browserPageId, grant)
      try {
        input.publish(placement, result.value, executionHostKey)
        published = true
      } catch (error) {
        this.grants.delete(input.browserPageId)
        this.placements.completePageRetirement(
          this.placements.beginPageRetirement(input.browserPageId, placement)
        )
        throw error
      }
      return 'published'
    } catch (error) {
      if (operation.cleanup && !operation.createIssued) {
        throw error
      }
      return 'retained'
    } finally {
      if (!published) {
        this.placements.cancelClientPageReservation(reservation)
        if (operation.createIssued) {
          await operation.cleanup?.()
        }
        releaseGrant?.()
      }
    }
  }

  private finish(operation: Initialization, outcome: 'published' | 'retained'): void {
    if (this.operations.get(operation.input.browserPageId) !== operation) {
      return
    }
    this.operations.delete(operation.input.browserPageId)
    operation.removeAbort()
    const queue = this.queues.get(operation.state.token)
    if (operation.running && queue) {
      queue.active -= 1
    }
    operation.input.settled?.(outcome)
    if (queue) {
      this.drain(operation.state.token, queue)
    }
  }
}

export function createBrowserHostPageInitializations(
  placements: BrowserHostPagePlacementRegistry,
  grants: Map<string, BrowserClientPageExecutionHostGrant>,
  retirePlacement: (id: string, placement: RuntimeBrowserClientPlacement) => void,
  requireLeaseState: (lease: BrowserHostLeaseIdentity) => BrowserHostLeaseState
): BrowserHostPageInitializations {
  return new BrowserHostPageInitializations(placements, grants, retirePlacement, (state) => {
    if (requireLeaseState(state.lease) !== state) {
      throw new Error('browser_host_lease_stale')
    }
  })
}
