import { loadLocalConfig } from '@ogun/core'

/**
 * The CLI is an admin client: it defines workers and triggers runs, so it carries the
 * admin token, never a runner's.
 *
 * On the machine running the control plane it reads the same local file the server
 * writes, so neither needs it in the environment. From another machine, set
 * OGUN_ADMIN_TOKEN. A control plane on localhost needs nothing at all.
 */
export async function authHeaders(): Promise<Record<string, string>> {
  const token =
    process.env.OGUN_ADMIN_TOKEN?.trim() ||
    (await loadLocalConfig().catch(() => null))?.server.token
  return token ? { authorization: `Bearer ${token}` } : {}
}
