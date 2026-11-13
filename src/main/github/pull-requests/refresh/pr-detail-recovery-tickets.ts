import { randomUUID } from 'node:crypto'
import {
  PR_DETAIL_RECOVERY_LEASE_MS,
  PR_DETAIL_RECOVERY_MAX_TICKETS,
  PR_DETAIL_RECOVERY_PREPARE_TTL_MS,
  PR_DETAIL_RECOVERY_RETENTION_MS,
  prDetailRecoveryIdentityDigest,
  type PRDetailRecoveryCommitArgs,
  type PRDetailRecoveryNotAdmittedReason,
  type PRDetailRecoverySnapshot,
  type PRDetailRecoveryStartArgs,
  type PRDetailRecoveryTerminal
} from '../../../../shared/github/pull-requests/refresh/pr-detail-recovery-contract'
import type { GitHubPRRefreshCandidate } from '../../../../shared/github/pull-requests/refresh/pull-request-refresh-types'
import type { PRRefreshQueue } from './pr-refresh-queue'
import type { PRRefreshRegistration, PRRefreshRequestRegistry } from './pr-refresh-request-registry'
import {
  createPRDetailRecoveryTicket,
  prDetailRecoveryPredecessorOutstanding
} from './pr-detail-recovery-submission'
import type { PRRefreshRetryState } from './pr-refresh-retry-state'
import { expirePRDetailRecoveryTickets } from './pr-detail-recovery-expiry'
import {
  bumpTicket,
  recoveryQueueEntry,
  recoveryQueueKey,
  waitForTicketChange,
  refusedSnapshot,
  snapshotTicket,
  type PRDetailRecoveryCaller,
  type PRDetailRecoveryTicket
} from './pr-detail-recovery-ticket-model'

type Deps = {
  queue: PRRefreshQueue
  requests: PRRefreshRequestRegistry
  retry: PRRefreshRetryState
  scheduleDrain: () => void
}

/** Queued detail-recovery tickets: correlated, one-shot reads owned by the PR refresh coordinator. */
export class PRDetailRecoveryTickets {
  private readonly tickets = new Map<string, PRDetailRecoveryTicket>()
  private readonly byEpoch = new Map<string, string>()
  private readonly watermarks = new Map<string, number>()
  private acceptSequence = 0
  private prepareSequence = 0

  constructor(private readonly deps: Deps) {}

  get(ticketId: string): PRDetailRecoveryTicket | undefined {
    return this.tickets.get(ticketId)
  }

  start(
    caller: PRDetailRecoveryCaller,
    args: PRDetailRecoveryStartArgs,
    resolved: GitHubPRRefreshCandidate | PRDetailRecoveryNotAdmittedReason
  ): PRDetailRecoverySnapshot {
    const epochKey = `${caller.callerKey}|${args.clientEpoch.scope}`
    const digest = prDetailRecoveryIdentityDigest(args.identity)
    const existing = this.tickets.get(this.byEpoch.get(epochKey) ?? '')
    if (existing && existing.counter === args.clientEpoch.counter) {
      if (existing.digest !== digest) {
        return refusedSnapshot(args.identity, { kind: 'not-admitted', reason: 'epoch-conflict' })
      }
      this.renew(existing)
      return snapshotTicket(existing)
    }
    if (args.clientEpoch.counter <= (this.watermarks.get(epochKey) ?? -1)) {
      return refusedSnapshot(args.identity, { kind: 'expired' })
    }
    this.watermarks.set(epochKey, args.clientEpoch.counter)
    if (existing && !existing.terminal) {
      this.close(existing, { kind: 'cancelled' })
    }
    if (typeof resolved === 'string') {
      return refusedSnapshot(args.identity, { kind: 'not-admitted', reason: resolved })
    }
    if (this.tickets.size >= PR_DETAIL_RECOVERY_MAX_TICKETS) {
      return refusedSnapshot(args.identity, { kind: 'not-admitted', reason: 'capacity' })
    }
    this.acceptSequence += 1
    const ticket = createPRDetailRecoveryTicket(this.deps.queue, this.deps.requests, {
      caller,
      args,
      candidate: resolved,
      epochKey,
      digest,
      acceptSequence: this.acceptSequence
    })
    this.tickets.set(ticket.ticketId, ticket)
    this.byEpoch.set(epochKey, ticket.ticketId)
    this.advance(ticket)
    this.deps.scheduleDrain()
    return snapshotTicket(ticket)
  }

  /** Move a ticket whose predecessors settled into the queue; never re-enqueue a closed one. */
  private advance(ticket: PRDetailRecoveryTicket): void {
    if (ticket.terminal || (ticket.phase !== 'waiting-existing' && ticket.phase !== 'queued')) {
      return
    }
    if (
      ticket.predecessors.some((p) =>
        prDetailRecoveryPredecessorOutstanding(this.deps.queue, this.deps.requests, ticket, p)
      )
    ) {
      return
    }
    const key = recoveryQueueKey(ticket.ticketId)
    if (this.deps.queue.get(key)) {
      return
    }
    const now = Date.now()
    // Recovery bypasses fresh-cache answers only; cooldown, error backoff and manual gates still hold.
    const dueAt = Math.max(
      now,
      this.deps.queue.backgroundUntil(ticket.slotKey),
      this.deps.retry.manualGateUntil(ticket.slotKey)
    )
    ticket.phase = dueAt > now ? 'paused' : 'queued'
    ticket.notBefore = dueAt > now ? dueAt : undefined
    this.deps.queue.set(key, recoveryQueueEntry(ticket, dueAt, false))
    bumpTicket(ticket)
  }

  /** Queue or read settlement: wake predecessor waiters and close orphaned queued tickets. */
  recheck(): void {
    for (const ticket of this.tickets.values()) {
      if (ticket.terminal) {
        continue
      }
      if (ticket.phase === 'waiting-existing') {
        this.advance(ticket)
        continue
      }
      const queued = this.deps.queue.get(recoveryQueueKey(ticket.ticketId))
      if ((ticket.phase === 'queued' || ticket.phase === 'paused') && !queued) {
        this.close(ticket, { kind: 'not-admitted', reason: 'unregistered' })
      }
    }
  }

  /** Later independent work for this alias wins: before admission the ticket closes, after it the read loses publication. */
  onRegistration(registration: PRRefreshRegistration): void {
    if (!registration.independent) {
      return
    }
    for (const ticket of this.tickets.values()) {
      if (
        !ticket.terminal &&
        ticket.slotKey === registration.slotKey &&
        registration.registrationOrder > ticket.acceptOrder &&
        registration.aliases.some((alias) => alias.cacheKey === ticket.alias.cacheKey)
      ) {
        this.close(ticket, { kind: 'superseded' })
      }
    }
  }

  prepare(ticket: PRDetailRecoveryTicket): void {
    this.deps.queue.delete(recoveryQueueKey(ticket.ticketId))
    this.prepareSequence += 1
    ticket.phase = 'preparing'
    ticket.notBefore = undefined
    ticket.preparation = {
      token: randomUUID(),
      expiresAt: Date.now() + PR_DETAIL_RECOVERY_PREPARE_TTL_MS,
      prepareSequence: this.prepareSequence
    }
    ticket.committedToken = undefined
    ticket.publicationGrantId = undefined
    bumpTicket(ticket)
    this.deps.scheduleDrain()
  }

  /** A gate moved before dispatch: retire the token and its grant, then prepare again after the gate. */
  pause(ticket: PRDetailRecoveryTicket, until: number): void {
    const key = recoveryQueueKey(ticket.ticketId)
    const entry = this.deps.queue.get(key)
    if (entry) {
      entry.dueAt = until
      if (entry.recovery) {
        entry.recovery.committed = false
      }
    }
    ticket.phase = 'paused'
    ticket.notBefore = until
    ticket.preparation = undefined
    ticket.committedToken = undefined
    ticket.publicationGrantId = undefined
    bumpTicket(ticket)
    this.deps.scheduleDrain()
  }

  commit(callerKey: string, args: PRDetailRecoveryCommitArgs): PRDetailRecoverySnapshot | null {
    const ticket = this.owned(callerKey, args.ticketId)
    if (!ticket) {
      return null
    }
    this.renew(ticket)
    if (ticket.committedToken === args.prepareToken) {
      return snapshotTicket(ticket)
    }
    const preparation = ticket.preparation
    if (
      ticket.terminal ||
      ticket.phase !== 'preparing' ||
      !preparation ||
      preparation.token !== args.prepareToken ||
      preparation.expiresAt <= Date.now()
    ) {
      return snapshotTicket(ticket)
    }
    ticket.committedToken = args.prepareToken
    ticket.publicationGrantId = args.publicationGrantId
    // Committed work waits in the queue under ordinary pacing; the preparation deadline no longer applies.
    ticket.phase = 'queued'
    const key = recoveryQueueKey(ticket.ticketId)
    this.deps.queue.set(key, recoveryQueueEntry(ticket, Date.now(), true))
    bumpTicket(ticket)
    this.deps.scheduleDrain()
    return snapshotTicket(ticket)
  }

  admit(ticket: PRDetailRecoveryTicket, requestSequence: number, settleDeadline: number): void {
    ticket.phase = 'admitted'
    ticket.admitted = true
    ticket.requestSequence = requestSequence
    ticket.requestStartedAt = Date.now()
    ticket.settleDeadline = settleDeadline
    bumpTicket(ticket)
  }

  close(ticket: PRDetailRecoveryTicket, terminal: PRDetailRecoveryTerminal): void {
    if (ticket.terminal) {
      return
    }
    ticket.phase = 'terminal'
    ticket.terminal = terminal
    ticket.preparation = undefined
    ticket.retainUntil = Date.now() + PR_DETAIL_RECOVERY_RETENTION_MS
    if (!ticket.admitted) {
      this.deps.queue.delete(recoveryQueueKey(ticket.ticketId))
    }
    bumpTicket(ticket)
    this.deps.scheduleDrain()
  }

  cancel(callerKey: string, ticketId: string): PRDetailRecoverySnapshot | null {
    const ticket = this.owned(callerKey, ticketId)
    if (!ticket) {
      return null
    }
    this.close(ticket, { kind: 'cancelled' })
    return snapshotTicket(ticket)
  }

  cancelCaller(callerKey: string): void {
    for (const ticket of this.tickets.values()) {
      if (ticket.caller.callerKey === callerKey) {
        this.close(ticket, { kind: 'cancelled' })
      }
    }
  }

  /** Bounded observation; it never enqueues, admits or reads. */
  async wait(
    callerKey: string,
    ticketId: string,
    afterRevision: number,
    signal?: AbortSignal
  ): Promise<PRDetailRecoverySnapshot | null> {
    const ticket = this.owned(callerKey, ticketId)
    if (!ticket) {
      return null
    }
    this.renew(ticket)
    if (ticket.revision > afterRevision || ticket.terminal) {
      return snapshotTicket(ticket)
    }
    await waitForTicketChange(ticket, signal)
    if (!ticket.terminal) {
      this.renew(ticket)
    }
    return snapshotTicket(ticket)
  }

  /** Expire leases, preparations, settlement budgets and retention; returns the next deadline. */
  tick(now = Date.now()): number | null {
    return expirePRDetailRecoveryTickets(this.tickets.values(), now, this.deps.queue, {
      close: (ticket, terminal) => this.close(ticket, terminal),
      forget: (ticket) => {
        this.tickets.delete(ticket.ticketId)
        if (this.byEpoch.get(ticket.epochKey) === ticket.ticketId) {
          this.byEpoch.delete(ticket.epochKey)
        }
      }
    })
  }

  private owned(callerKey: string, ticketId: string): PRDetailRecoveryTicket | undefined {
    const ticket = this.tickets.get(ticketId)
    return ticket?.caller.callerKey === callerKey ? ticket : undefined
  }

  private renew(ticket: PRDetailRecoveryTicket): void {
    if (!ticket.terminal) {
      ticket.leaseUntil = Date.now() + PR_DETAIL_RECOVERY_LEASE_MS
    }
  }
}
