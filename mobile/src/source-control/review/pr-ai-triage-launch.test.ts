import { describe, expect, it } from 'vitest'
import type { AgentLaunchResult } from '../../../../src/shared/agent-launch/contracts/agent-launch-intent'
import { launchedAgentOpens } from './pr-ai-triage-launch'

function result(outcome: AgentLaunchResult['outcome']): AgentLaunchResult {
  return {
    outcome,
    worktreeId: 'wt-a',
    receipt: {
      mode: outcome.kind,
      preferred: outcome.kind,
      reason: 'requested',
      detail: 'Requested.'
    }
  }
}

describe('launchedAgentOpens', () => {
  it('names a chat by the tab the host reported', () => {
    expect(
      launchedAgentOpens(
        result({ kind: 'structured', sessionId: 'claude:s-1', handle: 'h', tabId: 'tab-9' })
      )
    ).toEqual({
      worktreeId: 'wt-a',
      paneKey: 'tab-9:bed2d6f0-fa2d-4e3a-a034-b6a282f278f1'
    })
  })

  it('derives a chat’s tab from its session on a host that reports none', () => {
    expect(
      launchedAgentOpens(result({ kind: 'structured', sessionId: 'claude:s-1', handle: 'h' }))
    ).toEqual({
      worktreeId: 'wt-a',
      paneKey: 'structured-agent-session-claude:s-1:bed2d6f0-fa2d-4e3a-a034-b6a282f278f1'
    })
  })

  it('names a terminal by its pane, or by none when the host reported none', () => {
    expect(
      launchedAgentOpens(result({ kind: 'terminal', handle: 'h', paneKey: 'tab-1:leaf-1' }))
    ).toEqual({ worktreeId: 'wt-a', paneKey: 'tab-1:leaf-1' })
    expect(launchedAgentOpens(result({ kind: 'terminal', handle: 'h' }))).toEqual({
      worktreeId: 'wt-a',
      paneKey: null
    })
  })
})
