// @vitest-environment happy-dom
import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, expect, it } from 'vitest'
import {
  createSessionTabsTabDeltaEncoder,
  createSessionTabsTabDeltaDecoder
} from '../../../../../shared/session-tabs-tab-delta'
import { SESSION_TABS_TAB_DELTA_RUNTIME_CAPABILITY } from '../../../../../shared/session-tabs-runtime-capabilities'
import { buildPersistedBrowserPagesByWorkspace } from '@/lib/workspace/persistence/workspace-session-browser-tabs'
import { useAppStore } from '@/store'
import type { RuntimeMobileSessionTabsResult } from '../../../../../shared/runtime-session-contracts'
import { applyWebRuntimeSessionTabsAnswer } from '@/runtime/web-session-tabs-sync/inventory/web-runtime-session-snapshot'
import { installBrowserInitializationPresentationLifetime } from '@/runtime/web-session-tabs-sync/browser-initialization-presentation'
import { listRemoteRuntimeSessionTabsDeduped } from '@/runtime/web-session-tabs-sync/inventory/remote-runtime-session-tabs-inflight'
import { nextReceivedSessionTabsFrame } from '@/runtime/web-session-tabs-sync/state'
import { replaceRuntimeEnvironmentRevisions } from '@/runtime/rpc/environment-revisions/runtime-environment-revision'
import { resetBrowserClientHostIdForTests } from '@/runtime/browser/client-hosting/browser-client-host-identity'
import {
  ENV,
  WT
} from '@/runtime/web-session-tabs-sync/hydration/testing/host-session-mirror-frame-fixtures'
import {
  installFrameOrderingHarness,
  runtimeCall
} from '@/runtime/web-session-tabs-sync/hydration/testing/host-session-mirror-frame-ordering-test-harness'
import { useClientHostedPageUrlSubmission } from './use-client-hosted-page-url-submission'
import { routeBrowserPageInitializationAction } from './browser-page-initialization-action'
import {
  clearBrowserPageDeferredNavigation,
  consumeBrowserPageDeferredNavigation,
  deferBrowserPageNavigation,
  hasBrowserPageInitializationAction
} from './browser-page-deferred-navigation'

installFrameOrderingHarness()
const PLACEMENT = {
  kind: 'client' as const,
  browserHostClientId: 'host-a',
  browserHostGeneration: 1,
  pageHostGeneration: 0
}
const WS = 'browser-workspace-a'
function snapshot(
  url: string,
  version: number,
  state: 'pending' | 'stopped' | null = 'pending'
): RuntimeMobileSessionTabsResult {
  return {
    worktree: WT,
    publicationEpoch: 'epoch-a',
    snapshotVersion: version,
    activeGroupId: 'host-group-a',
    activeTabId: 'tab-a',
    activeTabType: 'browser',
    tabs: [
      {
        type: 'browser',
        id: 'tab-a',
        title: url,
        browserWorkspaceId: WS,
        browserPageId: 'page-a',
        placement: PLACEMENT,
        url,
        initializationState: state ?? undefined,
        loading: state === 'pending',
        canGoBack: false,
        canGoForward: false,
        isActive: true
      }
    ]
  }
}
const response = (result: RuntimeMobileSessionTabsResult) => ({
  id: 'answer',
  ok: true,
  result,
  _meta: { runtimeId: 'runtime-a' }
})
async function publish(
  frame: RuntimeMobileSessionTabsResult,
  receivedFrame = nextReceivedSessionTabsFrame()
) {
  await act(async () => {
    await applyWebRuntimeSessionTabsAnswer(ENV, WT, {
      snapshot: frame,
      receivedFrame,
      runtimeId: 'runtime-a'
    })
  })
}
function page() {
  return useAppStore.getState().browserPagesByWorkspace[WS]?.[0]
}
function submitter() {
  const requests: Promise<void>[] = []
  const hook = renderHook(() =>
    useClientHostedPageUrlSubmission({
      browserTabId: 'page-a',
      worktreeId: WT,
      webviewRef: { current: null },
      activeLoadFailureRef: { current: null },
      setAddressBarValue: () => {},
      onSetUrl: (_id, url) =>
        useAppStore.setState((s) => ({
          browserPagesByWorkspace: {
            ...s.browserPagesByWorkspace,
            [WS]: [{ ...s.browserPagesByWorkspace[WS][0], url }]
          }
        })),
      onUpdatePageState: () => {},
      onInitializationAction: (action) => {
        requests.push(
          routeBrowserPageInitializationAction({
            pageId: 'page-a',
            workspaceId: WS,
            worktreeId: WT,
            environmentId: ENV,
            placement: PLACEMENT,
            action
          })
        )
      }
    })
  )
  return { submit: (url: string) => act(() => hook.result.current(url)), requests }
}

let stopLifetime = () => {}
let diagnostics: Parameters<typeof window.api.runtimeEnvironments.onSharedControlDiagnostics>[0]
afterEach(() => stopLifetime())
beforeEach(async () => {
  Object.assign(window.api.runtimeEnvironments, {
    onSharedControlDiagnostics: (callback: typeof diagnostics) => {
      diagnostics = callback
      return () => {}
    }
  })
  stopLifetime = installBrowserInitializationPresentationLifetime()
  resetBrowserClientHostIdForTests()
  clearBrowserPageDeferredNavigation('page-a')
  Object.assign(window.api, { browser: { readClientHostId: () => 'host-a' } })
  useAppStore.setState({ tabsByWorktree: {}, terminalLayoutsByTabId: {}, ptyIdsByTabId: {} })
  await publish(snapshot('https://example.internal/S', 1))
})

it('keeps the typed address through an older frame, settles the action reply and adopts the requested commit', async () => {
  const answer = Promise.withResolvers<unknown>()
  runtimeCall.mockImplementation(() => answer.promise)
  const h = submitter()
  deferBrowserPageNavigation('page-a', 'https://example.internal/obsolete')
  h.submit('https://example.internal/F')
  expect(consumeBrowserPageDeferredNavigation('page-a')).toBeNull()
  await publish(snapshot('https://example.internal/S', 2))
  expect(page()?.url).toBe('https://example.internal/F')
  answer.resolve(response(snapshot('https://example.internal/F', 3)))
  await act(async () => {
    await h.requests[0]
  })
  expect(hasBrowserPageInitializationAction('page-a')).toBe(false)
  expect(page()?.url).toBe('https://example.internal/F')
  await publish(snapshot('https://example.internal/redirected', 4, null))
  expect(page()?.url).toBe('https://example.internal/redirected')
  expect(
    useAppStore.getState().remoteBrowserPageHandlesByPageId['page-a']?.initializationPresentation
      ?.disposition
  ).toBeUndefined()
  expect(runtimeCall).toHaveBeenCalledTimes(1)
})

it('keeps a newer local submission when the first reply arrives late', async () => {
  const first = Promise.withResolvers<unknown>(),
    second = Promise.withResolvers<unknown>()
  runtimeCall
    .mockImplementationOnce(() => first.promise)
    .mockImplementationOnce(() => second.promise)
  const h = submitter()
  h.submit('https://example.internal/F')
  h.submit('https://example.internal/G')
  first.resolve(response(snapshot('https://example.internal/F', 2)))
  await act(async () => {
    await h.requests[0]
  })
  expect(page()?.url).toBe('https://example.internal/G')
  expect(hasBrowserPageInitializationAction('page-a')).toBe(true)
  second.resolve(response(snapshot('https://example.internal/G', 3)))
  await act(async () => {
    await h.requests[1]
  })
  expect(page()?.url).toBe('https://example.internal/G')
  expect(hasBrowserPageInitializationAction('page-a')).toBe(false)
  expect(runtimeCall).toHaveBeenCalledTimes(2)
})

it('accepts the current address in the action reply and rejects an older frame received before the action but applied after it', async () => {
  const oldReceipt = nextReceivedSessionTabsFrame()
  const answer = Promise.withResolvers<unknown>()
  runtimeCall.mockImplementation(() => answer.promise)
  const h = submitter()
  h.submit('https://example.internal/F')
  answer.resolve(response(snapshot('https://example.internal/H', 3)))
  await act(async () => {
    await h.requests[0]
  })
  expect(page()?.url).toBe('https://example.internal/H')
  await publish(snapshot('https://example.internal/S', 2), oldReceipt)
  expect(page()?.url).toBe('https://example.internal/H')
  expect(runtimeCall).toHaveBeenCalledTimes(1)
})

it('discards an action reply after its runtime environment is retired', async () => {
  const answer = Promise.withResolvers<unknown>()
  runtimeCall.mockImplementation(() => answer.promise)
  const h = submitter()
  h.submit('https://example.internal/F')
  replaceRuntimeEnvironmentRevisions([])
  answer.resolve(response(snapshot('https://example.internal/H', 3)))
  await act(async () => {
    await h.requests[0]
  })
  expect(page()?.url).toBe('https://example.internal/F')
  expect(page()?.loadError).toBeNull()
  expect(runtimeCall).toHaveBeenCalledTimes(1)
  expect(hasBrowserPageInitializationAction('page-a')).toBe(false)
})

it('reconciles a newer remote address already received before the delayed action reply', async () => {
  const answer = Promise.withResolvers<unknown>()
  runtimeCall
    .mockImplementationOnce(() => answer.promise)
    .mockImplementation(async () => response(snapshot('https://example.internal/H', 3)))
  const h = submitter()
  h.submit('https://example.internal/F')
  await publish(snapshot('https://example.internal/H', 3))
  expect(page()?.url).toBe('https://example.internal/F')
  answer.resolve(response(snapshot('https://example.internal/F', 2)))
  await act(async () => {
    await h.requests[0]
  })
  expect(page()?.url).toBe('https://example.internal/H')
  expect(runtimeCall).toHaveBeenCalledTimes(2)
  expect(runtimeCall.mock.calls[1][0]).toMatchObject({ method: 'session.tabs.list' })
  await publish(snapshot('https://example.internal/S', 1))
  expect(page()?.url).toBe('https://example.internal/H')
})

it('clears a failed action with one current read and never revives a removed page', async () => {
  const answer = Promise.withResolvers<unknown>()
  runtimeCall
    .mockImplementationOnce(() => answer.promise)
    .mockImplementation(async () => response(snapshot('https://example.internal/S', 1)))
  const h = submitter()
  h.submit('https://example.internal/F')
  answer.reject(new Error('unavailable'))
  await act(async () => {
    await h.requests[0]
  })
  expect(page()?.loadError).toBeNull()
  expect(page()?.url).toBe('https://example.internal/S')
  expect(runtimeCall).toHaveBeenCalledTimes(2)
  const removed = Promise.withResolvers<unknown>()
  runtimeCall.mockImplementation(() => removed.promise)
  h.submit('https://example.internal/G')
  await publish({ ...snapshot('', 4), tabs: [] })
  removed.resolve(response(snapshot('https://example.internal/G', 3)))
  await act(async () => {
    await h.requests[1]
  })
  expect(page()).toBeUndefined()
  expect(runtimeCall).toHaveBeenCalledTimes(3)
  expect(hasBrowserPageInitializationAction('page-a')).toBe(false)
})

it('carries transient initialization through the actual delta codec, clears omission and excludes it from disk', async () => {
  const encoder = createSessionTabsTabDeltaEncoder([SESSION_TABS_TAB_DELTA_RUNTIME_CAPABILITY])
  const decoder = createSessionTabsTabDeltaDecoder()
  const first = snapshot('https://example.internal/S', 2)
  // Include an unchanged sibling so the production codec chooses its delta branch.
  const sibling = first.tabs[0]
  if (sibling.type !== 'browser') {
    throw new Error('browser_fixture_required')
  }
  first.tabs.push({
    ...sibling,
    id: 'tab-b',
    browserPageId: 'page-b',
    browserWorkspaceId: 'workspace-b'
  })
  const encoded = decoder.decode(
    JSON.parse(JSON.stringify(encoder.full({ ...first, type: 'snapshot' })))
  )
  expect(encoded.ok).toBe(true)
  const cleared = {
    ...first,
    snapshotVersion: 3,
    tabs: first.tabs.map((tab, index) =>
      index === 0 ? { ...tab, initializationState: undefined, loading: false } : tab
    )
  }
  const wire = encoder.update({ ...cleared, type: 'updated' })
  expect(wire).toHaveProperty('tabsDelta')
  const decoded = decoder.decode(JSON.parse(JSON.stringify(wire)))
  expect(decoded.ok).toBe(true)
  if (!decoded.ok) {
    throw new Error('fixture delta failed')
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: codec roundtrips the typed frame above; its public result stays unknown.
  await publish(decoded.result as RuntimeMobileSessionTabsResult)
  expect(
    useAppStore.getState().remoteBrowserPageHandlesByPageId['page-a']?.initializationPresentation
      ?.disposition
  ).toBeUndefined()
  await publish(snapshot('https://example.internal/S', 4, 'stopped'))
  expect(
    useAppStore.getState().remoteBrowserPageHandlesByPageId['page-a']?.initializationPresentation
      ?.disposition
  ).toBe('stopped')
  const state = useAppStore.getState()
  const saved = buildPersistedBrowserPagesByWorkspace(
    state.browserPagesByWorkspace,
    state.remoteBrowserPageHandlesByPageId,
    {}
  )
  expect(saved?.[WS]?.[0]).not.toHaveProperty('initializationState')
})

it('rejects old action and dispatched read across loss without changing fresh pending or its requested address', async () => {
  const oldAction = Promise.withResolvers<unknown>()
  runtimeCall.mockImplementation(() => oldAction.promise)
  const h = submitter()
  h.submit('https://example.internal/typed')
  const read = Promise.withResolvers<{
    snapshot: RuntimeMobileSessionTabsResult
    runtimeId: string
  }>()
  const dispatched = listRemoteRuntimeSessionTabsDeduped({
    environmentId: ENV,
    worktreeId: WT,
    load: () => read.promise
  })
  act(() =>
    diagnostics({
      environmentId: ENV,
      transportGeneration: 1,
      diagnostics: {
        state: 'closed',
        pendingRequestCount: 0,
        subscriptionCount: 1,
        reconnectAttempt: 0,
        lastConnectedAt: 1,
        lastClose: null,
        lastError: null
      }
    })
  )
  await publish(snapshot('https://example.internal/fresh', 4))
  oldAction.reject(new Error('transport closed'))
  read.resolve({
    snapshot: snapshot('https://example.internal/obsolete', 100, null),
    runtimeId: 'runtime-a'
  })
  await act(async () => {
    await h.requests[0]
    await applyWebRuntimeSessionTabsAnswer(ENV, WT, await dispatched)
  })
  expect(page()?.url).toBe('https://example.internal/fresh')
  expect(page()?.loadError).toBeNull()
  expect(
    useAppStore.getState().remoteBrowserPageHandlesByPageId['page-a']?.initializationPresentation
      ?.disposition
  ).toBe('pending')
  expect(runtimeCall).toHaveBeenCalledTimes(1)
  expect(hasBrowserPageInitializationAction('page-a')).toBe(false)
})

it('keeps cached pending revoked until a fresh equal-version replay is accepted', async () => {
  const cached = snapshot('https://example.internal/S', 2)
  await publish(cached)
  const emit = (state: 'closed' | 'ready') =>
    act(() =>
      diagnostics({
        environmentId: ENV,
        transportGeneration: 1,
        diagnostics: {
          state,
          pendingRequestCount: 0,
          subscriptionCount: 1,
          reconnectAttempt: 0,
          lastConnectedAt: 1,
          lastClose: null,
          lastError: null
        }
      })
    )
  emit('closed')
  emit('ready')
  await publish(cached)
  expect(
    useAppStore.getState().remoteBrowserPageHandlesByPageId['page-a']?.initializationPresentation
      ?.disposition
  ).toBe('unavailable')
  await act(async () => {
    await applyWebRuntimeSessionTabsAnswer(
      ENV,
      WT,
      {
        snapshot: snapshot('https://example.internal/S', 2),
        receivedFrame: nextReceivedSessionTabsFrame(),
        runtimeId: 'runtime-a'
      },
      { acceptCurrentSnapshot: true }
    )
  })
  expect(
    useAppStore.getState().remoteBrowserPageHandlesByPageId['page-a']?.initializationPresentation
      ?.disposition
  ).toBe('pending')
  expect(page()?.url).toBe('https://example.internal/S')
})

it.each([750, 7500])(
  'revokes %s affected pages in one publication while leaving another environment untouched',
  (count) => {
    const handle = useAppStore.getState().remoteBrowserPageHandlesByPageId['page-a']
    const handles = { ...useAppStore.getState().remoteBrowserPageHandlesByPageId }
    for (let i = 0; i < count; i++) {
      handles[`scale-${i}`] = { ...handle, remotePageId: `remote-${i}` }
    }
    const unrelated = { ...handle, environmentId: 'other-environment' }
    handles['unrelated-page'] = unrelated
    useAppStore.setState({ remoteBrowserPageHandlesByPageId: handles })
    const pages = useAppStore.getState().browserPagesByWorkspace
    let publications = 0
    const unsubscribe = useAppStore.subscribe(() => {
      publications++
    })
    const event = {
      environmentId: ENV,
      transportGeneration: 1,
      diagnostics: {
        state: 'closed' as const,
        pendingRequestCount: 0,
        subscriptionCount: 1,
        reconnectAttempt: 0,
        lastConnectedAt: 1,
        lastClose: null,
        lastError: null
      }
    }
    try {
      act(() => diagnostics(event))
      expect(publications).toBe(1)
      const next = useAppStore.getState()
      expect(next.browserPagesByWorkspace).toBe(pages)
      expect(next.remoteBrowserPageHandlesByPageId['unrelated-page']).toBe(unrelated)
      for (let i = 0; i < count; i++) {
        expect(
          next.remoteBrowserPageHandlesByPageId[`scale-${i}`].initializationPresentation
            ?.disposition
        ).toBe('unavailable')
      }
      act(() => diagnostics(event))
      expect(publications).toBe(1)
      stopLifetime()
      stopLifetime = () => {}
      act(() => diagnostics(event))
      expect(publications).toBe(1)
    } finally {
      unsubscribe()
    }
  }
)
