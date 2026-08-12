/**
 * A control plane on localhost needs no token; one bound wider requires the shared
 * secret it was started with. Same rule for the runner and the CLI.
 */
export const authHeaders = (): Record<string, string> => {
  const token = process.env.OGUN_TOKEN?.trim()
  return token ? { authorization: `Bearer ${token}` } : {}
}
