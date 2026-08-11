import { createDb, type Database } from '@ogun/core/db'
import type { EventBus } from './events-bus.ts'
import { createEventBus } from './events-bus.ts'

export type AppContext = {
  db: Database
  bus: EventBus
  close: () => Promise<void>
}

export function createContext(): AppContext {
  const { db, close } = createDb()
  const bus = createEventBus()
  return { db, bus, close: async () => void (await close()) }
}

export type Env = { Variables: { ctx: AppContext } }
