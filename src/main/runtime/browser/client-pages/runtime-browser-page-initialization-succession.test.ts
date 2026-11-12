import { createRecoveryPeer } from './client-page-recovery-peer-test-harness'
import { expect, it, vi } from 'vitest'
import { createRecoveryLoop } from './client-page-recovery-loop-test-harness'
import { retireRuntimeBrowserClientPage } from './browser-client-page-close'
import {
  buildPersistedClientHostedBrowserPages,
  RESTORED_CLIENT_HOSTED_BROWSER_PLACEMENT
} from './client-hosted-browser-page-persistence'

it('a new attach owns the successor while exact prior cleanup is still joining', async () => {
  const h = createRecoveryLoop(['slow', 'fast'])
  const started = h.hold('slow')
  const first = h.attach()
  try {
    await started
    await h.published('fast')
    const retirement = h.holdRetirement('slow')
    first.disconnect()
    const next = h.attach()
    await retirement.started
    first.abort()
    await first.completion
    expect(h.pages.getPage('slow')?.url).toBe('https://example.internal/slow')
    expect(h.pages.getPage('slow')?.placement.pageHostGeneration).toBe(0)
    expect(h.pages.getPage('fast')?.placement.pageHostGeneration).toBeGreaterThan(0)
    h.release('slow')
    retirement.release()
    await h.published('slow')
    expect(h.pages.getPage('slow')?.url).toBe('https://example.internal/slow')
    expect(h.authority.getClientPageExecutionHostKey('slow')).toBe('execution-host-a')
    expect(
      h.results
        .filter((result) => result.id === 'slow')
        .map((result) => [result.type, result.status])
    ).toContainEqual(['closePage', 'completed'])
    expect(h.errors).toEqual([])
    next.abort()
    await next.completion
  } finally {
    await h.close()
  }
})

it.each(['client-a', 'replacement-client'])(
  'a fully retired ledger recovers its saved continuation on %s',
  async (hostId) => {
    const h = createRecoveryLoop(['slow'])
    try {
      let current = h.attach()
      await h.published('slow')
      for (let round = 0; round < 3; round += 1) {
        h.fence()
        current.abort()
        await current.completion
        await h.restartClient()
        const started = h.hold('slow')
        current = h.attach({ inventory: [] })
        await started
        const saved = h.pages.getPage('slow')!
        expect(saved.placement.pageHostGeneration).toBeGreaterThan(0)
        h.fence()
        current.abort()
        await current.completion
        await h.restartClient()
        h.release('slow')
        current = h.attach({ hostId, inventory: [] })
        await vi.waitFor(() =>
          expect(h.authority.getPlacement('slow')).toMatchObject({
            kind: 'client',
            browserHostClientId: hostId
          })
        )
        expect(h.pages.getPage('slow')?.url).toBe('https://example.internal/slow')
        expect(h.executor.snapshotPageInventory()).toHaveLength(1)
        expect(h.authority.getClientPageExecutionHostKey('slow')).toBe('execution-host-a')
      }
      await retireRuntimeBrowserClientPage(
        {
          getBrowserHostLeaseRegistry: () => h.authority,
          notifyHeadlessBrowserSessionTabsChanged: (id) =>
            h.hostRuntime.notifyMobileSessionTabsChanged(id),
          getRuntimeBrowserPageRegistry: () => h.pages,
          resolveBrowserWorkspace: async () => ({ id: 'workspace' })
        },
        h.pages.getPage('slow')!
      )
      expect(h.executor.snapshotPageInventory()).toEqual([])
      expect(buildPersistedClientHostedBrowserPages(h.pages.listPages(), 100)).toEqual([])
      current.abort()
      await current.completion
      expect(h.errors).toEqual([])
    } finally {
      await h.close()
    }
  }
)

it('full retirement preserves another live scope successor and an unrelated host', async () => {
  const h = createRecoveryLoop(['slow'])
  const successor = createRecoveryPeer(h.hostRuntime, 'successor-host')
  const unrelated = createRecoveryPeer(h.hostRuntime, 'unrelated-host', 'device-b')
  try {
    h.pages.publishClientPage({
      browserPageId: 'unrelated',
      workspaceId: 'repo-1::/tmp/worktree-a',
      browserProfileId: 'profile-a',
      executionHostKey: 'old-key',
      placement: RESTORED_CLIENT_HOSTED_BROWSER_PLACEMENT,
      pairedDeviceId: 'device-b',
      url: 'https://example.internal/unrelated',
      loading: false,
      active: false
    })
    unrelated.attach()
    await h.published('unrelated')
    const unrelatedPlacement = h.pages.getPage('unrelated')!.placement
    const unrelatedCommands = unrelated.commands.length
    const navigating = h.hold('slow')
    const first = h.attach()
    await navigating
    const retirement = h.holdRetirement('slow')
    const successorNavigation = successor.hold('slow')
    successor.attach()
    await retirement.started
    h.fence()
    await successorNavigation
    first.abort()
    await first.completion
    successor.release('slow')
    await h.published('slow')
    expect(h.pages.getPage('slow')?.placement.browserHostClientId).toBe('successor-host')
    expect(h.pages.getPage('unrelated')?.placement).toEqual(unrelatedPlacement)
    expect(unrelated.commands).toHaveLength(unrelatedCommands)
    expect(unrelated.executor.snapshotPageInventory()).toHaveLength(1)
    retirement.release()
    h.release('slow')
    await vi.waitFor(() => expect(h.executor.snapshotPageInventory()).toEqual([]))
    expect(h.pages.getPage('slow')?.placement.browserHostClientId).toBe('successor-host')
    expect(successor.executor.snapshotPageInventory()).toHaveLength(1)
    expect(successor.errors).toEqual([])
    expect(unrelated.errors).toEqual([])
  } finally {
    h.release('slow')
    await h.close()
    await successor.close()
    await unrelated.close()
  }
})

it('consumes a retired modern continuation when a legacy recovery replaces its row', async () => {
  const h = createRecoveryLoop(['slow'])
  try {
    const started = h.hold('slow')
    const first = h.attach()
    await started
    h.fence()
    first.abort()
    await first.completion
    await h.restartClient()
    h.release('slow')
    const legacy = h.attach({ modern: false, inventory: [] })
    await h.published('slow')
    const legacyPlacement = h.pages.getPage('slow')!.placement
    legacy.abort()
    await legacy.completion
    await h.restartClient()
    const modern = h.attach({ inventory: [] })
    await vi.waitFor(() => {
      const live = h.authority.getPlacement('slow')
      expect(live?.kind === 'client' ? live.pageHostGeneration : undefined).toBeGreaterThan(0)
      expect(live).not.toEqual(legacyPlacement)
      expect(h.pages.getPage('slow')?.placement).toEqual(live)
    })
    expect(h.pages.getPage('slow')?.url).toBe('https://example.internal/slow')
    expect(h.executor.snapshotPageInventory()).toHaveLength(1)
    modern.abort()
    await modern.completion
  } finally {
    await h.close()
  }
})
