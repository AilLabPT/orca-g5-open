import type {
  PRDetailRecoveryIdentity,
  PRDetailRecoveryTerminal
} from '../../../../../shared/github/pull-requests/refresh/pr-detail-recovery-contract'
import type { Repo } from '../../../../../shared/repo-types'
import type {
  PRDetailRecoveryContext,
  PRDetailRecoveryOwner,
  PRDetailRecoveryStatus
} from './pr-detail-recovery-context'
import type { PRDetailRecoveryGrant } from './pr-detail-recovery-publication'
import type { PRDetailRecoveryTransport } from './pr-detail-recovery-transport'

/** One panel context's automatic recovery: at most one is current per store. */
export type PRDetailRecoverySubscription = {
  contextKey: string
  context: PRDetailRecoveryContext
  owner: PRDetailRecoveryOwner
  cancelled: boolean
  transport: PRDetailRecoveryTransport | null
  ticketId: string | null
  grant: PRDetailRecoveryGrant | null
  intentRevision: number
}

const LOCAL_WAIT_BUDGET_MS = 30_000

/** Await another request's settlement within the local budget; true when it settled either way. */
export function awaitWithBudget(promise: Promise<unknown>): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), LOCAL_WAIT_BUDGET_MS)
    const settled = (): void => {
      clearTimeout(timer)
      resolve(true)
    }
    void promise.then(settled, settled)
  })
}

export function buildPRDetailRecoveryIdentity(
  sub: PRDetailRecoverySubscription,
  transport: PRDetailRecoveryTransport,
  runtimeRepo: Repo | null
): PRDetailRecoveryIdentity {
  const { context } = sub
  const unlinked = context.linkedPRNumber == null
  return {
    sourceEpoch: transport.sourceEpoch,
    repoId: runtimeRepo?.id ?? sub.owner.repo.id,
    repoPath: runtimeRepo?.path ?? sub.owner.repo.path,
    worktreeId: context.worktreeId,
    branch: context.branch,
    currentHeadOid: context.headOid,
    executionHostId: sub.owner.repo.executionHostId ?? null,
    provider: 'github',
    linkedPRNumber: context.linkedPRNumber,
    fallbackPRNumber: unlinked ? context.hintPRNumber : null,
    fallbackPRSource: unlinked ? 'hosted-review' : null,
    selectionRevision: context.selectionRevision
  }
}

/** Settling a ticket and accepting its PR are separate: a refused publication hands status back. */
export function terminalRecoveryStatus(
  terminal: PRDetailRecoveryTerminal,
  published: boolean,
  usable: () => boolean
): PRDetailRecoveryStatus {
  switch (terminal.kind) {
    case 'settled':
      if (terminal.outcome.kind === 'upstream-error') {
        return { kind: 'failed', errorType: terminal.outcome.errorType }
      }
      if (!published) {
        return { kind: 'closed' }
      }
      return usable() ? { kind: 'resolved' } : { kind: 'unusable' }
    case 'timeout':
      return { kind: 'timeout' }
    case 'superseded':
    case 'cancelled':
      return { kind: 'closed' }
    default:
      return { kind: 'failed' }
  }
}
