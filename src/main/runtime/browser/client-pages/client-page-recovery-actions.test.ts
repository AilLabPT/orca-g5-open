import { expect, it, vi } from 'vitest'
import { createRecoveryLoop } from './client-page-recovery-loop-test-harness'
import { retireRuntimeBrowserClientPage } from './browser-client-page-close'

const WORKSPACE = 'repo-1::/tmp/worktree-a'
type Harness = ReturnType<typeof createRecoveryLoop>
async function action(h: Harness, type: 'stop' | 'navigate', url?: string) {
  const page = h.pages.getPage('slow')!
  const responses: { ok: boolean; result?: unknown; error?: unknown }[] = []
  await h.rpc.dispatchStreaming(
    {
      id: 'action',
      authToken: 'test',
      method: 'browser.clientPage.initializationAction',
      params: {
        worktree: `id:${WORKSPACE}`,
        page: 'slow',
        expectedPlacement: page.placement,
        action: type === 'stop' ? { type } : { type, url }
      }
    },
    (text) => responses.push(JSON.parse(text)),
    h.caller()
  )
  expect(responses).toHaveLength(1)
  return responses[0]
}

it('accepts missing-guest Stop and Retry, supersedes a pending agent goto, and honors intentional blank', async () => {
  const h = createRecoveryLoop(['slow', 'fast'])
  const navigating = h.hold('slow')
  try {
    h.attach()
    await navigating
    const next = h.hold('next')
    const goto = h.hostRuntime.routeClientHostedBrowserRpc(
      'browser.goto',
      {
        page: 'slow',
        url: 'https://example.internal/next',
        expectUrl: 'https://example.internal/slow'
      },
      { kind: 'local-cli' }
    )
    const cancelled = expect(goto).rejects.toThrow('initialization_cancelled')
    await next
    expect(h.pages.getPage('slow')?.url).toBe('https://example.internal/slow')
    const stopped = await action(h, 'stop')
    expect(stopped).toMatchObject({ ok: true })
    await cancelled
    await vi.waitFor(() =>
      expect(h.executor.snapshotPageInventory().map((p) => p.browserPageId)).toEqual(['fast'])
    )
    expect(
      h.hostRuntime
        .snapshotForClient(WORKSPACE, 'device-a')
        .tabs.find((t) => t.type === 'browser' && t.browserPageId === 'slow')
    ).toMatchObject({
      initializationState: 'stopped',
      loading: false,
      url: 'https://example.internal/slow'
    })
    const retried = h.hold('retry')
    expect((await action(h, 'navigate', 'https://example.internal/retry')).ok).toBe(true)
    await retried
    expect(h.pages.getPage('slow')?.url).toBe('https://example.internal/retry')
    expect(
      h.profile.session.clientHostedBrowserPagesByWorktree?.[WORKSPACE]?.find(
        (p) => p.browserPageId === 'slow'
      )
    ).not.toHaveProperty('initializationState')
    const blank = await action(h, 'navigate', 'about:blank')
    expect(blank.ok).toBe(true)
    await h.published('slow')
    expect(h.pages.getPage('slow')?.url).toBe('data:text/html,')
    expect(
      h.authority.clientPageInitializations.status('slow', h.pages.getPage('slow')!.placement)
    ).toBeUndefined()
    expect(h.errors).toEqual([])
  } finally {
    await h.close()
  }
})

it('follows the same row through commit while the workspace resolver is awaited and rejects a closed owner', async () => {
  const h = createRecoveryLoop(['slow'])
  const navigating = h.hold('slow')
  try {
    h.attach()
    await navigating
    const resolving = Promise.withResolvers<void>()
    const resolved = Promise.withResolvers<void>()
    h.hooks.beforeWorkspace = async () => {
      resolving.resolve()
      await resolved.promise
    }
    const stop = action(h, 'stop')
    await resolving.promise
    h.release('slow')
    await h.published('slow')
    resolved.resolve()
    expect(await stop).toMatchObject({ ok: true })
    expect(h.commands.findLast((c) => c.command.type === 'automation')?.command).toMatchObject({
      method: 'browser.eval',
      params: { expression: 'window.stop()' },
      agent: false
    })
    h.hooks.beforeWorkspace = undefined
    // A second held resolver cannot cross logical close and act on the removed page.
    const waiting = Promise.withResolvers<void>()
    const done = Promise.withResolvers<void>()
    h.hooks.beforeWorkspace = async () => {
      waiting.resolve()
      await done.promise
    }
    const stale = action(h, 'navigate', 'https://example.internal/stale')
    await waiting.promise
    await retireRuntimeBrowserClientPage(
      {
        getBrowserHostLeaseRegistry: () => h.authority,
        getRuntimeBrowserPageRegistry: () => h.pages,
        notifyHeadlessBrowserSessionTabsChanged: (id) =>
          h.hostRuntime.notifyMobileSessionTabsChanged(id),
        resolveBrowserWorkspace: async () => ({ id: WORKSPACE })
      },
      h.pages.getPage('slow')!
    )
    const commands = h.commands.length
    done.resolve()
    expect((await stale).ok).toBe(false)
    expect(h.commands).toHaveLength(commands)
    expect(h.pages.getPage('slow')).toBeUndefined()
  } finally {
    await h.close()
  }
})

it('acknowledges committed Navigate without waiting for its full load', async () => {
  const h = createRecoveryLoop(['slow'])
  const started = h.hold('slow')
  const resolving = Promise.withResolvers<void>()
  const resolved = Promise.withResolvers<void>()
  try {
    h.attach()
    await started
    h.hooks.beforeWorkspace = async () => {
      resolving.resolve()
      await resolved.promise
    }
    const accepted = action(h, 'navigate', 'https://example.internal/held-full-load')
    await resolving.promise
    h.release('slow')
    await h.published('slow')
    const completedBefore = h.results.filter((r) => r.type === 'navigate').length
    const loading = h.hold('held-full-load')
    resolved.resolve()
    expect(await accepted).toMatchObject({ ok: true })
    await loading
    expect(h.pages.getPage('slow')?.url).toBe('https://example.internal/held-full-load')
    expect(h.results.filter((r) => r.type === 'navigate')).toHaveLength(completedBefore)
    h.release('held-full-load')
  } finally {
    resolved.resolve()
    await h.close()
  }
})

it('rejects superseded goto promptly while its native cleanup is held, and preserves clean Stop through same-lease reconnect', async () => {
  const h = createRecoveryLoop(['slow', 'unfinished'])
  const initial = h.hold('slow')
  const unfinished = h.hold('unfinished')
  try {
    const first = h.attach()
    await Promise.all([initial, unfinished])
    expect(
      h.hostRuntime.snapshotForClient(WORKSPACE, 'device-a').clientHostedPagesUnreconciled
    ).toBe(true)
    const following = h.hold('next')
    const goto = h.hostRuntime.routeClientHostedBrowserRpc(
      'browser.goto',
      {
        page: 'slow',
        url: 'https://example.internal/next'
      },
      { kind: 'local-cli' }
    )
    const rejected = expect(goto).rejects.toThrow('initialization_cancelled')
    await following
    const cleanup = h.holdRetirement('slow')
    expect(await action(h, 'stop')).toMatchObject({ ok: true })
    await rejected
    await cleanup.started
    expect(h.executor.snapshotPageInventory().some((p) => p.browserPageId === 'slow')).toBe(true)
    const commandCount = h.commands.filter(
      (c) => c.browserPageId === 'slow' && c.command.type === 'createPage'
    ).length
    cleanup.release()
    await vi.waitFor(() =>
      expect(h.executor.snapshotPageInventory().some((p) => p.browserPageId === 'slow')).toBe(false)
    )
    const reattached = h.attach()
    first.abort()
    await first.completion
    await vi.waitFor(() => expect(h.authority.select('client-a').connectionId).toBe('connection-2'))
    expect(
      h.authority.clientPageInitializations.status('slow', h.pages.getPage('slow')!.placement)
    ).toBe('stopped')
    expect(
      h.commands.filter((c) => c.browserPageId === 'slow' && c.command.type === 'createPage')
    ).toHaveLength(commandCount)
    h.release('unfinished')
    await h.published('unfinished')
    await vi.waitFor(() => expect(h.snapshots.some((s) => s.reconciled)).toBe(true))
    expect(
      h.hostRuntime.snapshotForClient(WORKSPACE, 'device-a').clientHostedPagesUnreconciled
    ).toBeUndefined()
    expect(await action(h, 'navigate', 'about:blank')).toMatchObject({ ok: true })
    await h.published('slow')
    expect(h.pages.getPage('slow')?.url).toBe('data:text/html,')
    reattached.abort()
    await reattached.completion
  } finally {
    await h.close()
  }
})
