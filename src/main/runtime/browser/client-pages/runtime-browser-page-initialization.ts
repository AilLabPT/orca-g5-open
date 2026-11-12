import { sameRuntimeBrowserPlacement } from '../../../../shared/runtime-browser-placement'
import type { BrowserHostLeaseRegistry } from '../../browser-host/leases/browser-host-lease-registry'
import type { BrowserHostLeaseIdentity } from '../../browser-host/leases/browser-host-lease-records'
import type { BrowserClientHostedPageInventory } from '../../../../shared/browser/client-hosting/browser-client-host-protocol'
import type {
  RuntimeBrowserClientPage,
  RuntimeBrowserPageRegistry
} from './runtime-browser-page-registry'
import type { BrowserExecutionHostKeyResolution } from './runtime-browser-client-page-adoption'

export function admitRuntimeBrowserPageInitialization(input: {
  authority: Pick<BrowserHostLeaseRegistry, 'admitClientPageInitialization'>
  lease: BrowserHostLeaseIdentity
  pages: RuntimeBrowserPageRegistry
  page: RuntimeBrowserClientPage
  previous?: BrowserClientHostedPageInventory
  pageHostGeneration?: number
  url: string
  creationTimeoutMs?: number
  resolveExecutionHostKey(workspaceId: string): Promise<BrowserExecutionHostKeyResolution>
  notifyWorkspace(workspaceId: string): void
  releaseUnrecoverablePage?(page: RuntimeBrowserClientPage): void
  settled?(outcome: 'published' | 'retained' | 'unknown'): void
  signal?: AbortSignal
}): boolean {
  const { page } = input
  const isCurrent = (): boolean => {
    const current = input.pages.getPage(page.browserPageId)
    return Boolean(
      current &&
      current.workspaceId === page.workspaceId &&
      current.browserProfileId === page.browserProfileId &&
      sameRuntimeBrowserPlacement(current.placement, page.placement)
    )
  }
  return input.authority.admitClientPageInitialization(input.lease, {
    browserPageId: page.browserPageId,
    browserProfileId: page.browserProfileId,
    workspaceId: page.workspaceId,
    expected: page.placement,
    url: input.url,
    ...(input.previous ? { previous: input.previous } : {}),
    ...(input.pageHostGeneration === undefined
      ? {}
      : { pageHostGeneration: input.pageHostGeneration }),
    signal: input.signal,
    creationTimeoutMs: input.creationTimeoutMs,
    isCurrent,
    resolveExecutionHostKey: async () => {
      const resolved = await input.resolveExecutionHostKey(page.workspaceId)
      if (resolved.status === 'resolved') {
        return resolved.executionHostKey
      }
      if (resolved.status === 'workspace-gone' && isCurrent()) {
        input.releaseUnrecoverablePage?.(page)
      }
      return null
    },
    publish: (placement, url, executionHostKey) => {
      if (!isCurrent()) {
        throw new Error('browser_page_placement_stale')
      }
      input.pages.replaceClientPagePlacement(
        page.browserPageId,
        page.placement,
        placement,
        executionHostKey
      )
      input.pages.updatePage(page.browserPageId, placement, { url, loading: false })
      input.notifyWorkspace(page.workspaceId)
    },
    settled: input.settled
  })
}
