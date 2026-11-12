import { endBrowserPageInitializationAction } from '../../components/browser-pane/navigate/browser-page-deferred-navigation'
import { useAppStore } from '@/store'
import type { RuntimeMobileSessionTabsResult } from '../../../../shared/runtime-types'
import type { RuntimeMobileSessionBrowserTab } from '../../../../shared/runtime-mobile-session-tab-contracts'
import type { RemoteBrowserPageHandle } from '@/store/slices/browser/browser-slice-contract'
import {
  getRuntimeEnvironmentRevision,
  onRuntimeEnvironmentRevisionsChanged,
  onRuntimeEnvironmentsRetired
} from '../rpc/environment-revisions/runtime-environment-revision'

export type BrowserInitializationDelivery = {
  environmentId: string
  pairingRevision: number | undefined
  live: boolean
}
export type BrowserInitializationPresentation = {
  disposition: 'pending' | 'stopped' | 'unavailable'
  delivery: BrowserInitializationDelivery
  receivedFrame: number
}
type Receipt = { delivery: BrowserInitializationDelivery; receivedFrame: number }
type DeliveryEntry = {
  delivery: BrowserInitializationDelivery
  transportGeneration: number
  lost: boolean
}
const deliveries = new Map<string, DeliveryEntry>()
const receipts = new WeakMap<RuntimeMobileSessionTabsResult, Receipt>()

export function captureBrowserInitializationDelivery(
  environmentId: string
): BrowserInitializationDelivery {
  const revision = getRuntimeEnvironmentRevision(environmentId)
  let entry = deliveries.get(environmentId)
  if (!entry || entry.delivery.pairingRevision !== revision) {
    if (entry) {
      entry.delivery.live = false
    }
    entry = {
      delivery: { environmentId, pairingRevision: revision, live: true },
      transportGeneration: -1,
      lost: false
    }
    deliveries.set(environmentId, entry)
  } else if (!entry.delivery.live) {
    entry.delivery = { environmentId, pairingRevision: revision, live: true }
  }
  return entry.delivery
}

export function isBrowserInitializationDeliveryCurrent(
  delivery: BrowserInitializationDelivery
): boolean {
  return (
    delivery.live &&
    deliveries.get(delivery.environmentId)?.delivery === delivery &&
    getRuntimeEnvironmentRevision(delivery.environmentId) === delivery.pairingRevision
  )
}

export function recordBrowserInitializationReceipt(
  environmentId: string,
  snapshot: RuntimeMobileSessionTabsResult,
  receivedFrame: number,
  delivery = captureBrowserInitializationDelivery(environmentId)
): void {
  // Cached visibility frames keep their original connection even when reapplied after reconnect.
  if (!receipts.has(snapshot)) {
    receipts.set(snapshot, { delivery, receivedFrame })
  }
}

export function carryBrowserInitializationReceipt(
  source: RuntimeMobileSessionTabsResult,
  target: RuntimeMobileSessionTabsResult
): void {
  const receipt = receipts.get(source)
  if (receipt) {
    receipts.set(target, receipt)
  }
}

export function browserInitializationPresentation(
  snapshot: RuntimeMobileSessionTabsResult,
  tab: RuntimeMobileSessionBrowserTab,
  previous: RemoteBrowserPageHandle | undefined
): BrowserInitializationPresentation | undefined {
  const receipt = receipts.get(snapshot)
  if (!receipt || !isBrowserInitializationDeliveryCurrent(receipt.delivery)) {
    return previous?.initializationPresentation
  }
  if (!tab.initializationState) {
    return undefined
  }
  const prior = previous?.initializationPresentation
  if (
    prior?.delivery === receipt.delivery &&
    prior.receivedFrame === receipt.receivedFrame &&
    prior.disposition === tab.initializationState
  ) {
    return prior
  }
  return { ...receipt, disposition: tab.initializationState }
}

export function browserInitializationReceiptStale(
  snapshot: RuntimeMobileSessionTabsResult
): boolean {
  const receipt = receipts.get(snapshot)
  return Boolean(receipt && !isBrowserInitializationDeliveryCurrent(receipt.delivery))
}

export function browserInitializationReceiptCurrent(
  snapshot: RuntimeMobileSessionTabsResult
): boolean {
  const receipt = receipts.get(snapshot)
  return Boolean(receipt && isBrowserInitializationDeliveryCurrent(receipt.delivery))
}

function revokeBrowserInitializationDelivery(environmentId: string, remove = false): void {
  const entry = deliveries.get(environmentId)
  if (!entry) {
    return
  }
  if (entry.lost && !remove) {
    return
  }
  entry.lost = true
  entry.delivery.live = false
  if (remove) {
    deliveries.delete(environmentId)
  }
  useAppStore.setState((state) => {
    let handles = state.remoteBrowserPageHandlesByPageId
    for (const [pageId, handle] of Object.entries(handles)) {
      const presentation = handle.initializationPresentation
      if (
        handle.environmentId !== environmentId ||
        !presentation ||
        presentation.disposition === 'unavailable'
      ) {
        continue
      }
      if (handles === state.remoteBrowserPageHandlesByPageId) {
        handles = { ...handles }
      }
      endBrowserPageInitializationAction(pageId)
      handles[pageId] = {
        ...handle,
        initializationPresentation: { ...presentation, disposition: 'unavailable' }
      }
    }
    return handles === state.remoteBrowserPageHandlesByPageId
      ? state
      : { remoteBrowserPageHandlesByPageId: handles }
  })
}

/** The app lifetime observes transport death even while workspace subscriptions are parked. */
export function installBrowserInitializationPresentationLifetime(): () => void {
  const stopDiagnostics = window.api.runtimeEnvironments.onSharedControlDiagnostics?.(
    ({ environmentId, transportGeneration, diagnostics }) => {
      const entry = deliveries.get(environmentId)
      if (!entry || transportGeneration < entry.transportGeneration) {
        return
      }
      if (transportGeneration > entry.transportGeneration && entry.transportGeneration !== -1) {
        revokeBrowserInitializationDelivery(environmentId)
      }
      entry.transportGeneration = transportGeneration
      if (diagnostics.state === 'closed' || diagnostics.state === 'reconnecting') {
        revokeBrowserInitializationDelivery(environmentId)
      } else if (diagnostics.state === 'ready') {
        entry.lost = false
      }
    }
  )
  const retire = (ids: readonly string[]): void => {
    for (const id of ids) {
      revokeBrowserInitializationDelivery(id, true)
    }
  }
  const stopRetirement = onRuntimeEnvironmentsRetired(retire)
  const stopPairing = onRuntimeEnvironmentRevisionsChanged(retire)
  const stopStatus = useAppStore.subscribe((state, previous) => {
    if (state.runtimeStatusByEnvironmentId === previous.runtimeStatusByEnvironmentId) {
      return
    }
    for (const [id] of deliveries) {
      const snapshot = state.runtimeStatusByEnvironmentId.get(id)?.snapshot
      if (
        snapshot &&
        (snapshot.retired || snapshot.verification === 'blocked') &&
        snapshot.pairingRevision === getRuntimeEnvironmentRevision(id)
      ) {
        revokeBrowserInitializationDelivery(id, true)
      }
    }
  })
  return () => {
    stopDiagnostics?.()
    stopRetirement()
    stopPairing()
    stopStatus()
    for (const id of deliveries.keys()) {
      revokeBrowserInitializationDelivery(id, true)
    }
  }
}
