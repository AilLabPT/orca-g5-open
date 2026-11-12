import { expect, it, vi } from 'vitest'
import { createRecoveryLoop } from './client-page-recovery-loop-test-harness'
import { retireRuntimeBrowserClientPage } from './browser-client-page-close'

it('keeps an admitted exact close across earlier creation-result eviction', async () => {
  const h = createRecoveryLoop(['slow', 'fast', 'b', 'c', 'd', 'queued'], {
    maxCachedCommandResults: 6
  })
  try {
    const started = ['slow', 'b', 'c', 'd'].map((id) => h.hold(id))
    const attached = h.attach()
    await Promise.all(started)
    await h.published('fast')
    expect(h.commands.some((event) => event.browserPageId === 'queued')).toBe(false)
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
    await vi.waitFor(() =>
      expect(h.results.findLast((result) => result.id === 'slow')).toMatchObject({
        type: 'closePage',
        status: 'completed'
      })
    )
    expect(
      h.results
        .filter((result) => result.id === 'slow')
        .map((result) => [result.type, result.status])
    ).toEqual([
      ['createPage', 'completed'],
      ['navigate', 'failed'],
      ['closePage', 'completed']
    ])
    await h.published('queued')
    expect(h.authority.getClientPageExecutionHostKey('slow')).toBeUndefined()
    expect(h.authority.getClientPageExecutionHostKey('queued')).toBe('execution-host-a')
    expect(h.native.order.indexOf('retire-guest')).toBeLessThan(
      h.native.order.indexOf('release-session')
    )
    for (const id of ['b', 'c', 'd']) {
      h.release(id)
    }
    attached.abort()
    await attached.completion
  } finally {
    await h.close()
  }
})
