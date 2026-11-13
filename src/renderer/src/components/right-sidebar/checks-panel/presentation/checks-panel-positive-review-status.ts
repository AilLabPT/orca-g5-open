import { translate } from '@/i18n/i18n'
import type { Translate } from '@/i18n/use-translate'
import type { PRDetailRecoveryStatus } from '@/store/github/pull-requests/pr-detail-recovery-context'
import type { PRRefreshErrorType } from '../../../../../../shared/github/pull-requests/refresh/pull-request-refresh-types'
import type { ChecksPanelRefreshInput } from '../checks-panel-review-state-model'
import { HARD_ERROR_COPY } from './checks-panel-review-copy'

export type PositiveReviewStatusKind =
  | 'queued'
  | 'rate-gate'
  | 'admitted'
  | 'failed'
  | 'timeout'
  | 'unusable'
  | 'not-loaded'

export type PositiveReviewStatusInput = {
  reviewShortLabel: string
  providerName: string
  reviewNumber: number | null
  openReviewUrl: string | null
  /** This panel's automatic detail recovery; null when none was submitted for this context. */
  recovery: PRDetailRecoveryStatus | null
  /** A deliberate Retry is reading now. */
  manualRetryInFlight: boolean
  /** The ordinary PR refresh state for this alias (manual Retry, polls, host rate gates). */
  refresh: ChecksPanelRefreshInput | undefined
  now: number
  formatTime: (at: number) => string
}

export type PositiveReviewPresentation = {
  title: string
  statusKind: PositiveReviewStatusKind
  statusText: string
  open: { label: string; ariaLabel: string; url: string } | null
  /** Retry stays focusable; while blocked it is aria-disabled and ignores activation. */
  retryBlocked: boolean
  spinner: boolean
}

type StatusChoice = {
  kind: PositiveReviewStatusKind
  until?: number
  errorType?: PRRefreshErrorType
}

function rateGateUntil(refresh: ChecksPanelRefreshInput | undefined, now: number): number | null {
  const until =
    refresh?.retryDisabledUntil ??
    (refresh?.status === 'paused' ? refresh.nextAutoRetryAt : undefined)
  return until !== undefined && until > now ? until : null
}

function ordinaryStatus(refresh: ChecksPanelRefreshInput | undefined): StatusChoice | null {
  if (refresh?.status === 'in-flight') {
    return { kind: 'admitted' }
  }
  if (refresh?.status === 'queued') {
    return { kind: 'queued' }
  }
  if (refresh?.status === 'error') {
    return { kind: 'failed', errorType: refresh.errorType }
  }
  return null
}

function chooseStatus(input: PositiveReviewStatusInput): StatusChoice {
  if (input.manualRetryInFlight) {
    return { kind: 'admitted' }
  }
  const gate = rateGateUntil(input.refresh, input.now)
  if (gate !== null) {
    return { kind: 'rate-gate', until: gate }
  }
  const recovery = input.recovery
  switch (recovery?.kind) {
    case 'paused':
      return recovery.notBefore > input.now
        ? { kind: 'rate-gate', until: recovery.notBefore }
        : { kind: 'queued' }
    case 'waiting':
      return { kind: 'queued' }
    case 'admitted':
      return { kind: 'admitted' }
    case 'failed':
      return { kind: 'failed', errorType: recovery.errorType }
    case 'timeout':
      return { kind: 'timeout' }
    case 'unusable':
    case 'resolved':
      // A completed read stays truthful; only a read happening now replaces it.
      return input.refresh?.status === 'in-flight' ? { kind: 'admitted' } : { kind: 'unusable' }
    default:
      // Old hosts, superseded or Retry-owned recovery: the ordinary refresh state speaks.
      return ordinaryStatus(input.refresh) ?? { kind: 'not-loaded' }
  }
}

function failedText(
  input: PositiveReviewStatusInput,
  errorType: PRRefreshErrorType | undefined,
  t: Translate
): string {
  const provider = input.providerName
  const hard = errorType ? HARD_ERROR_COPY[errorType as keyof typeof HARD_ERROR_COPY] : undefined
  if (hard) {
    return t(hard.title.key, hard.title.fallback, { provider })
  }
  if (errorType === 'network') {
    return t(
      'auto.components.right.sidebar.checks.panel.review.network.title',
      'Could not reach {{provider}}',
      {
        provider
      }
    )
  }
  return t('checksPanel.positiveReview.status.failed', "Couldn't load details")
}

/** Positive review states share one layout: the title and actions stay put, only the status line changes. */
export function getPositiveReviewPresentation(
  input: PositiveReviewStatusInput,
  t: Translate = translate
): PositiveReviewPresentation {
  const { reviewShortLabel: shortLabel, providerName: provider, reviewNumber: number } = input
  const choice = chooseStatus(input)
  const statusText = {
    queued: () => t('checksPanel.positiveReview.status.queued', 'Waiting to load details'),
    'rate-gate': () =>
      t(
        'checksPanel.positiveReview.status.rateGate',
        '{{provider}} limit reached. Loads at {{time}}.',
        {
          provider,
          time: input.formatTime(choice.until ?? input.now)
        }
      ),
    admitted: () => t('checksPanel.positiveReview.status.loading', 'Loading details…'),
    failed: () => failedText(input, choice.errorType, t),
    timeout: () =>
      t('checksPanel.positiveReview.status.timeout', "{{provider}} didn't respond", { provider }),
    unusable: () => t('checksPanel.positiveReview.status.unusable', "Details can't be shown here"),
    'not-loaded': () => t('checksPanel.positiveReview.status.notLoaded', 'Details not loaded')
  }[choice.kind]()
  return {
    title:
      number !== null
        ? t('checksPanel.positiveReview.title', '{{shortLabel}} #{{number}}', {
            shortLabel,
            number
          })
        : t('checksPanel.positiveReview.titleNoNumber', '{{shortLabel}} found', { shortLabel }),
    statusKind: choice.kind,
    statusText,
    open: input.openReviewUrl
      ? {
          url: input.openReviewUrl,
          label: t('checksPanel.positiveReview.open', 'Open {{shortLabel}}', { shortLabel }),
          ariaLabel:
            number !== null
              ? t(
                  'checksPanel.positiveReview.openAria',
                  'Open {{shortLabel}} #{{number}} on {{provider}}',
                  {
                    shortLabel,
                    number,
                    provider
                  }
                )
              : t(
                  'checksPanel.positiveReview.openAriaNoNumber',
                  'Open {{shortLabel}} on {{provider}}',
                  {
                    shortLabel,
                    provider
                  }
                )
        }
      : null,
    retryBlocked: choice.kind === 'admitted' || choice.kind === 'rate-gate',
    spinner: choice.kind === 'admitted'
  }
}
