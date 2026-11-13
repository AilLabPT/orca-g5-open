import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { coordinatorMocks, moduleMocks } = await vi.hoisted(async () => {
  const moduleMocks =
    await import('../../../../../github/pull-requests/refresh/pr-refresh-coordinator-test-mocks')
  return { coordinatorMocks: moduleMocks.createPRRefreshCoordinatorMocks(), moduleMocks }
})

vi.mock('../../../../../github/pull-requests/refresh/pr-refresh-renderer-port', () =>
  moduleMocks.rendererPortModuleMock(coordinatorMocks)
)
vi.mock('../../../../../github/client/lookup/pr-for-branch-outcome', () =>
  moduleMocks.clientModuleMock(coordinatorMocks)
)
vi.mock('../../../../../github/repositories/github-api-repository-remote-probe', () =>
  moduleMocks.githubApiRepositoryModuleMock(coordinatorMocks)
)
vi.mock('../../../../../github/api/rate-limit', () =>
  moduleMocks.rateLimitModuleMock(coordinatorMocks)
)

import { makePR } from '../../../../../github/pull-requests/refresh/pr-refresh-coordinator-test-harness'
import type { RpcContext } from '../../../core'

// The coordinator test reset pins fake time here.
const START_AT = 1_000
const { getPRForBranchOutcomeMock } = coordinatorMocks

const identity = {
  sourceEpoch: 'runtime:env:rt:1',
  repoId: 'server-repo',
  repoPath: '/client/path/ignored',
  worktreeId: 'wt-1',
  branch: 'feature/test',
  currentHeadOid: 'h2',
  executionHostId: null,
  provider: 'github' as const,
  linkedPRNumber: null,
  fallbackPRNumber: 7,
  fallbackPRSource: 'hosted-review' as const,
  selectionRevision: '|||||'
}

async function methods() {
  const { GITHUB_PR_DETAIL_RECOVERY_METHODS } = await import('./github-pr-detail-recovery-methods')
  const byName = Object.fromEntries(GITHUB_PR_DETAIL_RECOVERY_METHODS.map((m) => [m.name, m]))
  const runtime = {
    resolvePRDetailRecoveryCandidate: async () => ({
      cacheKey: '/server/repo::feature/test',
      repoKind: 'git' as const,
      repoId: 'server-repo',
      repoPath: '/server/repo',
      branch: 'feature/test',
      worktreeId: 'wt-1',
      currentHeadOid: 'h2',
      fallbackPRNumber: 7,
      fallbackPRSource: 'hosted-review' as const,
      connectionId: null,
      executionHostId: null
    })
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: these handlers read only runtime.resolvePRDetailRecoveryCandidate and the caller identity.
  const context = (clientId: string) => ({ runtime, clientId }) as unknown as RpcContext
  // oxlint-disable-next-line typescript/no-explicit-any -- each method's params differ; the schemas are tested elsewhere.
  const call = (name: string, params: unknown, clientId = 'phone-1'): Promise<any> => {
    const method = byName[name]
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the method's own schema parses the params first, as the dispatcher does.
    return method.handler(method.params.parse(params) as never, context(clientId))
  }
  return { call }
}

describe('github.prDetailRecovery runtime methods', () => {
  beforeEach(() => {
    moduleMocks.resetPRRefreshCoordinatorMocks(coordinatorMocks)
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('runs a headless ticket through the shared drainer with the server repo path', async () => {
    getPRForBranchOutcomeMock.mockResolvedValue({
      kind: 'found',
      pr: makePR({ number: 8 }),
      fetchedAt: START_AT
    })
    const { call } = await methods()
    const started = await call('github.prDetailRecovery.start', {
      clientEpoch: { scope: 'panel', counter: 1 },
      identity,
      cacheKey: 'client-cache-key'
    })
    await vi.advanceTimersByTimeAsync(0)
    const prepared = await call('github.prDetailRecovery.wait', {
      ticketId: started.ticketId,
      afterRevision: started.revision
    })
    expect(prepared.phase).toBe('preparing')
    expect(
      await call(
        'github.prDetailRecovery.wait',
        { ticketId: started.ticketId, afterRevision: 0 },
        'phone-2'
      )
    ).toBeNull()

    await call('github.prDetailRecovery.commit', {
      ticketId: started.ticketId,
      prepareToken: prepared.preparation.token,
      publicationGrantId: 'grant-1'
    })
    await vi.advanceTimersByTimeAsync(0)
    const settled = await call('github.prDetailRecovery.wait', {
      ticketId: started.ticketId,
      afterRevision: 0
    })
    expect(getPRForBranchOutcomeMock).toHaveBeenCalledTimes(1)
    expect(getPRForBranchOutcomeMock.mock.calls[0][0]).toBe('/server/repo')
    expect(getPRForBranchOutcomeMock.mock.calls[0][4]).toBe(7)
    expect(settled.terminal).toMatchObject({ kind: 'settled', outcome: { pr: { number: 8 } } })
  })
})
