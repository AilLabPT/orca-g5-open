import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeClientTarget } from '../../../../../../shared/runtime-client-target'
import {
  sendPromptWithGuardedPasteAndEnter,
  sendPromptWithLegacyCombinedSend
} from './active-agent-note-send-delivery'

const { callRuntimeRpc } = vi.hoisted(() => ({ callRuntimeRpc: vi.fn() }))
vi.mock('@/runtime/rpc/calls/runtime-rpc-call', () => ({ callRuntimeRpc }))
vi.mock('../paste/agent-paste-draft', () => ({}))

type RpcParams = {
  terminal: string
  text?: string
  enter?: boolean
  expectInputGeneration?: number
}
type Step = 'status' | 'paste' | 'enter' | 'combined'
type Reply = () => unknown

const LOCAL: RuntimeClientTarget = { kind: 'local' }
const READY = { agentStatus: { isRunningAgent: true, status: 'idle' } }
const guarded = { allowLegacyFallback: false }

let log: string[]
/** Replies queued per `handle step`; an unqueued step gets its ordinary accepted answer. */
let replies: Map<string, Reply[]>

function queue(handle: string, step: Step, ...answers: Reply[]): void {
  replies.set(`${handle} ${step}`, answers)
}

function accepted(handle: string, submitDelayMs?: unknown): { send: Record<string, unknown> } {
  return {
    send: {
      handle,
      accepted: true,
      bytesWritten: 1,
      ...(submitDelayMs === undefined ? {} : { submitDelayMs })
    }
  }
}

/** Params of every `terminal.send` issued so far for `step`. */
function sent(step: 'paste' | 'enter'): RpcParams[] {
  return callRuntimeRpc.mock.calls
    .filter(([, method]) => method === 'terminal.send')
    .map(([, , params]): RpcParams => params)
    .filter((params) => (step === 'paste' ? !!params.text : !params.text))
}

function rpcError(code: string): Error {
  return Object.assign(new Error(code), { code })
}

function deferred(): { promise: Promise<unknown>; resolve: (value: unknown) => void } {
  let resolve: (value: unknown) => void = () => {}
  const promise = new Promise<unknown>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

beforeEach(() => {
  vi.useFakeTimers()
  log = []
  replies = new Map()
  callRuntimeRpc.mockImplementation(
    async (target: RuntimeClientTarget, method: string, params: RpcParams) => {
      const step: Step =
        method === 'terminal.agentStatus'
          ? 'status'
          : params.text && params.enter
            ? 'combined'
            : params.text
              ? 'paste'
              : 'enter'
      const runtime = target.kind === 'environment' ? `${target.environmentId}/` : ''
      log.push(`${runtime}${params.terminal} ${step}`)
      const queued = replies.get(`${params.terminal} ${step}`)?.shift()
      if (queued) {
        return queued()
      }
      return step === 'status' ? READY : accepted(params.terminal)
    }
  )
})

afterEach(() => {
  vi.useRealTimers()
  callRuntimeRpc.mockReset()
})

describe('guarded paste then Enter', () => {
  it('holds Enter for the wait the host names', async () => {
    queue('term_1', 'paste', () => accepted('term_1', 3_516))
    const sending = sendPromptWithGuardedPasteAndEnter(LOCAL, 'term_1', 'note', guarded)
    await vi.advanceTimersByTimeAsync(3_515)
    expect(log).toEqual(['term_1 status', 'term_1 paste'])
    await vi.advanceTimersByTimeAsync(1)
    await expect(sending).resolves.toEqual({ status: 'sent' })
    expect(log).toEqual(['term_1 status', 'term_1 paste', 'term_1 status', 'term_1 enter'])
  })

  it.each([
    ['no wait', undefined],
    ['NaN', Number.NaN],
    ['a negative wait', -5],
    ['a string', '900']
  ])('keeps the fixed 50 ms when the host names %s', async (_name, submitDelayMs) => {
    queue('term_1', 'paste', () => accepted('term_1', submitDelayMs))
    const sending = sendPromptWithGuardedPasteAndEnter(LOCAL, 'term_1', 'note', guarded)
    await vi.advanceTimersByTimeAsync(49)
    expect(log).toEqual(['term_1 status', 'term_1 paste'])
    await vi.advanceTimersByTimeAsync(1)
    await expect(sending).resolves.toEqual({ status: 'sent' })
    expect(log.at(-1)).toBe('term_1 enter')
  })

  it('sends no Enter after a refused paste', async () => {
    queue('term_1', 'paste', () => ({
      send: { handle: 'term_1', accepted: false, bytesWritten: 0, refusedReason: 'permission' }
    }))
    const sending = sendPromptWithGuardedPasteAndEnter(LOCAL, 'term_1', 'note', guarded)
    await vi.advanceTimersByTimeAsync(60_000)
    await expect(sending).resolves.toEqual({
      status: 'permission',
      code: 'terminal-send-permission'
    })
    expect(log).toEqual(['term_1 status', 'term_1 paste'])
  })

  it('sends no Enter after a paste with no answer, and lets the next send through', async () => {
    queue('term_1', 'paste', () => Promise.reject(rpcError('runtime_timeout')))
    const failed = sendPromptWithGuardedPasteAndEnter(LOCAL, 'term_1', 'first', guarded)
    const next = sendPromptWithGuardedPasteAndEnter(LOCAL, 'term_1', 'second', guarded)
    await expect(failed).rejects.toThrow('runtime_timeout')
    await vi.advanceTimersByTimeAsync(60_000)
    await expect(next).resolves.toEqual({ status: 'sent' })
    expect(log).toEqual([
      'term_1 status',
      'term_1 paste',
      'term_1 status',
      'term_1 paste',
      'term_1 status',
      'term_1 enter'
    ])
  })

  it('sends no Enter when the handle went stale during the wait', async () => {
    queue(
      'term_1',
      'status',
      () => READY,
      () => Promise.reject(rpcError('terminal_handle_stale'))
    )
    const sending = sendPromptWithGuardedPasteAndEnter(LOCAL, 'term_1', 'note', guarded)
    await vi.advanceTimersByTimeAsync(60_000)
    await expect(sending).resolves.toEqual({
      status: 'partial-submit-failed',
      code: 'terminal_handle_stale'
    })
    expect(log).toEqual(['term_1 status', 'term_1 paste', 'term_1 status'])
  })

  it('sends no Enter when a permission prompt appeared during the wait', async () => {
    queue(
      'term_1',
      'status',
      () => READY,
      () => ({ agentStatus: { isRunningAgent: true, status: 'permission' } })
    )
    const sending = sendPromptWithGuardedPasteAndEnter(LOCAL, 'term_1', 'note', guarded)
    await vi.advanceTimersByTimeAsync(60_000)
    await expect(sending).resolves.toEqual({
      status: 'partial-submit-failed',
      code: 'submit-readiness-lost'
    })
    expect(log).toEqual(['term_1 status', 'term_1 paste', 'term_1 status'])
  })

  it('never repeats an Enter that got no answer', async () => {
    queue('term_1', 'enter', () => Promise.reject(rpcError('runtime_timeout')))
    const failed = sendPromptWithGuardedPasteAndEnter(LOCAL, 'term_1', 'first', guarded)
    const next = sendPromptWithGuardedPasteAndEnter(LOCAL, 'term_1', 'second', guarded)
    const rejected = expect(failed).rejects.toThrow('runtime_timeout')
    await vi.advanceTimersByTimeAsync(60_000)
    await rejected
    await expect(next).resolves.toEqual({ status: 'sent' })
    expect(log.filter((entry) => entry === 'term_1 enter')).toHaveLength(2)
  })
})

describe('a note whose Enter would wait more than 5 s', () => {
  it('is pasted and left unsent, never reported sent', async () => {
    queue('term_1', 'paste', () => accepted('term_1', 181_438))
    const sending = sendPromptWithGuardedPasteAndEnter(LOCAL, 'term_1', 'note', guarded)
    await vi.advanceTimersByTimeAsync(0)
    await expect(sending).resolves.toEqual({ status: 'pasted' })
    await vi.advanceTimersByTimeAsync(200_000)
    expect(log).toEqual(['term_1 status', 'term_1 paste'])
  })

  it('still gets its Enter at exactly 5 s, and none one millisecond over', async () => {
    queue(
      'term_1',
      'paste',
      () => accepted('term_1', 5_000),
      () => accepted('term_1', 5_001)
    )
    const held = sendPromptWithGuardedPasteAndEnter(LOCAL, 'term_1', 'first', guarded)
    await vi.advanceTimersByTimeAsync(5_000)
    await expect(held).resolves.toEqual({ status: 'sent' })
    expect(sent('enter')).toHaveLength(1)
    const left = sendPromptWithGuardedPasteAndEnter(LOCAL, 'term_1', 'second', guarded)
    await vi.advanceTimersByTimeAsync(0)
    await expect(left).resolves.toEqual({ status: 'pasted' })
    await vi.advanceTimersByTimeAsync(60_000)
    expect(sent('enter')).toHaveLength(1)
  })

  it('keeps the terminal until its paste settles, so the next Enter lands after it', async () => {
    queue('term_1', 'paste', () => accepted('term_1', 8_000))
    const left = sendPromptWithGuardedPasteAndEnter(LOCAL, 'term_1', 'long', guarded)
    const next = sendPromptWithGuardedPasteAndEnter(LOCAL, 'term_1', 'short', guarded)
    await vi.advanceTimersByTimeAsync(0)
    await expect(left).resolves.toEqual({ status: 'pasted' })
    await vi.advanceTimersByTimeAsync(7_999)
    expect(log).toEqual(['term_1 status', 'term_1 paste'])
    await vi.advanceTimersByTimeAsync(1 + 50)
    await expect(next).resolves.toEqual({ status: 'sent' })
  })
})

describe('the Enter for one paste', () => {
  it('names the paste it belongs to, so the host can refuse it over newer input', async () => {
    queue('term_1', 'paste', () => ({
      send: { handle: 'term_1', accepted: true, bytesWritten: 1, inputGeneration: 7 }
    }))
    const sending = sendPromptWithGuardedPasteAndEnter(LOCAL, 'term_1', 'note', guarded)
    await vi.advanceTimersByTimeAsync(50)
    await expect(sending).resolves.toEqual({ status: 'sent' })
    expect(sent('enter')[0]?.expectInputGeneration).toBe(7)
  })
})

describe('sends to one terminal', () => {
  it('give up unwritten after 20 s of the terminal being taken', async () => {
    queue('term_1', 'paste', () => accepted('term_1', 90_540))
    const added = sendPromptWithGuardedPasteAndEnter(LOCAL, 'term_1', 'quote', {
      ...guarded,
      submit: false
    })
    const waiting = sendPromptWithGuardedPasteAndEnter(LOCAL, 'term_1', 'note', guarded)
    await vi.advanceTimersByTimeAsync(0)
    await expect(added).resolves.toEqual({ status: 'sent' })
    await vi.advanceTimersByTimeAsync(20_000)
    await expect(waiting).resolves.toEqual({ status: 'not-ready', code: 'terminal-send-busy' })
    expect(log).toEqual(['term_1 status', 'term_1 paste'])
    // The paste still settles for its whole time; a send after that goes through.
    const early = sendPromptWithGuardedPasteAndEnter(LOCAL, 'term_1', 'early', guarded)
    await vi.advanceTimersByTimeAsync(20_000)
    await expect(early).resolves.toEqual({ status: 'not-ready', code: 'terminal-send-busy' })
    await vi.advanceTimersByTimeAsync(50_540)
    const later = sendPromptWithGuardedPasteAndEnter(LOCAL, 'term_1', 'later', guarded)
    await vi.advanceTimersByTimeAsync(50)
    await expect(later).resolves.toEqual({ status: 'sent' })
  })

  it('finish one send, Enter included, before the next one starts', async () => {
    queue(
      'term_1',
      'paste',
      () => accepted('term_1', 3_516),
      () => accepted('term_1', 501)
    )
    const first = sendPromptWithGuardedPasteAndEnter(LOCAL, 'term_1', 'first', guarded)
    const second = sendPromptWithGuardedPasteAndEnter(LOCAL, 'term_1', 'second', guarded)
    await vi.advanceTimersByTimeAsync(3_515)
    expect(log).toEqual(['term_1 status', 'term_1 paste'])
    await vi.advanceTimersByTimeAsync(1)
    await expect(first).resolves.toEqual({ status: 'sent' })
    await vi.advanceTimersByTimeAsync(501)
    await expect(second).resolves.toEqual({ status: 'sent' })
    expect(log).toEqual([
      'term_1 status',
      'term_1 paste',
      'term_1 status',
      'term_1 enter',
      'term_1 status',
      'term_1 paste',
      'term_1 status',
      'term_1 enter'
    ])
  })

  it('keep a paste left unsent settling before the next send starts', async () => {
    queue('term_1', 'paste', () => accepted('term_1', 3_516))
    const added = sendPromptWithGuardedPasteAndEnter(LOCAL, 'term_1', 'quote', {
      ...guarded,
      submit: false
    })
    const next = sendPromptWithGuardedPasteAndEnter(LOCAL, 'term_1', 'note', guarded)
    await vi.advanceTimersByTimeAsync(0)
    await expect(added).resolves.toEqual({ status: 'sent' })
    await vi.advanceTimersByTimeAsync(3_515)
    expect(log).toEqual(['term_1 status', 'term_1 paste'])
    await vi.advanceTimersByTimeAsync(1 + 50)
    await expect(next).resolves.toEqual({ status: 'sent' })
  })

  it('issue an older host one combined send at a time', async () => {
    const held = deferred()
    queue('term_1', 'combined', () => held.promise)
    const first = sendPromptWithLegacyCombinedSend(LOCAL, 'term_1', 'first')
    const second = sendPromptWithLegacyCombinedSend(LOCAL, 'term_1', 'second')
    await vi.advanceTimersByTimeAsync(15_000)
    expect(log).toEqual(['term_1 combined'])
    held.resolve(accepted('term_1'))
    await expect(first).resolves.toEqual({ status: 'sent' })
    await expect(second).resolves.toEqual({ status: 'sent' })
    expect(log).toEqual(['term_1 combined', 'term_1 combined'])
  })
})

describe('sends to different terminals', () => {
  it('do not wait on each other', async () => {
    queue('term_1', 'paste', () => accepted('term_1', 3_516))
    queue('term_2', 'paste', () => accepted('term_2', 501))
    const slow = sendPromptWithGuardedPasteAndEnter(LOCAL, 'term_1', 'slow', guarded)
    const quick = sendPromptWithGuardedPasteAndEnter(LOCAL, 'term_2', 'quick', guarded)
    await vi.advanceTimersByTimeAsync(501)
    await expect(quick).resolves.toEqual({ status: 'sent' })
    expect(log).not.toContain('term_1 enter')
    await vi.advanceTimersByTimeAsync(3_015)
    await expect(slow).resolves.toEqual({ status: 'sent' })
  })

  it('treat one handle on two runtimes as two terminals', async () => {
    queue(
      'term_1',
      'paste',
      () => accepted('term_1', 3_516),
      () => accepted('term_1', 501)
    )
    const slow = sendPromptWithGuardedPasteAndEnter(LOCAL, 'term_1', 'slow', guarded)
    const quick = sendPromptWithGuardedPasteAndEnter(
      { kind: 'environment', environmentId: 'env-1' },
      'term_1',
      'quick',
      guarded
    )
    await vi.advanceTimersByTimeAsync(501)
    await expect(quick).resolves.toEqual({ status: 'sent' })
    expect(log).toContain('env-1/term_1 enter')
    expect(log).not.toContain('term_1 enter')
    await vi.advanceTimersByTimeAsync(3_015)
    await expect(slow).resolves.toEqual({ status: 'sent' })
  })
})
