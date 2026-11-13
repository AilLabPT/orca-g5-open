import type {
  GitHubPRRefreshAlias,
  GitHubPRRefreshCandidate,
  PRRefreshOutcome
} from '../../../../shared/github/pull-requests/refresh/pull-request-refresh-types'
import {
  aliasFromCandidate,
  freshRetryAt,
  isMergeabilityPendingOutcome,
  sameAliasRequestIdentity,
  visibleCandidateAfterOutcome
} from './pr-refresh-candidate-policy'
import type { PRRefreshQueue } from './pr-refresh-queue'
import type { PRRefreshRetryState } from './pr-refresh-retry-state'
import type { PRRefreshVisibility } from './pr-refresh-visibility'

export type PRRefreshVisibleFollowUpOptions = {
  pendingMergeabilityDelayMs?: number
  plannedRetryAt?: number
}

/** After a read: back off a visible error, or schedule the next periodic visible read. */
export function scheduleVisibleFollowUp(
  deps: {
    queue: PRRefreshQueue
    retry: PRRefreshRetryState
    visibility: PRRefreshVisibility
    schedule: (delay: number) => void
  },
  args: {
    key: string
    candidate: GitHubPRRefreshCandidate
    outcome: PRRefreshOutcome
    priority: number
    aliases: GitHubPRRefreshAlias[]
    windowId?: number
    options?: PRRefreshVisibleFollowUpOptions
  }
): void {
  const { key, candidate, outcome, priority, aliases, windowId, options } = args
  if (outcome.kind === 'upstream-error') {
    const retryAt = Math.max(
      options?.plannedRetryAt ??
        deps.retry.nextVisibleErrorRetryAt(key, deps.visibility.candidate(key, candidate)),
      deps.retry.manualGateUntil(key)
    )
    deps.queue.protectBackgroundUntil(key, retryAt)
    if (!deps.visibility.has(key)) {
      return
    }
    deps.queue.setVisibleFollowUp({
      key,
      candidate,
      aliases: new Map(aliases.map((alias) => [alias.cacheKey, alias])),
      reason: 'visible',
      priority,
      dueAt: retryAt,
      queuedAt: deps.queue.nextOrder(),
      windowId
    })
    deps.schedule(retryAt - Date.now())
    return
  }
  deps.retry.reset(key)
  const refreshed = visibleCandidateAfterOutcome(candidate, outcome)
  deps.visibility.update(refreshed)
  if (!deps.visibility.has(key)) {
    return
  }
  const followUpCandidate = deps.visibility.candidate(key, refreshed)
  const regularDueAt = freshRetryAt(followUpCandidate) ?? Date.now()
  const pendingDueAt =
    options?.pendingMergeabilityDelayMs !== undefined && isMergeabilityPendingOutcome(outcome)
      ? outcome.fetchedAt + options.pendingMergeabilityDelayMs
      : null
  const dueAt = pendingDueAt === null ? regularDueAt : Math.min(regularDueAt, pendingDueAt)
  if (!Number.isFinite(dueAt)) {
    const pending = deps.queue.get(key)
    if (
      pending?.reason === 'visible' &&
      sameAliasRequestIdentity(
        aliasFromCandidate(pending.candidate),
        aliasFromCandidate(followUpCandidate)
      )
    ) {
      deps.queue.delete(key)
    }
    return
  }
  deps.queue.setVisibleFollowUp({
    key,
    candidate: followUpCandidate,
    aliases: new Map(aliases.map((alias) => [alias.cacheKey, alias])),
    reason: 'visible',
    priority,
    dueAt,
    queuedAt: deps.queue.nextOrder(),
    bypassBackgroundBudget: pendingDueAt !== null,
    followUp: true,
    windowId
  })
  deps.schedule(Math.max(0, dueAt - Date.now()))
}
