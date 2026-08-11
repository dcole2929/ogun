import { randomUUID } from 'node:crypto'

/**
 * Ids are uuids everywhere. They cross the runner/server HTTP boundary and end up in
 * URLs, so nothing sequential and nothing that leaks a count.
 */
export const newId = (): string => randomUUID()
