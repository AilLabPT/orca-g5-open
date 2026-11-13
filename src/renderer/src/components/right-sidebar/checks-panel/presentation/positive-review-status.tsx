import React, { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { LoadingSpinner } from '@/components/LoadingSpinner'
import { DetachedHeadBadge } from '@/components/DetachedHeadBadge'
import { useIntlLocale, useTranslate } from '@/i18n/use-translate'
import { useNow } from '@/hooks/use-now'
import { useAppStore } from '@/store'
import { isMacPlatform } from '../../../terminal-pane/links/terminal-link-open-hints'
import { openChecksPanelHostedReviewUrl } from '../review-actions/checks-panel-hosted-review-click-routing'
import type { ChecksPanelRefreshInput } from '../checks-panel-review-state-model'
import {
  getPositiveReviewPresentation,
  type PositiveReviewPresentation
} from './checks-panel-positive-review-status'
import { requestReviewHeaderFocusAfterRetry } from './positive-review-focus-handoff'

// Defer visible loading so fast local reads stay quiet while SSH still gets feedback.
const SPINNER_DELAY_MS = 200

function useDelayedFlag(on: boolean): boolean {
  const [shown, setShown] = useState(false)
  useEffect(() => {
    if (!on) {
      setShown(false)
      return
    }
    const timer = window.setTimeout(() => setShown(true), SPINNER_DELAY_MS)
    return () => window.clearTimeout(timer)
  }, [on])
  return on && shown
}

export function ChecksPanelPositiveReviewStatus({
  presentation,
  announcement,
  actionsDisabled,
  onOpen,
  onRetry
}: {
  presentation: PositiveReviewPresentation
  /** Changes once per terminal outcome so the same text is announced again. */
  announcement: number
  actionsDisabled: boolean
  onOpen: (event: React.MouseEvent<HTMLButtonElement>, url: string) => void
  onRetry: () => void
}): React.JSX.Element {
  const t = useTranslate()
  const showSpinner = useDelayedFlag(presentation.spinner)
  const retryBlocked = presentation.retryBlocked || actionsDisabled
  return (
    <>
      <div className="text-sm font-medium text-foreground">{presentation.title}</div>
      <div
        role="status"
        aria-live="polite"
        className="mt-1 flex items-center gap-1.5 text-xs text-muted-foreground"
      >
        {showSpinner ? <LoadingSpinner className="size-3 shrink-0" /> : null}
        <span key={announcement}>{presentation.statusText}</span>
      </div>
      <div className="mt-3 flex flex-wrap gap-2">
        {presentation.open ? (
          <Button
            size="xs"
            variant="outline"
            aria-label={presentation.open.ariaLabel}
            onClick={(event) => onOpen(event, presentation.open!.url)}
          >
            {presentation.open.label}
          </Button>
        ) : null}
        <Button
          size="xs"
          variant="outline"
          // aria-disabled keeps keyboard focus on Retry while a read or rate gate blocks it.
          aria-disabled={retryBlocked || undefined}
          className={retryBlocked ? 'cursor-not-allowed opacity-50' : undefined}
          onClick={() => {
            if (!retryBlocked) {
              onRetry()
            }
          }}
        >
          {t('auto.components.right.sidebar.ChecksPanel.review.retry', 'Retry')}
        </Button>
      </div>
    </>
  )
}

/** Positive and existing-review states: wires the state table to recovery, refresh state and actions. */
export function ChecksPanelPositiveReview({
  detachedHeadDisplay,
  reviewShortLabel,
  providerName,
  reviewNumber,
  openReviewUrl,
  refresh,
  manualRetryInFlight,
  actionsDisabled,
  worktreeId,
  manualRefreshFailed,
  onRetry,
  setRetrying
}: {
  detachedHeadDisplay: React.ComponentProps<typeof DetachedHeadBadge>['display'] | null
  reviewShortLabel: string
  providerName: string
  reviewNumber: number | null
  openReviewUrl: string | null
  refresh: ChecksPanelRefreshInput | undefined
  manualRetryInFlight: boolean
  actionsDisabled: boolean
  worktreeId: string | null
  manualRefreshFailed: boolean
  onRetry: () => Promise<unknown>
  setRetrying: (retrying: boolean) => void
}): React.JSX.Element {
  const t = useTranslate()
  const intlLocale = useIntlLocale()
  const recovery = useAppStore((s) => s.prDetailRecovery)
  const cancelRecovery = useAppStore((s) => s.cancelGitHubPRDetailRecovery)
  const now = useNow(
    1000,
    recovery?.status.kind === 'paused' ||
      refresh?.retryDisabledUntil !== undefined ||
      refresh?.nextAutoRetryAt !== undefined
  )
  const presentation = getPositiveReviewPresentation(
    {
      reviewShortLabel,
      providerName,
      reviewNumber,
      openReviewUrl,
      recovery: recovery?.status ?? null,
      manualRetryInFlight,
      refresh: refresh ?? (manualRefreshFailed ? { status: 'error' } : undefined),
      now,
      formatTime: (at) => new Date(at).toLocaleTimeString(intlLocale)
    },
    t
  )
  return (
    <div className="px-4 py-6">
      {detachedHeadDisplay && (
        <div className="mb-3">
          <DetachedHeadBadge display={detachedHeadDisplay} side="bottom" />
        </div>
      )}
      <ChecksPanelPositiveReviewStatus
        presentation={presentation}
        announcement={recovery?.terminalCount ?? 0}
        actionsDisabled={actionsDisabled}
        onOpen={(event, url) =>
          openChecksPanelHostedReviewUrl({ url, event, isMac: isMacPlatform(), worktreeId })
        }
        onRetry={() => {
          if (!worktreeId) {
            return
          }
          cancelRecovery()
          requestReviewHeaderFocusAfterRetry(worktreeId)
          setRetrying(true)
          void onRetry().finally(() => setRetrying(false))
        }}
      />
    </div>
  )
}
