import { expect, it, vi } from 'vitest'
import { createRecoveryLoop } from './client-page-recovery-loop-test-harness'
import { retireRuntimeBrowserClientPage } from './browser-client-page-close'
import { buildPersistedClientHostedBrowserPages } from './client-hosted-browser-page-persistence'

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
