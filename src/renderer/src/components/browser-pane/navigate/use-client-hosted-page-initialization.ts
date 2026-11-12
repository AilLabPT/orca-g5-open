import { useCallback, type RefObject } from 'react'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import type { BrowserPageInitializationAction } from '../../../../../shared/browser/client-hosting/browser-page-initialization-action'
import type { BrowserGuestMetadata } from '../../../../../shared/browser/guest-lifecycle/browser-guest-metadata'
import type { ClientHostedBrowserPagePaneProps } from '../describe-page/browser-page-types'
import { useRestoredClientHostedRecoveryWindow } from '../restored-client-hosted-recovery-window'
import { routeBrowserPageInitializationAction } from './browser-page-initialization-action'

export function useClientHostedPageInitialization(
  props: ClientHostedBrowserPagePaneProps,
  attachmentError: string | null,
  loadFailureRef: RefObject<BrowserGuestMetadata['loadError']>
) {
  const {
    browserTab,
    placement,
    runtimeEnvironmentId,
    workspaceId,
    worktreeId,
    onUpdatePageState
  } = props
  const ownedInitialization = browserTab.initializationState !== undefined
  const ownedPending = browserTab.initializationState === 'pending'
  const restoredPageUnrecovered = useRestoredClientHostedRecoveryWindow({
    ownedInitialization,
    browserPageId: browserTab.id,
    environmentId: runtimeEnvironmentId,
    placementPending: placement === null
  })
  const actOnInitialization = useCallback(
    (action: BrowserPageInitializationAction) => {
      const handle = useAppStore.getState().remoteBrowserPageHandlesByPageId[browserTab.id]
      const expected = placement ?? handle?.placement
      if (expected?.kind !== 'client') {
        return
      }
      if (action.type === 'navigate') {
        loadFailureRef.current = null
        onUpdatePageState(browserTab.id, { loading: true, loadError: null })
      }
      void routeBrowserPageInitializationAction({
        pageId: browserTab.id,
        workspaceId,
        worktreeId,
        environmentId: runtimeEnvironmentId,
        placement: expected,
        action,
        onFailure: () =>
          onUpdatePageState(browserTab.id, {
            loading: false,
            loadError: {
              code: 0,
              description: translate(
                'browser.guestRecovery.failed',
                'The browser page stopped unexpectedly. Retry to restore it.'
              ),
              validatedUrl: browserTab.url
            }
          })
      })
    },
    [
      loadFailureRef,
      browserTab.id,
      browserTab.url,
      onUpdatePageState,
      placement,
      runtimeEnvironmentId,
      workspaceId,
      worktreeId
    ]
  )
  const initializationAction = ownedInitialization ? actOnInitialization : undefined
  const unavailable = !ownedInitialization && (Boolean(attachmentError) || restoredPageUnrecovered)
  const showFailureOverlay = !unavailable && Boolean(browserTab.loadError)

  // Unrecovered pages have no pending load that could ever clear a loading indicator.
  const loading = ownedInitialization
    ? ownedPending
    : !restoredPageUnrecovered && (placement === null || browserTab.loading)

  return { initializationAction, ownedInitialization, unavailable, showFailureOverlay, loading }
}
