import {
  defineFixture,
  type ComponentFixture
} from '../../../../component-fixtures/component-fixture'
import type { PRDetailRecoveryStatus } from '@/store/github/pull-requests/pr-detail-recovery-context'
import { ChecksPanelPositiveReview } from './positive-review-status'

const noop = (): void => {}
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 400))

function row(
  status: PRDetailRecoveryStatus,
  width: number,
  options: { reviewNumber?: number | null; openReviewUrl?: string | null } = {}
): ComponentFixture {
  return {
    width,
    store: { prDetailRecovery: { contextKey: 'fixture', status, terminalCount: 1 } },
    // The admitted row shows its spinner only after the loading delay.
    interact: settle,
    render: () => (
      <div className="bg-sidebar">
        <ChecksPanelPositiveReview
          detachedHeadDisplay={null}
          reviewShortLabel="PR"
          providerName="GitHub"
          reviewNumber={options.reviewNumber === undefined ? 7 : options.reviewNumber}
          openReviewUrl={
            options.openReviewUrl === undefined
              ? 'https://github.com/acme/widgets/pull/7'
              : options.openReviewUrl
          }
          refresh={undefined}
          manualRefreshFailed={false}
          manualRetryInFlight={false}
          actionsDisabled={false}
          worktreeId="fixture"
          onRetry={() => Promise.resolve()}
          setRetrying={noop}
        />
      </div>
    )
  }
}

// Rate-gate deadline in a stable local wall time so screenshots stay comparable.
const gate = new Date()
gate.setHours(14, 30, 0, 0)
if (gate.getTime() <= Date.now()) {
  gate.setDate(gate.getDate() + 1)
}

const ROWS: Record<string, PRDetailRecoveryStatus> = {
  queued: { kind: 'waiting' },
  rateGate: { kind: 'paused', notBefore: gate.getTime() },
  admitted: { kind: 'admitted' },
  failed: { kind: 'failed' },
  timeout: { kind: 'timeout' },
  unusable: { kind: 'unusable' },
  oldHost: { kind: 'unsupported' }
}

export const queued = row(ROWS.queued, 320)
export const rateGate = row(ROWS.rateGate, 320)
export const admitted = row(ROWS.admitted, 320)
export const failed = row(ROWS.failed, 320)
export const timeout = row(ROWS.timeout, 320)
export const unusable = row(ROWS.unusable, 320)
export const oldHost = row(ROWS.oldHost, 320)

export const queuedNarrow = row(ROWS.queued, 220)
export const rateGateNarrow = row(ROWS.rateGate, 220)
export const admittedNarrow = row(ROWS.admitted, 220)
export const failedNarrow = row(ROWS.failed, 220)
export const timeoutNarrow = row(ROWS.timeout, 220)
export const unusableNarrow = row(ROWS.unusable, 220)
export const oldHostNarrow = row(ROWS.oldHost, 220)

export const failedClassified = row({ kind: 'failed', errorType: 'auth' }, 320)
export const foundWithoutNumber = row({ kind: 'waiting' }, 320, {
  reviewNumber: null,
  openReviewUrl: null
})

/** Keyboard: Retry keeps focus while aria-disabled during an admitted read. */
export const keyboardRetryFocusAdmitted = defineFixture({
  ...row(ROWS.admitted, 320),
  interact: async (frame) => {
    await settle()
    const retry = Array.from(frame.querySelectorAll('button')).find(
      (button) => button.textContent === 'Retry'
    )
    retry?.focus({ focusVisible: true } as FocusOptions)
    retry?.click()
  }
})
