import { normalizeBrowserNavigationUrl } from '../../../../shared/browser-url'
import type {
  BrowserClientHostedPageInventory,
  BrowserClientHostCommandEvent
} from '../../../../shared/browser/client-hosting/browser-client-host-protocol'
import { sameBrowserClientPageAuthority } from '../../client-hosts/commands/browser-client-host-command-authority'
import type {
  BrowserClientRetainedPage,
  BrowserClientPageLifecycleRegistry
} from '../lifecycle/browser-client-page-retained-state'
import { updateBrowserClientPageInventoryCurrentUrl } from '../lifecycle/browser-client-page-inventory'
import { assertBrowserClientPageCommandNotAborted } from './browser-client-page-command-admission'
import { BrowserClientPageCommandError } from './browser-client-page-command-failure'

export type PageInitialization = {
  event: BrowserClientHostCommandEvent
  controller: AbortController
  creation?: Promise<void>
  page?: BrowserClientRetainedPage
  failedCleanup?: () => Promise<void>
}

export class BrowserClientPageInitializations {
  private readonly operations = new Map<string, PageInitialization>()

  constructor(
    private readonly pages: Map<string, BrowserClientRetainedPage>,
    private readonly failedPages: Map<string, BrowserClientHostedPageInventory>,
    private readonly routeWebContents: BrowserClientPageLifecycleRegistry,
    private readonly cleanupPage: (page: BrowserClientRetainedPage) => Promise<void>
  ) {}

  has(browserPageId: string): boolean {
    return this.operations.has(browserPageId)
  }

  begin(event: BrowserClientHostCommandEvent): PageInitialization | undefined {
    if (event.command.type !== 'createPage' || event.command.initialUrl === undefined) {
      return undefined
    }
    const initializer = { event, controller: new AbortController() }
    this.operations.set(event.browserPageId, initializer)
    return initializer
  }

  cancel(event: BrowserClientHostCommandEvent): boolean {
    const initializer = this.operations.get(event.browserPageId)
    if (
      event.command.type !== 'closePage' ||
      !initializer ||
      !sameBrowserClientPageAuthority(initializer.event, event.command.targetAuthority) ||
      event.pageHostGeneration !== initializer.event.pageHostGeneration
    ) {
      return false
    }
    initializer.controller.abort()
    return true
  }

  cancelAll(): void {
    for (const initializer of this.operations.values()) {
      initializer.controller.abort()
    }
  }

  async initialize(event: BrowserClientHostCommandEvent, signal: AbortSignal): Promise<string> {
    const initializer = this.operations.get(event.browserPageId)
    const page = this.pages.get(event.browserPageId)
    if (
      event.command.type !== 'navigate' ||
      initializer?.event.command.type !== 'createPage' ||
      !page ||
      initializer.page !== page ||
      !sameBrowserClientPageAuthority(initializer.event, event) ||
      event.commandSequence !== initializer.event.commandSequence + 1 ||
      normalizeBrowserNavigationUrl(event.command.url) !==
        normalizeBrowserNavigationUrl(initializer.event.command.initialUrl ?? '') ||
      !this.routeWebContents.initializeGuest
    ) {
      throw new BrowserClientPageCommandError('browser_client_page_initialization_stale')
    }
    const combined = AbortSignal.any([signal, initializer.controller.signal])
    try {
      const url = await this.routeWebContents.initializeGuest(
        page.lifecycleClaim,
        event.command.url,
        combined
      )
      assertBrowserClientPageCommandNotAborted(combined)
      if (
        this.operations.get(event.browserPageId) !== initializer ||
        this.pages.get(event.browserPageId) !== page ||
        !page.lifecycleClaim.isCurrent()
      ) {
        throw new BrowserClientPageCommandError('browser_client_page_initialization_stale')
      }
      page.inventory = Object.freeze({
        ...updateBrowserClientPageInventoryCurrentUrl(page.inventory, url),
        state: 'active'
      })
      this.operations.delete(event.browserPageId)
      return url
    } catch (error) {
      initializer.controller.abort()
      await this.cleanupInitializer(initializer)
      throw error
    }
  }

  private async cleanupInitializer(initializer: PageInitialization): Promise<void> {
    await initializer.creation?.catch(() => undefined)
    if (initializer.failedCleanup) {
      await initializer.failedCleanup()
      initializer.failedCleanup = undefined
    }
    const page = initializer.page
    if (page) {
      page.retiring ??= this.cleanupPage(page)
      try {
        await page.retiring
      } catch (error) {
        page.retiring = null
        throw error
      }
      if (this.pages.get(initializer.event.browserPageId) === page) {
        this.pages.delete(initializer.event.browserPageId)
      }
    }
    this.failedPages.delete(initializer.event.browserPageId)
  }

  async close(event: BrowserClientHostCommandEvent, signal: AbortSignal): Promise<void> {
    const initializer = this.operations.get(event.browserPageId)
    assertBrowserClientPageCommandNotAborted(signal)
    if (!initializer || !this.cancel(event)) {
      throw new BrowserClientPageCommandError('browser_client_page_reconciliation_authority_stale')
    }
    await this.cleanupInitializer(initializer)
    if (this.operations.get(event.browserPageId) === initializer) {
      this.operations.delete(event.browserPageId)
    }
  }

  async closeAll(): Promise<void> {
    for (const [id, initializer] of this.operations) {
      await this.cleanupInitializer(initializer)
      if (this.operations.get(id) === initializer) {
        this.operations.delete(id)
      }
    }
  }
}
