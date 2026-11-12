import { expect, it, vi } from 'vitest'
import { createRecoveryLoop } from './client-page-recovery-loop-test-harness'
import { retireRuntimeBrowserClientPage } from './browser-client-page-close'

it('a close deadline leaves native capacity charged until the real retirement joins', async () => {
  const h = createRecoveryLoop(['a', 'b', 'c', 'd', 'queued'])
  try {
    const started = ['a', 'b', 'c', 'd'].map((id) => h.hold(id))
    const attached = h.attach()
    await Promise.all(started)
    const retirement = h.holdRetirement('a')
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    await retireRuntimeBrowserClientPage(
      {
        getBrowserHostLeaseRegistry: () => h.authority,
        getRuntimeBrowserPageRegistry: () => h.pages,
        resolveBrowserWorkspace: async () => ({ id: 'workspace' })
      },
      h.pages.getPage('a')!
    )
    await retirement.started
    await vi.advanceTimersByTimeAsync(15_000)
    expect(h.pages.getPage('a')).toBeUndefined()
    expect(h.commands.some((event) => event.browserPageId === 'queued')).toBe(false)
    expect(h.executor.snapshotPageInventory().some((page) => page.browserPageId === 'a')).toBe(true)
    retirement.release()
    await h.published('queued')
    expect(h.executor.snapshotPageInventory().some((page) => page.browserPageId === 'a')).toBe(
      false
    )
    expect(h.authority.getClientPageExecutionHostKey('a')).toBeUndefined()
    expect(h.authority.getClientPageExecutionHostKey('queued')).toBe('execution-host-a')
    for (const id of ['b', 'c', 'd']) {
      h.release(id)
    }
    attached.abort()
    await attached.completion
  } finally {
    vi.useRealTimers()
    await h.close()
  }
})

it('an empty same-ledger inventory cannot forget a create waiting to reach its handler', async () => {
  const h = createRecoveryLoop(['slow'])
  const firstDelivery = Promise.withResolvers<void>()
  let held = false
  h.hooks.delivery = (event, dispatch) => {
    if (event.command.type === 'createPage' && !held) {
      held = true
      firstDelivery.resolve()
      return
    }
    dispatch()
  }
  try {
    const navigation = h.hold('slow')
    const mount = h.holdMount('slow')
    const retirement = h.holdRetirement('slow')
    const first = h.attach()
    await firstDelivery.promise
    expect(h.executor.snapshotPageInventory()).toEqual([])
    const next = h.attach({ inventory: [] })
    await mount.started
    first.abort()
    await first.completion
    mount.release()
    await retirement.started
    expect(
      new Set(
        h.commands
          .filter((event) => event.command.type === 'createPage')
          .map((event) => event.commandId)
      ).size
    ).toBe(1)
    expect(h.pages.getPage('slow')?.placement.pageHostGeneration).toBe(0)
    retirement.release()
    await navigation
    h.release('slow')
    await h.published('slow')
    expect(h.executor.snapshotPageInventory()).toHaveLength(1)
    expect(h.pages.getPage('slow')?.url).toBe('https://example.internal/slow')
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

it('an omitted inventory cannot certify a retired native target absent', async () => {
  const h = createRecoveryLoop(['slow'])
  try {
    const started = h.hold('slow')
    const first = h.attach()
    await started
    h.fence()
    first.abort()
    await first.completion
    await h.restartClient()
    h.commands.length = 0
    const unavailable = h.attach({ omitInventory: true })
    await Promise.resolve()
    expect(h.commands).toEqual([])
    expect(h.pages.getPage('slow')?.placement.pageHostGeneration).toBe(0)
    const next = h.attach({ inventory: [] })
    h.release('slow')
    await h.published('slow')
    expect(h.pages.getPage('slow')?.url).toBe('https://example.internal/slow')
    unavailable.abort()
    next.abort()
    await Promise.all([unavailable.completion, next.completion])
  } finally {
    await h.close()
  }
})
