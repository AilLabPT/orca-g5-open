import type { RuntimeBrowserClientPlacement } from '../../../../shared/runtime-browser-placement'

export type BrowserHostLeaseRegistryOptions = {
  authorityRuntimeId: string
  authorityEpoch?: string
  reconnectGraceMs?: number
  /** Release staged per-page state even after transport loss; an optional generation scopes cleanup. */
  onClientPageReleased?: (browserPageId: string, pageHostGeneration?: number) => void
  /** Retain fenced page records for recovery when the same host identity returns. */
  onClientPageFenced?: (browserPageId: string, placement: RuntimeBrowserClientPlacement) => void
}
