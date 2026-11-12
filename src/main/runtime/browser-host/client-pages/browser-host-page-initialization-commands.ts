import type {
  BrowserClientHostedPageInventory,
  BrowserClientHostCommandEvent
} from '../../../../shared/browser/client-hosting/browser-client-host-protocol'
import type { RuntimeBrowserClientPlacement } from '../../../../shared/runtime-browser-placement'
import type { BrowserHostLeaseState } from '../leases/browser-host-lease-records'
import type { BrowserClientPagePlacementReservation } from '../reconciliation/browser-host-page-placement'
import { assertBrowserHostPageCommandAdmission } from '../commands/browser-host-page-command-admission'

export type BrowserHostPageInitializationInput = {
  browserPageId: string
  browserProfileId: string
  workspaceId: string
  expected: RuntimeBrowserClientPlacement
  url: string
  pageHostGeneration?: number
  previous?: BrowserClientHostedPageInventory
  creationTimeoutMs?: number
  signal?: AbortSignal
  isCurrent(): boolean
  resolveExecutionHostKey(): Promise<string | null>
  publish(placement: RuntimeBrowserClientPlacement, url: string, executionHostKey: string): void
  settled?(outcome: 'published' | 'retained' | 'unknown'): void
}

export type Initialization = {
  input: BrowserHostPageInitializationInput
  state: BrowserHostLeaseState
  connectionToken: symbol
  reservation: BrowserClientPagePlacementReservation
  controller: AbortController
  removeAbort(): void
  running: boolean
  createIssued: boolean
  cleanup?: (state?: BrowserHostLeaseState) => Promise<void>
  closing?: Promise<void>
  unresolved?: boolean
}

export function issueInitializationCommand(
  operation: Initialization,
  current: () => void,
  generation: number,
  command: BrowserClientHostCommandEvent['command'],
  resultAdmission: 'reserved-page' | 'reconciliation' = 'reserved-page'
) {
  const { state, input } = operation
  current()
  assertBrowserHostPageCommandAdmission(state.lease, command, (key) =>
    state.executionHostGrants.require(key)
  )
  const issued = state.commandLedger!.issue({
    browserPageId: input.browserPageId,
    pageHostGeneration: generation,
    command,
    resultAdmission
  })
  if (command.type === 'createPage') {
    operation.createIssued = true
  }
  return awaitInitializationResult(
    issued.result.then((result) => {
      if (result.status === 'failed') {
        throw new Error(result.errorCode)
      }
      return result
    }),
    operation.controller.signal
  )
}

export function closeInitializationReplacement(
  operation: Initialization,
  state?: BrowserHostLeaseState
): Promise<void> {
  return closeInitializationGuest(
    operation,
    {
      ...operation.reservation.placement,
      authorityRuntimeId: operation.state.lease.authorityRuntimeId,
      authorityEpoch: operation.state.lease.authorityEpoch
    },
    state
  )
}

export function closeInitializationGuest(
  operation: Initialization,
  target: {
    authorityRuntimeId: string
    authorityEpoch: string
    browserHostClientId: string
    browserHostGeneration: number
    pageHostGeneration: number
  },
  state = operation.state
): Promise<void> {
  if (operation.closing) {
    return operation.closing
  }
  const issued = state.commandLedger!.issue({
    browserPageId: operation.input.browserPageId,
    pageHostGeneration: target.pageHostGeneration,
    command: { type: 'closePage', targetAuthority: target },
    resultAdmission: 'reconciliation'
  })
  const closing = issued.result.then((result) => {
    if (result.status === 'failed') {
      throw new Error(result.errorCode)
    }
    state.commandLedger!.retirePage(operation.input.browserPageId, target.pageHostGeneration)
  })
  operation.closing = closing
  void closing.catch(() => {
    if (operation.closing === closing) {
      operation.closing = undefined
    }
  })
  return closing
}

export function sameInitializationPlacement(
  left: {
    kind: string
    browserHostClientId?: string
    browserHostGeneration?: number
    pageHostGeneration?: number
  },
  right: RuntimeBrowserClientPlacement
): boolean {
  return (
    left.kind === 'client' &&
    left.browserHostClientId === right.browserHostClientId &&
    left.browserHostGeneration === right.browserHostGeneration &&
    left.pageHostGeneration === right.pageHostGeneration
  )
}

export async function awaitInitializationResult<T>(
  result: Promise<T>,
  signal: AbortSignal
): Promise<T> {
  let remove = (): void => {}
  const aborted = new Promise<never>((_resolve, reject) => {
    const abort = (): void => reject(new Error('browser_client_page_initialization_cancelled'))
    if (signal.aborted) {
      abort()
    } else {
      signal.addEventListener('abort', abort, { once: true })
      remove = () => signal.removeEventListener('abort', abort)
    }
  })
  try {
    return await Promise.race([result, aborted])
  } finally {
    remove()
  }
}
