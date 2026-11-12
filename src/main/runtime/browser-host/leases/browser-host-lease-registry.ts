import type { BrowserHostLeaseRegistryOptions } from './browser-host-lease-registry-options'
import {
  createBrowserHostPageInitializations,
  type BrowserHostPageInitializations,
  type BrowserHostPageInitializationInput
} from '../client-pages/browser-host-page-initialization'
import { switchBrowserHostClientProfile } from '../profiles/browser-host-client-profile-switch'
import { randomUUID } from 'node:crypto'
import type { BrowserClientHostCommandEvent } from '../../../../shared/browser/client-hosting/browser-client-host-protocol'
import type { BrowserHostCommandResultParams } from '../commands/browser-host-command-state'
import type {
  BrowserHostCommandResultIdentity,
  BrowserHostLease,
  BrowserHostLeaseHandle,
  BrowserHostLeaseIdentity,
  BrowserHostLeaseState,
  BrowserTunnelLeaseHandle
} from './browser-host-lease-records'
import { BrowserHostGenerationCounter } from './browser-host-generation-counter'
import {
  issueBrowserHostClientPageCommand,
  attachBrowserHostClientCommandDelivery,
  settleBrowserHostClientPageCommand
} from '../commands/browser-host-client-page-command-issue'
import {
  BrowserHostPagePlacementRegistry,
  type BrowserClientPageAuthority,
  type BrowserPageRetirement
} from '../reconciliation/browser-host-page-placement'
import type {
  RuntimeBrowserClientPlacement,
  RuntimeBrowserPlacement
} from '../../../../shared/runtime-browser-placement'
import { requireLiveBrowserClientPage } from '../reconciliation/browser-host-page-authority'
import type { BrowserHostFenceReason } from './browser-host-lease-fence'
import { dispatchBrowserHostLeaseFence } from './browser-host-lease-fence-dispatch'
import { selectActiveBrowserHostLease } from './browser-host-capability-selection'
import {
  createBrowserHostClientPage,
  type BrowserClientPageExecutionHostGrant,
  type BrowserHostClientPageCreateOptions
} from '../client-pages/browser-host-client-page-creation'
import {
  adoptBrowserHostClientPages,
  type BrowserHostClientPageAdoptionOptions
} from '../client-pages/browser-host-client-page-adoption'
import { BrowserHostPageReconciliationOrchestrator } from '../reconciliation/browser-host-page-reconciliation-orchestration'
import type { BrowserHostRuntimePageIntent } from '../reconciliation/browser-host-page-reconciliation-plan'
import { BrowserHostLeaseReconnectController } from './browser-host-lease-reconnect'
import {
  attachBrowserHostLease,
  type BrowserHostLeaseAttachInput
} from './browser-host-lease-attachment'
import { BrowserHostTunnelRegistry } from './browser-host-tunnel-registry'
import { requireBrowserHostLeaseState } from './browser-host-lease-state-resolution'
import {
  requireBrowserClientPageConnection,
  type BrowserClientPageConnectionInput
} from '../client-pages/browser-host-client-page-connection'
import { completeBrowserHostPageRetirement } from '../reconciliation/browser-host-page-retirement-completion'
import { placeBrowserHostClientPage } from '../client-pages/browser-host-client-page-placement'

export class BrowserHostLeaseRegistry {
  readonly authorityRuntimeId: string
  readonly authorityEpoch: string
  private readonly generations = new BrowserHostGenerationCounter()
  private readonly leasesByClientId = new Map<string, BrowserHostLeaseState>()
  private readonly tunnels = new BrowserHostTunnelRegistry()
  private readonly clientPageExecutionHostGrants = new Map<
    string,
    BrowserClientPageExecutionHostGrant
  >()
  private readonly initializations: BrowserHostPageInitializations
  private readonly pagePlacements: BrowserHostPagePlacementRegistry
  private readonly pageReconciliations: BrowserHostPageReconciliationOrchestrator
  private readonly reconnects: BrowserHostLeaseReconnectController

  constructor(private readonly options: BrowserHostLeaseRegistryOptions) {
    this.authorityRuntimeId = options.authorityRuntimeId
    this.authorityEpoch = options.authorityEpoch ?? randomUUID()
    this.pagePlacements = new BrowserHostPagePlacementRegistry({
      authorityRuntimeId: this.authorityRuntimeId,
      authorityEpoch: this.authorityEpoch
    })
    this.initializations = createBrowserHostPageInitializations(
      this.pagePlacements,
      this.clientPageExecutionHostGrants,
      (id, placement) =>
        this.completePageRetirement(this.pagePlacements.beginPageRetirement(id, placement)),
      (lease) => this.requireLeaseState(lease)
    )
    this.pageReconciliations = new BrowserHostPageReconciliationOrchestrator(
      this,
      this.pagePlacements
    )
    this.reconnects = new BrowserHostLeaseReconnectController({
      graceMs: options.reconnectGraceMs ?? 15_000,
      leasesByClientId: this.leasesByClientId,
      fenceReconciliation: (state) => this.fenceReconciliation(state),
      fenceLease: (state, reason) => this.fenceLease(state, reason),
      fenceRoute: (state, reason) => this.tunnels.fence(state, reason)
    })
  }

  attach(input: BrowserHostLeaseAttachInput): BrowserHostLeaseHandle {
    return attachBrowserHostLease(input, {
      authorityRuntimeId: this.authorityRuntimeId,
      authorityEpoch: this.authorityEpoch,
      leasesByClientId: this.leasesByClientId,
      reconnects: this.reconnects,
      generations: this.generations,
      observeInventory: (state) => this.pageReconciliations.observeInventory(state),
      fenceLease: (state) => this.fenceLease(state, 'replaced')
    })
  }

  select(
    browserHostClientId?: string,
    requiredCapabilities: readonly string[] = []
  ): BrowserHostLease {
    return selectActiveBrowserHostLease(
      this.leasesByClientId,
      browserHostClientId,
      requiredCapabilities
    )
  }

  requireLease(identity: BrowserHostLeaseIdentity): BrowserHostLease {
    return this.requireLeaseState(identity).lease
  }

  requireClientPageConnection(input: BrowserClientPageConnectionInput) {
    return requireBrowserClientPageConnection(input, {
      authorityRuntimeId: this.authorityRuntimeId,
      authorityEpoch: this.authorityEpoch,
      leasesByClientId: this.leasesByClientId,
      pagePlacements: this.pagePlacements
    })
  }

  private requireLeaseState(identity: BrowserHostLeaseIdentity): BrowserHostLeaseState {
    return requireBrowserHostLeaseState(this.authorityEpoch, this.leasesByClientId, identity)
  }

  grantExecutionHost(identity: BrowserHostLeaseIdentity, executionHostKey: string) {
    return this.tunnels.grantExecutionHost(this.requireLeaseState(identity), executionHostKey)
  }

  requireExecutionHost(identity: BrowserHostLeaseIdentity, executionHostKey: string): void {
    this.tunnels.requireExecutionHost(this.requireLeaseState(identity), executionHostKey)
  }

  linkExecutionHostGrant(
    identity: BrowserHostLeaseIdentity,
    executionHostKey: string,
    onRevoked: () => void
  ): () => void {
    return this.tunnels.linkExecutionHostGrant(
      this.requireLeaseState(identity),
      executionHostKey,
      onRevoked
    )
  }

  placeServerPage(browserPageId: string): RuntimeBrowserPlacement {
    return this.pagePlacements.placeServerPage(browserPageId)
  }

  placeClientPage(
    browserPageId: string,
    browserHostClientId?: string,
    requiredCapabilities: readonly string[] = []
  ): RuntimeBrowserPlacement {
    return placeBrowserHostClientPage({
      browserPageId,
      browserHostClientId,
      requiredCapabilities,
      pagePlacements: this.pagePlacements,
      selectLease: (clientId, capabilities) => this.select(clientId, capabilities)
    })
  }

  async createClientPage(
    options: BrowserHostClientPageCreateOptions
  ): Promise<RuntimeBrowserClientPlacement> {
    return createBrowserHostClientPage(options, {
      selectLease: (clientId, capabilities) => this.select(clientId, capabilities),
      requireLeaseState: (lease) => this.requireLeaseState(lease),
      pagePlacements: this.pagePlacements,
      executionHostGrants: this.clientPageExecutionHostGrants
    })
  }

  hasClientPageInitialization(browserPageId: string): boolean {
    return this.initializations.has(browserPageId)
  }

  admitClientPageInitialization(
    identity: BrowserHostLeaseIdentity,
    input: BrowserHostPageInitializationInput
  ): boolean {
    const state = this.requireLeaseState(identity)
    return this.initializations.admit(state, input)
  }

  cancelClientPageInitialization(
    browserPageId: string,
    expected: RuntimeBrowserClientPlacement
  ): boolean {
    return this.initializations.cancel(browserPageId, expected)
  }

  switchClientPageProfile(
    authority: BrowserClientPageAuthority,
    profile: Parameters<typeof switchBrowserHostClientProfile>[1],
    onLateCommit?: (placement: RuntimeBrowserClientPlacement) => void
  ) {
    return switchBrowserHostClientProfile(authority, profile, {
      onLateCommit,
      registry: this,
      state: (clientId) => this.requireLeaseState(this.select(clientId, [])),
      placements: this.pagePlacements,
      grants: this.clientPageExecutionHostGrants,
      onCommitted: this.options.onClientPageReleased
    })
  }

  requireClientPage(authority: BrowserClientPageAuthority): RuntimeBrowserClientPlacement {
    return requireLiveBrowserClientPage(this.pagePlacements, this.leasesByClientId, authority)
  }

  adoptClientPages(
    identity: BrowserHostLeaseIdentity,
    intents: readonly BrowserHostRuntimePageIntent[],
    options: BrowserHostClientPageAdoptionOptions = {}
  ): Promise<readonly string[]> {
    return adoptBrowserHostClientPages(intents, options, {
      state: this.requireLeaseState(identity),
      reconciliations: this.pageReconciliations,
      placements: this.pagePlacements,
      executionHostGrants: this.clientPageExecutionHostGrants
    })
  }

  attachCommandDelivery(
    identity: BrowserHostLeaseIdentity,
    delivery: (event: BrowserClientHostCommandEvent) => void
  ): () => void {
    return attachBrowserHostClientCommandDelivery(this.requireLeaseState(identity), delivery)
  }

  issueClientPageCommand(
    authority: BrowserClientPageAuthority,
    command: BrowserClientHostCommandEvent['command']
  ): ReturnType<typeof issueBrowserHostClientPageCommand> {
    this.requireClientPage(authority)
    return issueBrowserHostClientPageCommand(authority, command, this.leasesByClientId)
  }

  settleClientPageCommand(
    identity: BrowserHostCommandResultIdentity,
    params: BrowserHostCommandResultParams
  ): boolean {
    return settleBrowserHostClientPageCommand(
      this.requireLeaseState(identity),
      identity,
      params,
      (authority) => this.requireClientPage(authority)
    )
  }

  getPlacement(browserPageId: string): RuntimeBrowserPlacement | undefined {
    return this.pagePlacements.getPlacement(browserPageId)
  }

  getClientPageExecutionHostKey(browserPageId: string): string | undefined {
    const grant = this.clientPageExecutionHostGrants.get(browserPageId)
    return grant && this.pagePlacements.getPlacement(browserPageId) === grant.placement
      ? grant.executionHostKey
      : undefined
  }

  beginPageRetirement(browserPageId: string, expected: RuntimeBrowserPlacement) {
    return this.pagePlacements.beginPageRetirement(browserPageId, expected)
  }

  cancelPageRetirement(retirement: BrowserPageRetirement): boolean {
    return this.pagePlacements.cancelPageRetirement(retirement)
  }

  completePageRetirement(retirement: BrowserPageRetirement): boolean {
    return completeBrowserHostPageRetirement(retirement, {
      pagePlacements: this.pagePlacements,
      leasesByClientId: this.leasesByClientId,
      executionHostGrants: this.clientPageExecutionHostGrants,
      onClientPageReleased: this.options.onClientPageReleased
    })
  }

  openTunnel(
    identity: BrowserHostLeaseIdentity & { executionHostKey: string },
    options?: { requireExecutionHostGrant?: boolean }
  ): BrowserTunnelLeaseHandle {
    return this.tunnels.open(this.requireLeaseState(identity), identity.executionHostKey, options)
  }

  private fenceLease(state: BrowserHostLeaseState, reason: BrowserHostFenceReason): void {
    dispatchBrowserHostLeaseFence(state, reason, {
      leasesByClientId: this.leasesByClientId,
      pagePlacements: this.pagePlacements,
      clearReconnect: (fenced) => this.reconnects.clear(fenced),
      fenceReconciliation: (state) => this.fenceReconciliation(state),
      fenceRoute: (route, routeReason) => this.tunnels.fence(route, routeReason),
      releaseFencedPage: (retirement) => this.releaseFencedClientPage(retirement)
    })
  }

  private fenceReconciliation(state: BrowserHostLeaseState): void {
    this.initializations.fence(state)
    this.pageReconciliations.fence(state)
  }

  private releaseFencedClientPage(retirement: BrowserPageRetirement): void {
    if (this.completePageRetirement(retirement) && retirement.placement.kind === 'client') {
      this.options.onClientPageFenced?.(retirement.browserPageId, retirement.placement)
    }
  }
}
