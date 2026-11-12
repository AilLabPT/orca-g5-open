import { EventEmitter } from 'node:events'
import type { WebContents } from 'electron'
import { expect, it, vi } from 'vitest'
import { initializeBrowserRouteGuest } from './browser-route-guest-initialization'

it.each([
  ['about:blank', 'data:text/html,'],
  ['https://example.test/same', 'https://example.test/same']
])(
  'accepts the requested main-frame commit before load finishes: %s',
  async (url, committedUrl) => {
    const guest = new EventEmitter() as EventEmitter & {
      loadURL: ReturnType<typeof vi.fn>
      stop: ReturnType<typeof vi.fn>
    }
    const load = Promise.withResolvers<void>()
    guest.loadURL = vi.fn(() => load.promise)
    guest.stop = vi.fn()
    const initialized = initializeBrowserRouteGuest(
      guest as unknown as WebContents,
      url,
      new AbortController().signal,
      () => true
    )
    guest.emit('did-fail-load', {}, -2, 'failure', url, true)
    guest.emit('did-navigate-in-page', {}, 'https://subframe.test/', false)
    guest.emit('did-navigate', {}, url)
    await expect(initialized).resolves.toBe(committedUrl)
    load.reject(new Error('later JS redirect aborted the full load'))
    await Promise.resolve()
    expect(guest.eventNames()).toEqual([])
  }
)

it('uses a committed error destination and rejects cancellation or lost authority', async () => {
  const guest = new EventEmitter() as EventEmitter & {
    loadURL: ReturnType<typeof vi.fn>
    stop: ReturnType<typeof vi.fn>
  }
  guest.loadURL = vi.fn(() => new Promise<void>(() => {}))
  guest.stop = vi.fn()
  const controller = new AbortController()
  const error = initializeBrowserRouteGuest(
    guest as unknown as WebContents,
    'https://example.test/',
    controller.signal,
    () => true
  )
  guest.emit(
    'did-fail-provisional-load',
    {},
    -105,
    'DNS failed',
    'https://example.test/redirect',
    true
  )
  await expect(error).resolves.toBe('https://example.test/redirect')
  const cancelled = initializeBrowserRouteGuest(
    guest as unknown as WebContents,
    'about:blank',
    controller.signal,
    () => true
  )
  controller.abort()
  await expect(cancelled).rejects.toThrow('browser_client_page_initialization_failed')
  expect(guest.stop).toHaveBeenCalledOnce()
  let current = true
  const stale = initializeBrowserRouteGuest(
    guest as unknown as WebContents,
    'about:blank',
    new AbortController().signal,
    () => current
  )
  current = false
  guest.emit('did-navigate', {}, 'about:blank')
  await expect(stale).rejects.toThrow('browser_client_page_initialization_failed')
  expect(guest.eventNames()).toEqual([])
})
