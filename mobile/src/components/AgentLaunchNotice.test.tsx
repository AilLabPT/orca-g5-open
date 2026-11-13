import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('react-native', async () => {
  const React = await import('react')
  const host =
    (tag: string) =>
    ({ children, ...props }: { children?: React.ReactNode }) =>
      React.createElement(tag, props, children)
  return {
    View: host('View'),
    Text: host('Text'),
    Pressable: host('Pressable'),
    StyleSheet: { create: (styles: unknown) => styles }
  }
})

vi.mock('../platform/clipboard', () => ({
  useClipboardWriter: () => ({ writeText: () => Promise.resolve() })
}))

vi.mock('../session/agent-launch/launched-agent-opener', () => ({
  useLaunchedAgentOpener: () => () => undefined
}))

const { AgentLaunchNotice } = await import('./AgentLaunchNotice')

function flat(style: unknown): { minHeight?: number } {
  const resolved = typeof style === 'function' ? style({ pressed: false }) : style
  return Object.assign({}, ...[resolved].flat(Infinity).filter(Boolean))
}

let renderer: ReactTestRenderer | null = null

afterEach(() => {
  act(() => renderer?.unmount())
  renderer = null
})

describe('AgentLaunchNotice', () => {
  it('gives Copy prompt and the agent link full-height button tap areas that do not overlap', () => {
    act(() => {
      renderer = create(
        createElement(AgentLaunchNotice, {
          availability: 'available',
          success: null,
          error: "The agent started, but the prompt wasn't sent.",
          warning: null,
          undeliveredPrompt: 'Fix the failing commit',
          opens: { worktreeId: 'wt-a', paneKey: 'tab-1:leaf-1' },
          errorStyle: null
        })
      )
    })
    const controls = renderer!.root.findAll((node) => String(node.type) === 'Pressable')
    expect(controls).toHaveLength(2)
    for (const control of controls) {
      expect(control.props.accessibilityRole).toBe('button')
      expect(flat(control.props.style).minHeight).toBeGreaterThanOrEqual(44)
      // Slop would reach past the 44pt box into the neighbouring control.
      expect(control.props.hitSlop).toBeUndefined()
    }
  })
})
