import { loadLocalConfig } from '@ogun/core'

/**
 * On the machine running the control plane, the CLI reads the admin token from the same
 * local file the server writes — so neither of them needs it in the environment, and
 * there is no step where you copy a secret from one command into another.
 *
 * From elsewhere, OGUN_TOKEN. A control plane on localhost needs nothing at all.
 */
export async function authHeaders(): Promise<Record<string, string>> {
  const token = process.env.OGUN_TOKEN?.trim() || (await loadLocalConfig().catch(() => null))?.server.token
  return token ? { authorization: `Bearer ${token}` } : {}
}
