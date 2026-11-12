import type { BrowserClientHostedPageInventory } from '../../../../shared/browser/client-hosting/browser-client-host-protocol'
import { BrowserHostPageInitializations } from '../client-pages/browser-host-page-initialization'
import { BrowserHostPageReconciliationOrchestrator } from '../reconciliation/browser-host-page-reconciliation-orchestration'
import { BrowserHostLeaseReconnectController } from './browser-host-lease-reconnect'
import type { BrowserHostLeaseRegistry } from './browser-host-lease-registry'
import type { BrowserHostLeaseState } from './browser-host-lease-records'
import type { BrowserHostPagePlacementRegistry } from '../reconciliation/browser-host-page-placement'
import type { BrowserClientPageExecutionHostGrant } from '../client-pages/browser-host-client-page-creation'
import type { BrowserHostFenceReason } from './browser-host-lease-fence'
import type { BrowserHostTunnelRegistry } from './browser-host-tunnel-registry'

export function createBrowserHostLeaseControllers(
  registry: Pick<
    BrowserHostLeaseRegistry,
    'authorityRuntimeId' | 'authorityEpoch' | 'completePageRetirement' | 'requireLease'
  >,
  placements: BrowserHostPagePlacementRegistry,
  grants: Map<string, BrowserClientPageExecutionHostGrant>,
  dependencies: {
    leases: Map<string, BrowserHostLeaseState>
    tunnels: BrowserHostTunnelRegistry
    reconnectGraceMs?: number
    fence(state: BrowserHostLeaseState, reason: BrowserHostFenceReason): void
    fenceReconciliation(state: BrowserHostLeaseState): void
  }
) {
  const initializations = new BrowserHostPageInitializations(
    {
      placements,
      grants,
      retirePlacement: (id, placement) => {
        registry.completePageRetirement(placements.beginPageRetirement(id, placement))
      }
    },
    (state) => {
      if (registry.requireLease(state.lease) !== state.lease) {
        throw new Error('browser_host_lease_stale')
      }
    },
    (state) => dependencies.fence(state, 'released')
  )
  const reconciliations = new BrowserHostPageReconciliationOrchestrator(registry, placements)
  const reconnects = new BrowserHostLeaseReconnectController({
    graceMs: dependencies.reconnectGraceMs ?? 15_000,
    leasesByClientId: dependencies.leases,
    fenceReconciliation: dependencies.fenceReconciliation,
    fenceLease: dependencies.fence,
    fenceRoute: (state, reason) => dependencies.tunnels.fence(state, reason)
  })
  return {
    initializations,
    reconciliations,
    reconnects,
    observeInventory:
      (complete: () => void) =>
      (
        state: BrowserHostLeaseState,
        inventory: readonly BrowserClientHostedPageInventory[] | undefined
      ) => {
        initializations.observeAttach(state, inventory, complete)
        reconciliations.observeInventory(state)
      }
  }
}
