import { createDb, type Database } from '@ogun/core/db'
import type { EventBus } from './events-bus.ts'
import { createEventBus } from './events-bus.ts'
import { createLocalConfigStore, type ConfigStore } from './config-store.ts'

export type AppContext = {
  db: Database
  bus: EventBus
  /** Whether this control plane is enforcing an admin token, however it was supplied. */
  adminTokenConfigured: boolean
  /**
   * How the control plane edits a project's config.yaml. Local filesystem today; the
   * seam where a hosted control plane would write through the GitHub API instead.
   */
  config: ConfigStore
  close: () => Promise<void>
}

export function createContext(
  config: ConfigStore = createLocalConfigStore(),
  adminTokenConfigured = false,
): AppContext {
  const { db, close } = createDb()
  const bus = createEventBus()
  return { db, bus, config, adminTokenConfigured, close: async () => void (await close()) }
}

export type Env = { Variables: { ctx: AppContext } }
