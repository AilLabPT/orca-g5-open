import { useEffect } from 'react'
import { useAppStore } from '@/store'
import { isGitHubPRSuppressed } from '../../../../../../shared/worktree/github-pr-suppression'
import {
  prDetailRecoveryContextKey,
  prDetailRecoverySelectionRevision,
  type PRDetailRecoveryContext
} from '@/store/github/pull-requests/pr-detail-recovery-context'
import type { ChecksPanelContextState } from '../use-checks-panel-context-state'
import type { ChecksPanelControllerState } from '../use-checks-panel-controller-state'
import type { ChecksPanelReviewState } from '../use-checks-panel-review-state'

type Model = Pick<ChecksPanelControllerState, 'activeWorktree' | 'branch' | 'repo'> &
  Pick<
    ChecksPanelContextState,
    'hostedReview' | 'hostedReviewCacheKey' | 'isFolder' | 'linkedPR' | 'pr' | 'suppressedGitHubPR'
  > &
  Pick<
    ChecksPanelReviewState,
    'checksPanelReviewLookupResult' | 'hostedReviewCreation' | 'isGitHubReviewContext'
  >

function recoveryContext(model: Model): PRDetailRecoveryContext | null {
  const { activeWorktree: worktree, branch, repo, linkedPR } = model
  const lookup = model.checksPanelReviewLookupResult
  const positive =
    lookup.state === 'positive_unresolved' ||
    model.hostedReviewCreation?.blockedReason === 'existing_review'
  const number = lookup.reviewNumber ?? model.hostedReviewCreation?.review?.number ?? null
  if (
    !worktree ||
    !repo ||
    !branch ||
    model.isFolder ||
    !model.isGitHubReviewContext ||
    model.hostedReview?.provider === 'gitlab' ||
    !positive ||
    model.pr !== null ||
    number === null ||
    (linkedPR !== null && number !== linkedPR) ||
    isGitHubPRSuppressed({ linkedPR, suppressedGitHubPR: model.suppressedGitHubPR }, number)
  ) {
    return null
  }
  return {
    worktreeId: worktree.id,
    repoId: repo.id,
    repoPath: repo.path,
    branch,
    headOid: worktree.head ?? null,
    linkedPRNumber: linkedPR,
    hintPRNumber: linkedPR === null ? number : null,
    hostedReviewCacheKey: model.hostedReviewCacheKey,
    selectionRevision: prDetailRecoverySelectionRevision(worktree)
  }
}

/** The visible Checks panel asks the store for one automatic detail read per context and exposure. */
export function useChecksPanelPRDetailRecovery(model: Model): void {
  const notePanelVisible = useAppStore((s) => s.notePRDetailRecoveryPanelVisible)
  const reconcile = useAppStore((s) => s.reconcileGitHubPRDetails)
  useEffect(() => {
    notePanelVisible(true)
    return () => notePanelVisible(false)
  }, [notePanelVisible])
  const context = recoveryContext(model)
  const contextKey = context ? prDetailRecoveryContextKey(context) : null
  useEffect(() => {
    reconcile(context)
    // The key captures every field the store submits; context identity changes each render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [contextKey, reconcile])
}
