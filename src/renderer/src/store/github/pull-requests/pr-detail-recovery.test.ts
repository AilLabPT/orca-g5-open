import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import type { PRDetailRecoveryStartArgs } from '../../../../../shared/github/pull-requests/refresh/pr-detail-recovery-contract'

// Host modules load by computed path so the web typecheck project stays free of main-process code.
type HostModule = Record<string, (...args: unknown[]) => unknown>
type HostMocks = Record<string, Mock> & { getPRForBranchOutcomeMock: Mock }
const loadHost = (path: string): Promise<HostModule> =>
  import(/* @vite-ignore */ `../../../../../main/github/${path}`)

const { coordinatorMocks, moduleMocks } = await vi.hoisted(async () => {
  const mocksPath =
    '../../../../../main/github/pull-requests/refresh/pr-refresh-coordinator-test-mocks'
  const moduleMocks: HostModule = await import(/* @vite-ignore */ mocksPath)
  return {
    coordinatorMocks: moduleMocks.createPRRefreshCoordinatorMocks() as unknown as HostMocks,
    moduleMocks
  }
})

vi.mock(
  '../../../../../main/github/pull-requests/refresh/pr-refresh-renderer-port',
  () => moduleMocks.rendererPortModuleMock(coordinatorMocks) as Record<string, unknown>
)
vi.mock(
  '../../../../../main/github/client/lookup/pr-for-branch-outcome',
  () => moduleMocks.clientModuleMock(coordinatorMocks) as Record<string, unknown>
)
vi.mock(
  '../../../../../main/github/repositories/github-api-repository-remote-probe',
  () => moduleMocks.githubApiRepositoryModuleMock(coordinatorMocks) as Record<string, unknown>
)
vi.mock(
  '../../../../../main/github/api/rate-limit',
  () => moduleMocks.rateLimitModuleMock(coordinatorMocks) as Record<string, unknown>
)

import {
  createTestStore,
  makePR,
  makePRRefreshWorktree,
  mockApi
} from '../github-slice-test-harness'
import { getGitHubRepoCacheKey } from '../../../../../shared/github/cache/github-cache-key'

const { getPRForBranchOutcomeMock } = coordinatorMocks
const repo = { id: 'repo-1', path: '/repo', displayName: 'Repo', badgeColor: 'blue', addedAt: 1 }
const worktree = makePRRefreshWorktree({ id: 'wt-1', branch: 'feature/test', head: 'h2' })
const context = {
  worktreeId: 'wt-1',
  repoId: 'repo-1',
  repoPath: '/repo',
  branch: 'feature/test',
  headOid: 'h2',
  linkedPRNumber: null,
  hintPRNumber: 7,
  hostedReviewCacheKey: 'hosted::/repo::feature/test',
  selectionRevision: '|||||'
}

/** The native preload bridge, reaching the real host coordinator and drainer in-process. */
async function connectNativeBridge(): Promise<void> {
  const host = await loadHost('pull-requests/refresh/pr-detail-recovery-coordinator')
  const { prDetailRecoveryCandidate } = await loadHost(
    'pull-requests/refresh/pr-detail-recovery-candidate'
  )
  const { refreshPRNow } = await loadHost('pull-requests/refresh/pr-refresh-coordinator')
  const callerKey = 'ipc:1'
  mockApi.gh.refreshPRNow.mockImplementation((args) => refreshPRNow(args.candidate, args.reason))
  Object.assign(mockApi.gh, {
    startPRDetailRecovery: async (args: PRDetailRecoveryStartArgs) =>
      host.startPRDetailRecovery(
        { callerKey, windowId: 1 },
        args,
        prDetailRecoveryCandidate(args) ?? 'validation'
      ),
    waitPRDetailRecovery: (args: { ticketId: string; afterRevision: number }) =>
      host.waitPRDetailRecovery(callerKey, args.ticketId, args.afterRevision),
    commitPRDetailRecovery: async (args: object) => host.commitPRDetailRecovery(callerKey, args),
    cancelPRDetailRecovery: async (args: { ticketId: string }) =>
      host.cancelPRDetailRecovery(callerKey, args.ticketId)
  })
}

function setup() {
  const store = createTestStore()
  // Recovery subscription state is per renderer; start each case from a hidden panel.
  store.getState().notePRDetailRecoveryPanelVisible(false)
  store.setState({ repos: [repo], worktreesByRepo: { 'repo-1': [worktree] } })
  const cacheKey = getGitHubRepoCacheKey(
    '/repo',
    'repo-1',
    'feature/test',
    store.getState().settings,
    undefined,
    undefined,
    true
  )
  return { store, cacheKey }
}

describe('Checks detail recovery through the host coordinator', () => {
  beforeEach(async () => {
    moduleMocks.resetPRRefreshCoordinatorMocks(coordinatorMocks)
    await connectNativeBridge()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('publishes the current-HEAD read through the guarded writer once per exposure', async () => {
    getPRForBranchOutcomeMock.mockResolvedValue({
      kind: 'found',
      pr: makePR({ number: 8, url: 'https://github.com/acme/widgets/pull/8', headSha: 'h2' }),
      fetchedAt: Date.now()
    })
    const { store, cacheKey } = setup()
    store.getState().notePRDetailRecoveryPanelVisible(true)
    store.getState().reconcileGitHubPRDetails(context)
    await vi.advanceTimersByTimeAsync(1_000)

    expect(getPRForBranchOutcomeMock).toHaveBeenCalledTimes(1)
    expect(getPRForBranchOutcomeMock.mock.calls[0][4]).toBe(7)
    expect(store.getState().prCache[cacheKey]?.data?.number).toBe(8)
    expect(store.getState().prDetailRecovery?.status).toEqual({ kind: 'resolved' })

    store.getState().reconcileGitHubPRDetails(null)
    store.getState().reconcileGitHubPRDetails(context)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(getPRForBranchOutcomeMock).toHaveBeenCalledTimes(1)
  })

  it('reports an unusable read without retrying it in the same exposure', async () => {
    getPRForBranchOutcomeMock.mockResolvedValue({ kind: 'no-pr', fetchedAt: Date.now() })
    const { store } = setup()
    store.getState().notePRDetailRecoveryPanelVisible(true)
    store.getState().reconcileGitHubPRDetails(context)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(store.getState().prDetailRecovery?.status).toEqual({ kind: 'unusable' })
    expect(store.getState().prDetailRecovery?.terminalCount).toBe(1)

    store.getState().reconcileGitHubPRDetails({ ...context })
    await vi.advanceTimersByTimeAsync(60_000)
    expect(getPRForBranchOutcomeMock).toHaveBeenCalledTimes(1)

    store.getState().notePRDetailRecoveryPanelVisible(false)
    store.getState().notePRDetailRecoveryPanelVisible(true)
    store.getState().reconcileGitHubPRDetails(context)
    await vi.advanceTimersByTimeAsync(15_000)
    expect(getPRForBranchOutcomeMock).toHaveBeenCalledTimes(2)
  })

  it('waits for an in-flight direct read before submitting, then reads once', async () => {
    const direct = Promise.withResolvers<{ kind: 'no-pr'; fetchedAt: number }>()
    getPRForBranchOutcomeMock
      .mockReturnValueOnce(direct.promise)
      .mockResolvedValue({ kind: 'no-pr', fetchedAt: Date.now() })
    const { store } = setup()
    store.getState().notePRDetailRecoveryPanelVisible(true)
    void store.getState().fetchPRForBranch('/repo', 'feature/test', {
      repoId: 'repo-1',
      worktreeId: 'wt-1',
      force: true
    })
    store.getState().reconcileGitHubPRDetails(context)
    await vi.advanceTimersByTimeAsync(5_000)
    expect(getPRForBranchOutcomeMock).toHaveBeenCalledTimes(1)
    expect(store.getState().prDetailRecovery?.status).toEqual({ kind: 'waiting' })

    direct.resolve({ kind: 'no-pr', fetchedAt: Date.now() })
    await vi.advanceTimersByTimeAsync(15_000)
    expect(getPRForBranchOutcomeMock).toHaveBeenCalledTimes(2)
    expect(getPRForBranchOutcomeMock.mock.calls[1][4]).toBe(7)
  })

  it('lets a newer direct read win over a late recovery result', async () => {
    const recovery = Promise.withResolvers<unknown>()
    getPRForBranchOutcomeMock.mockReturnValueOnce(recovery.promise).mockResolvedValueOnce({
      kind: 'found',
      pr: makePR({ number: 9, headSha: 'h2' }),
      fetchedAt: Date.now()
    })
    const { store, cacheKey } = setup()
    store.getState().notePRDetailRecoveryPanelVisible(true)
    store.getState().reconcileGitHubPRDetails(context)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(store.getState().prDetailRecovery?.status).toEqual({ kind: 'admitted' })

    await store.getState().fetchPRForBranch('/repo', 'feature/test', {
      repoId: 'repo-1',
      worktreeId: 'wt-1',
      force: true,
      userRefresh: true
    })
    recovery.resolve({
      kind: 'found',
      pr: makePR({ number: 8, headSha: 'h2' }),
      fetchedAt: Date.now()
    })
    await vi.advanceTimersByTimeAsync(1_000)
    expect(store.getState().prCache[cacheKey]?.data?.number).toBe(9)
    expect(store.getState().prDetailRecovery?.status).toEqual({ kind: 'closed' })
  })
})
