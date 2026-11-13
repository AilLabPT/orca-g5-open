// @vitest-environment happy-dom
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { refreshProviderAccountLists, useProviderAccountList } from './use-provider-account-list'
import {
  emptyCodexAccountsState,
  type ProviderAccountsSnapshot
} from '@/runtime/provider-accounts/observations/runtime-provider-accounts-client'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

// Real hook and real snapshot client; only the host stream is a stand-in answered by hand.
function setup(environmentId: string) {
  const streams: { send: (snapshot: ProviderAccountsSnapshot) => void }[] = []
  vi.stubGlobal('api', {
    runtimeEnvironments: {
      subscribe: async (_args: unknown, callbacks: { onResponse: (response: unknown) => void }) => {
        streams.push({
          send: (snapshot) =>
            callbacks.onResponse({ ok: true, result: { type: 'snapshot', snapshot } })
        })
        return { unsubscribe: () => {} }
      }
    }
  })
  const transport = { streams }
  const target = { kind: 'environment', environmentId } as const
  const mount = () =>
    renderHook(() => useProviderAccountList('codex', target, '', emptyCodexAccountsState()))
  const withActive = (activeAccountId: string): ProviderAccountsSnapshot => ({
    claude: { accounts: [], activeAccountId: null },
    codex: { accounts: [], activeAccountId },
    rateLimits: null
  })
  return { transport, target, mount, withActive }
}

it.each(['before', 'after'] as const)(
  'keeps a selection result when an earlier shared read resolves %s a fresh read',
  async (order) => {
    const { transport, mount, withActive } = setup(`selection-${order}`)
    const { result } = mount()
    await act(async () => {})
    const staleRead = transport.streams[0]
    act(() => result.current.setAccounts(withActive('selected').codex))

    const reload = result.current.loadAccounts()
    await act(async () => {})
    expect(transport.streams).toHaveLength(2)
    if (order === 'before') {
      await act(async () => staleRead.send(withActive('stale')))
      expect(result.current.accounts.activeAccountId).toBe('selected')
    }
    // The retired request settling must not evict the newer one from sharing.
    const sharedReload = result.current.loadAccounts()
    await act(async () => {})
    expect(transport.streams).toHaveLength(2)
    await act(async () => {
      transport.streams[1].send(withActive('selected'))
      await Promise.all([reload, sharedReload])
    })
    if (order === 'after') {
      await act(async () => staleRead.send(withActive('stale')))
    }
    expect(result.current.accounts.activeAccountId).toBe('selected')
    expect(result.current.accountsLoaded).toBe(true)
  }
)

it.each(['before', 'after'] as const)(
  'answers an uncertain owner reopen with a read issued after it when the older read resolves %s',
  async (order) => {
    const { transport, target, mount, withActive } = setup(`reopen-${order}`)
    const { result } = mount()
    await act(async () => transport.streams[0].send(withActive('initial')))
    act(() => refreshProviderAccountLists(target, 'codex', 'unknown'))
    await act(async () => {})
    expect(transport.streams).toHaveLength(2)
    const olderRead = transport.streams[1]
    // The host applies the change here, after the older read was issued.
    act(() => result.current.reloadUncertainAccountsOnOpen())
    await act(async () => {})
    expect(transport.streams).toHaveLength(3)
    // A read issued after the reopen is as fresh as it, so it shares the request.
    const follower = result.current.loadAccounts()
    await act(async () => {})
    expect(transport.streams).toHaveLength(3)
    if (order === 'before') {
      await act(async () => olderRead.send(withActive('before-change')))
      expect(result.current.accounts.activeAccountId).toBe('initial')
    }
    await act(async () => {
      transport.streams[2].send(withActive('after-change'))
      await follower
    })
    if (order === 'after') {
      await act(async () => olderRead.send(withActive('before-change')))
    }
    expect(result.current.accounts.activeAccountId).toBe('after-change')
  }
)

it('does not answer a list mounted for an uncertain owner with a read issued before it', async () => {
  const { transport, target, mount, withActive } = setup('mount')
  mount()
  await act(async () => {})
  act(() => refreshProviderAccountLists(target, 'codex', 'unknown'))
  await act(async () => {})
  expect(transport.streams).toHaveLength(2)
  const returned = mount()
  await act(async () => {})
  expect(transport.streams).toHaveLength(3)
  await act(async () => transport.streams[1].send(withActive('before-change')))
  await act(async () => transport.streams[2].send(withActive('after-change')))
  expect(returned.result.current.accounts.activeAccountId).toBe('after-change')
})

it.each(['pending', 'answered'] as const)(
  'reads once for an uncertain owner menu mount and its open while the mount read is %s, and again on reopen',
  async (mountRead) => {
    const { transport, target, mount, withActive } = setup(`gesture-${mountRead}`)
    refreshProviderAccountLists(target, 'codex', 'unknown')
    const { result } = mount()
    await act(async () => {})
    if (mountRead === 'answered') {
      await act(async () => transport.streams[0].send(withActive('first-open')))
    }
    act(() => result.current.reloadUncertainAccountsOnOpen())
    await act(async () => {})
    expect(transport.streams).toHaveLength(1)
    await act(async () => transport.streams[0].send(withActive('first-open')))
    expect(result.current.accounts.activeAccountId).toBe('first-open')

    // A read still pending from before the close may predate a change that applied since.
    const pendingAcrossClose = result.current.loadAccounts()
    await act(async () => {})
    expect(transport.streams).toHaveLength(2)
    act(() => result.current.endUncertainAccountsRead())
    act(() => result.current.reloadUncertainAccountsOnOpen())
    await act(async () => {})
    expect(transport.streams).toHaveLength(3)
    await act(async () => {
      transport.streams[1].send(withActive('before-change'))
      await pendingAcrossClose
    })
    await act(async () => transport.streams[2].send(withActive('after-change')))
    expect(result.current.accounts.activeAccountId).toBe('after-change')
  }
)
