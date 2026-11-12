import type {
  Initialization,
  InitializationOutcome,
  InitializationQueue
} from './browser-host-page-initialization-records'

export function scheduleInitializationQueue(
  queues: Map<symbol, InitializationQueue>,
  token: symbol,
  queue: InitializationQueue,
  run: (operation: Initialization) => Promise<InitializationOutcome>,
  settle: (operation: Initialization, outcome: InitializationOutcome) => void
): void {
  if (queue.scheduled) {
    return
  }
  queue.scheduled = true
  queueMicrotask(() => {
    queue.scheduled = false
    if (queues.get(token) !== queue) {
      return
    }
    while (queue.active < 4 && queue.pending.length) {
      const operation = queue.pending.shift()!
      if (operation.detached || operation.record.operation !== operation) {
        continue
      }
      operation.running = true
      operation.executing = true
      queue.active += 1
      void run(operation).then((outcome) => settle(operation, outcome))
    }
    if (!queue.active && !queue.pending.length) {
      queues.delete(token)
    }
  })
}
