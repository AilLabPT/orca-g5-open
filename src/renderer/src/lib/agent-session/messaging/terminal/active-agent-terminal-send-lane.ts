import type { RuntimeClientTarget } from '../../../../../../shared/runtime-client-target'

const laneTails = new Map<string, Promise<void>>()

/** Runs one terminal's sends one at a time, in arrival order, so a send's Enter cannot land inside
 *  another send's paste. Orders this window's calls only: a send that rejects frees the lane while
 *  the host may still be working on it. `holdLane` keeps the lane after the send's result is out.
 *  A send that cannot start within `maxWaitMs` never runs: it answers `{ laneBusy: true }`. */
export async function runInTerminalSendLane<T>(
  runtimeTarget: RuntimeClientTarget,
  terminalHandle: string,
  send: (holdLane: (until: Promise<void>) => void) => Promise<T>,
  maxWaitMs: number
): Promise<T | { laneBusy: true }> {
  const runtime =
    runtimeTarget.kind === 'environment' ? `environment:${runtimeTarget.environmentId}` : 'local'
  const key = `${runtime}\n${terminalHandle}`
  const previous = laneTails.get(key) ?? Promise.resolve()
  let release = (): void => {}
  const tail = new Promise<void>((resolve) => {
    release = resolve
  })
  laneTails.set(key, tail)
  void tail.then(() => {
    if (laneTails.get(key) === tail) {
      laneTails.delete(key)
    }
  })
  if (!(await turnCameWithin(previous, maxWaitMs))) {
    // Leaving the queue must not let the send behind overtake the one ahead.
    void previous.then(release)
    return { laneBusy: true }
  }
  let held: Promise<void> | undefined
  try {
    return await send((until) => {
      held = until
    })
  } catch (error) {
    held = undefined
    throw error
  } finally {
    void Promise.resolve(held).then(release)
  }
}

function turnCameWithin(previous: Promise<void>, maxWaitMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), maxWaitMs)
    void previous.then(() => {
      clearTimeout(timer)
      resolve(true)
    })
  })
}
