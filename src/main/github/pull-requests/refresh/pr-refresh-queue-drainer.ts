import type {
  GitHubPRRefreshAlias,
  GitHubPRRefreshCandidate,
  PRRefreshOutcome
} from '../../../../shared/github/pull-requests/refresh/pull-request-refresh-types'
import { getPRForBranchOutcome } from '../../client/lookup/pr-for-branch-outcome'
import {
  hostedReviewOptionArgs,
  isBackground,
  isBudgetedBackground,
  validateCandidate
} from './pr-refresh-candidate-policy'
import type { PRRefreshEventPublisher } from './pr-refresh-event-publisher'
import { type PRRefreshPacing, usesActiveRefreshPacing } from './pr-refresh-pacing'
import type { PRRefreshQueue, PRRefreshQueueEntry } from './pr-refresh-queue'
import { PRWatchJobRunner } from './pr-refresh-watch-jobs'
import {
  scheduleVisibleFollowUp,
  type PRRefreshVisibleFollowUpOptions
} from './pr-refresh-visible-follow-up'
import { prRefreshRateLimitPausedUntil } from './pr-refresh-rate-limit-gate'
import {
  blockedWslDistroForPath,
  wslDistroForPath
} from '../../../wsl/filesystem/wsl-unc-access-gate'
import { outsideWslUserAct } from '../../../wsl/discovery/wsl-user-act-scope'
import type { PRRefreshRetryState } from './pr-refresh-retry-state'
import type { PRRefreshVisibility } from './pr-refresh-visibility'
import {
  prRefreshRequestDigest,
  PRRefreshRequestRegistry,
  queuedRequestId
} from './pr-refresh-request-registry'

export type PRRefreshRegistrationCheck = (candidate: GitHubPRRefreshCandidate) => boolean

/** Detail-recovery tickets run their entries and expire deadlines on this drainer's one timer. */
export type PRRefreshRecoveryHooks = {
  run: (entry: PRRefreshQueueEntry) => Promise<void>
  tick: () => number | null
}

export class PRRefreshQueueDrainer {
  private draining = false
  private timer: ReturnType<typeof setTimeout> | null = null
  // Why: queued work can outlive its project; re-check on every removal path before Git runs.
  private registrationCheck: PRRefreshRegistrationCheck | null = null
  private recovery: PRRefreshRecoveryHooks | null = null
  private recoveryDeadline: number | null = null
  readonly watchJobs: PRWatchJobRunner
  readonly requests = new PRRefreshRequestRegistry()

  constructor(
    private readonly queue: PRRefreshQueue,
    private readonly pacing: PRRefreshPacing,
    private readonly visibility: PRRefreshVisibility,
    private readonly retry: PRRefreshRetryState,
    private readonly events: PRRefreshEventPublisher
  ) {
    this.watchJobs = new PRWatchJobRunner(queue, retry, this)
  }

  setRegistrationCheck(check: PRRefreshRegistrationCheck | null): void {
    this.registrationCheck = check
  }

  getRegistrationCheck(): PRRefreshRegistrationCheck | null {
    return this.registrationCheck
  }

  setRecoveryHooks(hooks: PRRefreshRecoveryHooks | null): void {
    this.recovery = hooks
  }

  schedule(delay = 0): void {
    if (this.timer) {
      clearTimeout(this.timer)
    }
    const recoveryDelay =
      this.recoveryDeadline === null ? delay : Math.max(0, this.recoveryDeadline - Date.now())
    const wait = Math.min(delay, recoveryDelay)
    if (Number.isFinite(wait)) {
      this.timer = setTimeout(() => this.onTimer(), wait)
    }
  }

  private onTimer(): void {
    this.timer = null
    // Ticket leases and settlement budgets expire even while a provider read holds the drain.
    if (this.recovery) {
      this.recoveryDeadline = this.recovery.tick()
      if (this.recoveryDeadline !== null) {
        this.schedule(Number.POSITIVE_INFINITY)
      }
    }
    // The drain serves every queued repo; a scheduling call inside a WSL user act must not lend it that act.
    void outsideWslUserAct(() => this.drain())
  }

  scheduleVisibleFollowUp(
    key: string,
    candidate: GitHubPRRefreshCandidate,
    outcome: PRRefreshOutcome,
    priority: number,
    aliases: GitHubPRRefreshAlias[],
    windowId?: number,
    options?: PRRefreshVisibleFollowUpOptions
  ): void {
    scheduleVisibleFollowUp(
      {
        queue: this.queue,
        retry: this.retry,
        visibility: this.visibility,
        schedule: (d) => this.schedule(d)
      },
      { key, candidate, outcome, priority, aliases, windowId, options }
    )
  }

  private ordered(): PRRefreshQueueEntry[] {
    this.watchJobs.age(this.queue.values(), Date.now())
    return this.queue.ordered((a, b) => this.pacing.activeOrder(a, b))
  }

  private nextQueuedWakeDelay(excludedKey: string): number | null {
    const now = Date.now()
    let nextDelay = Number.POSITIVE_INFINITY
    for (const entry of this.queue.values()) {
      if (entry.key === excludedKey) {
        continue
      }
      const delay = entry.dueAt > now ? entry.dueAt - now : this.pacing.entryDelay(entry)
      nextDelay = Math.min(nextDelay, delay)
    }
    return Number.isFinite(nextDelay) ? Math.max(0, nextDelay) : null
  }

  private async drain(): Promise<void> {
    if (this.draining) {
      return
    }
    this.draining = true
    try {
      while (this.queue.size > 0) {
        let next = this.ordered()[0]
        const waitMs = next.dueAt - Date.now()
        if (waitMs > 0) {
          this.schedule(waitMs)
          return
        }

        let delay = this.pacing.entryDelay(next)
        if (delay > 0) {
          const runnable = this.ordered().find(
            (entry) => entry.dueAt <= Date.now() && this.pacing.entryDelay(entry) === 0
          )
          if (runnable && runnable.key !== next.key) {
            next = runnable
            delay = 0
          } else {
            this.notePacingDelay(next)
            this.schedule(Math.min(delay, this.nextQueuedWakeDelay(next.key) ?? delay))
            return
          }
        }

        if (next.recovery) {
          await this.recovery?.run(next)
          if (this.queue.get(next.key) === next && next.dueAt <= Date.now()) {
            this.queue.delete(next.key)
          }
          continue
        }
        this.queue.delete(next.key)
        const aliases = Array.from(next.aliases.values())
        const skippedReason = validateCandidate(next.candidate)
        if (skippedReason) {
          this.events.record('skipped', next.reason, skippedReason)
          this.events.broadcast({ aliases, reason: next.reason, status: 'skipped', skippedReason })
          continue
        }
        if (
          !(this.registrationCheck?.(next.candidate) ?? true) ||
          (next.reason === 'visible' && !this.visibility.has(next.key)) ||
          // E9: gh/Git in a stopped distro's repo boots it; a queued refresh keeps the current status.
          (isBackground(next.reason) &&
            wslDistroForPath(next.candidate.repoPath, next.candidate.localGitOptions?.wslDistro) &&
            (await blockedWslDistroForPath(
              next.candidate.repoPath,
              next.candidate.localGitOptions?.wslDistro
            )))
        ) {
          this.events.broadcast({
            aliases,
            reason: next.reason,
            status: 'skipped',
            skippedReason: 'fresh'
          })
          this.watchJobs.skipped(next)
          continue
        }
        const requestSequence = this.events.nextSequence()
        const requestStartedAt = Date.now()
        this.queue.noteRequestStarted(next.key, requestSequence)
        this.events.broadcast(
          { aliases, reason: next.reason, status: 'in-flight', requestStartedAt },
          requestSequence
        )

        if (isBackground(next.reason)) {
          const pausedUntil = await prRefreshRateLimitPausedUntil(next.candidate, true)
          if (!this.queue.ownsRequest(next.key, requestSequence)) {
            continue
          }
          if (pausedUntil !== null) {
            this.queue.protectBackgroundUntil(next.key, pausedUntil)
            this.queue.set(next.key, { ...next, dueAt: pausedUntil })
            this.events.broadcast({
              aliases,
              reason: next.reason,
              status: 'paused',
              pausedUntil,
              skippedReason: 'rate-limit'
            })
            this.schedule(Math.max(1_000, pausedUntil - Date.now()))
            continue
          }
          if (next.bypassBackgroundBudget !== true && isBudgetedBackground(next.reason)) {
            this.pacing.noteBackgroundStart()
            this.watchJobs.noteBudgetedStart(next)
          }
          if (usesActiveRefreshPacing(next)) {
            this.pacing.noteActiveStart(next)
          }
        }

        if (await this.watchJobs.readHead(next)) {
          continue
        }
        const requestId = queuedRequestId(next)
        this.requests.start({
          requestId,
          slotKey: next.key,
          registrationOrder: next.queuedAt,
          identityDigest: prRefreshRequestDigest(next.candidate, next.watch)
        })
        const outcome = await getPRForBranchOutcome(
          next.candidate.repoPath,
          next.candidate.branch,
          next.candidate.linkedPRNumber ?? null,
          next.candidate.connectionId ?? null,
          next.candidate.linkedPRNumber == null ? (next.candidate.fallbackPRNumber ?? null) : null,
          ...hostedReviewOptionArgs(next.candidate, next.reason, { watchPRKey: next.watch?.prKey })
        ).finally(() => this.requests.settle(requestId))
        if (!this.queue.ownsRequest(next.key, requestSequence)) {
          this.events.broadcast(
            { aliases, reason: next.reason, outcome, requestStartedAt },
            requestSequence
          )
          continue
        }
        let plannedRetryAt: number | undefined
        let broadcastOutcome = outcome
        if (outcome.kind === 'upstream-error' && this.visibility.has(next.key)) {
          plannedRetryAt = this.retry.nextVisibleErrorRetryAt(
            next.key,
            this.visibility.candidate(next.key, next.candidate)
          )
          broadcastOutcome = this.retry.withErrorSchedule(outcome, plannedRetryAt)
        }
        this.events.observe(next.candidate, outcome, aliases)
        this.retry.noteManualGate(next.key, broadcastOutcome)
        this.events.broadcast(
          { aliases, reason: next.reason, outcome: broadcastOutcome, requestStartedAt },
          requestSequence
        )
        if (next.watch) {
          this.watchJobs.afterOutcome(next, outcome)
          continue
        }
        this.scheduleVisibleFollowUp(
          next.key,
          next.candidate,
          outcome,
          next.priority,
          aliases,
          next.windowId,
          { plannedRetryAt }
        )
      }
    } finally {
      this.draining = false
    }
  }

  private notePacingDelay(entry: PRRefreshQueueEntry): void {
    if (this.pacing.isActiveBurstDelayed(entry) && !entry.activeDelayNotified) {
      entry.activeDelayNotified = true
      this.events.broadcast({
        aliases: Array.from(entry.aliases.values()),
        reason: entry.reason,
        status: 'queued'
      })
    }
    if (
      entry.bypassBackgroundBudget !== true &&
      isBudgetedBackground(entry.reason) &&
      this.pacing.nextBudgetDelay() > 0
    ) {
      this.events.record('background-pause', entry.reason)
    }
  }
}
