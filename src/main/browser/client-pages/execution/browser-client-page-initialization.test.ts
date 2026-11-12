import { expect, it, vi } from 'vitest'
import { BrowserClientPageCommandExecutor } from './browser-client-page-command-executor'
import { BrowserClientHostCommandDispatcher } from '../../client-hosts/commands/browser-client-host-command-dispatcher'
import { createCommand, createHarness } from './browser-client-page-command-executor-test-harness'
import type { BrowserClientHostCommandEvent } from '../../../../shared/browser/client-hosting/browser-client-host-protocol'

const create = (): BrowserClientHostCommandEvent =>
  createCommand('createPage', {
    command: {
      type: 'createPage',
      browserProfileId: 'profile-a',
      executionHostKey: 'execution-host-a',
      initialUrl: 'https://example.internal/path'
    }
  })
const close = (sequence: number): BrowserClientHostCommandEvent => ({
  ...create(),
  commandSequence: sequence,
  commandId: `close-${sequence}`,
  command: { type: 'closePage', targetAuthority: create() }
})

it('keeps initialization inventory requested, then adopts the committed redirect without an ordinary URL overwrite', async () => {
  const { dependencies } = createHarness()
  const commit = Promise.withResolvers<string>()
  const executor = new BrowserClientPageCommandExecutor({
    ...dependencies,
    routeWebContents: {
      ...dependencies.routeWebContents,
      initializeGuest: vi.fn(() => commit.promise)
    }
  })
  const dispatcher = new BrowserClientHostCommandDispatcher({
    authority: create(),
    handler: (event, signal) => executor.handle(event, signal),
    cancelInitialization: (event) => executor.cancelInitialization(event)
  })
  await dispatcher.dispatch(create())
  expect(executor.snapshotPageInventory()[0]).toMatchObject({
    state: 'outcomeUnknown',
    currentUrl: 'https://example.internal/path'
  })
  const navigation = dispatcher.dispatch(createCommand('navigate'))
  commit.resolve('https://example.internal/final')
  await expect(navigation).resolves.toEqual({
    status: 'completed',
    value: 'https://example.internal/final'
  })
  expect(executor.snapshotPageInventory()[0]).toMatchObject({
    state: 'active',
    currentUrl: 'https://example.internal/final'
  })
  expect(dependencies.routeWebContents.navigateGuest).not.toHaveBeenCalled()
  await dispatcher.dispatch(close(3))
  expect(executor.snapshotPageInventory()).toEqual([])
  await dispatcher.close()
  await executor.close()
})

it.each(['create', 'gap', 'navigate'] as const)(
  'an exact terminal close cancels %s and stays ordered through cleanup',
  async (phase) => {
    const { dependencies, route, renderer } = createHarness()
    const mount = Promise.withResolvers<{ webContentsId: number }>()
    const navigating = Promise.withResolvers<void>()
    if (phase === 'create') {
      renderer.mountPage.mockImplementationOnce(() => mount.promise)
    }
    const executor = new BrowserClientPageCommandExecutor({
      ...dependencies,
      routeWebContents: {
        ...dependencies.routeWebContents,
        initializeGuest: vi.fn((_claim, _url, signal) => {
          navigating.resolve()
          return new Promise<string>((_resolve, reject) =>
            signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
          )
        })
      }
    })
    const results: string[] = []
    const dispatcher = new BrowserClientHostCommandDispatcher({
      authority: create(),
      handler: async (event, signal) => {
        const result = await executor.handle(event, signal)
        results.push(event.command.type)
        return result
      },
      cancelInitialization: (event) => executor.cancelInitialization(event)
    })
    const creation = dispatcher.dispatch(create())
    if (phase !== 'create') {
      await creation
    }
    let navigation: Promise<unknown> | undefined
    if (phase === 'navigate') {
      navigation = dispatcher.dispatch(createCommand('navigate'))
      await navigating.promise
    }
    const stale = close(phase === 'navigate' ? 3 : 2)
    if (stale.command.type === 'closePage') {
      stale.command.targetAuthority = { ...stale.command.targetAuthority, pageHostGeneration: 6 }
    }
    // Rejected stale targets cannot abort the initializer even when normally admitted to the terminal queue.
    if (phase === 'gap') {
      await expect(dispatcher.dispatch(stale)).resolves.toMatchObject({ status: 'failed' })
    }
    const closing = dispatcher.dispatch(close(phase === 'navigate' || phase === 'gap' ? 3 : 2))
    if (phase === 'create') {
      mount.resolve({ webContentsId: 41 })
    }
    await creation
    await navigation
    await expect(closing).resolves.toEqual({ status: 'completed' })
    expect(results.at(-1)).toBe('closePage')
    expect(executor.snapshotPageInventory()).toEqual([])
    expect(route.release).toHaveBeenCalledOnce()
    await dispatcher.close()
    await executor.close()
  }
)
