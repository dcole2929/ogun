import { EventEmitter } from 'node:events'
import type { RunEvent } from '@ogun/core'

/**
 * In-process fan-out from event ingest to connected SSE clients. Deliberately not a
 * queue: a browser that isn't watching a run doesn't need its events, and one that
 * connects late backfills from postgres before subscribing (§5.1).
 */
export type EventBus = {
  publish: (runId: string, events: RunEvent[]) => void
  subscribe: (runId: string, fn: (events: RunEvent[]) => void) => () => void
}

export function createEventBus(): EventBus {
  const emitter = new EventEmitter()
  emitter.setMaxListeners(0)
  return {
    publish: (runId, events) => emitter.emit(runId, events),
    subscribe: (runId, fn) => {
      emitter.on(runId, fn)
      return () => emitter.off(runId, fn)
    },
  }
}
