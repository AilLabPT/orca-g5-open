import { expect, it, vi } from 'vitest'
import { createRecoveryLoop } from './client-page-recovery-loop-test-harness'
import { RESTORED_CLIENT_HOSTED_BROWSER_PLACEMENT } from './client-hosted-browser-page-persistence'
import { BROWSER_CLIENT_HOST_PAGE_INVENTORY_URL_MAX_LENGTH } from '../../../../shared/browser/client-hosting/browser-client-host-protocol'
import type { RuntimeMobileSessionTabsResult } from '../../../../shared/runtime-session-contracts'

const WORKSPACE = 'repo-1::/tmp/worktree-a'

it.each([false, true])(
  'publishes cleared current holds to stale workspaces after cleanup=%s',
  async (failCommit) => {
    const h = createRecoveryLoop([])
    const frames: RuntimeMobileSessionTabsResult[] = []
    const unsubscribe = h.hostRuntime.onMobileSessionTabsChanged(
      (frame) => frames.push(frame),
      'device-a',
      'mobile'
    )
    const staleWorkspace = 'repo-1::/tmp/stale'
    try {
      const stale = h.pages.publishClientPage({
        browserPageId: 'stale',
        workspaceId: staleWorkspace,
        browserProfileId: 'profile-a',
        pairedDeviceId: 'device-a',
        executionHostKey: 'old-key',
        placement: RESTORED_CLIENT_HOSTED_BROWSER_PLACEMENT,
        url: 'https://example.internal/stale',
        loading: false,
        active: false
      })
      h.hostRuntime.notifyMobileSessionTabsChanged(staleWorkspace)
      h.pages.retirePage('stale', stale.placement)
      await h.seedNative(['slow'])
      const started = h.hold('slow')
      h.hooks.failCommit = failCommit
      const first = h.attach()
      if (!failCommit) {
        await started
        expect(
          frames.findLast((frame) => frame.worktree === WORKSPACE)?.clientHostedPagesUnreconciled
        ).toBe(true)
        const retirement = h.holdRetirement('slow')
        const next = h.attach()
        await retirement.started
        first.abort()
        await first.completion
        expect(
          frames.findLast((frame) => frame.worktree === WORKSPACE)?.clientHostedPagesUnreconciled
        ).toBe(true)
        retirement.release()
        h.release('slow')
        await h.published('slow')
        await vi.waitFor(() =>
          expect(
            frames.findLast((frame) => frame.worktree === staleWorkspace)
              ?.clientHostedPagesUnreconciled
          ).toBeUndefined()
        )
        next.abort()
        await next.completion
      } else {
        await vi.waitFor(() =>
          expect(h.snapshots.some((snapshot) => snapshot.reconciled)).toBe(true)
        )
        expect(h.pages.getPage('slow')?.url).toBe('https://example.internal/slow')
        expect(h.pages.getPage('slow')?.placement.pageHostGeneration).toBe(0)
        expect(
          frames.findLast((frame) => frame.worktree === WORKSPACE)?.clientHostedPagesUnreconciled
        ).toBeUndefined()
        expect(
          frames.findLast((frame) => frame.worktree === staleWorkspace)
            ?.clientHostedPagesUnreconciled
        ).toBeUndefined()
        first.abort()
        await first.completion
      }
    } finally {
      unsubscribe()
      await h.close()
    }
  }
)

it('keeps a modern active exact guest when actual inventory trimming omits its address', async () => {
  const h = createRecoveryLoop(['page'])
  try {
    const first = h.attach()
    await h.published('page')
    const page = h.pages.getPage('page')!
    h.executor.recordPublishedPageUrl({
      ...page.placement,
      browserPageId: 'page',
      revision: 1,
      url: `https://example.internal/${'x'.repeat(BROWSER_CLIENT_HOST_PAGE_INVENTORY_URL_MAX_LENGTH)}`,
      title: 'Long address',
      loading: false,
      canGoBack: false,
      canGoForward: false
    })
    expect(h.executor.snapshotPageInventory()[0]).toMatchObject({ state: 'active' })
    expect(h.executor.snapshotPageInventory()[0]?.currentUrl).toBeUndefined()
    h.commands.length = 0
    const next = h.attach()
    await first.completion
    expect(h.commands).toEqual([])
    expect(h.executor.hasPage('page', page.placement.pageHostGeneration)).toBe(true)
    next.abort()
    await next.completion
  } finally {
    await h.close()
  }
})

it('retires a late legacy replacement after its captured logical row closes', async () => {
  const h = createRecoveryLoop(['slow'])
  try {
    await h.seedNative(['slow'])
    const started = h.hold('slow')
    const attached = h.attach({ modern: false })
    await started
    const page = h.pages.getPage('slow')!
    h.pages.retirePage('slow', page.placement)
    h.release('slow')
    await vi.waitFor(() => expect(h.executor.snapshotPageInventory()).toEqual([]))
    expect(h.authority.getPlacement('slow')).toBeUndefined()
    expect(h.authority.getClientPageExecutionHostKey('slow')).toBeUndefined()
    expect(h.commands.map((event) => event.command.type)).toContain('restorePage')
    expect(
      h.commands.some(
        (event) => event.command.type === 'createPage' && event.command.initialUrl !== undefined
      )
    ).toBe(false)
    attached.abort()
    await attached.completion
  } finally {
    await h.close()
  }
})
