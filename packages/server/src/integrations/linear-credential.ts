import { readProjectSecret } from '@ogun/core'
import type { ProjectSecret } from '@ogun/core'
import { usableGrant } from '../foreman/linear-grant.ts'
import type { LinearCredential } from './linear.ts'

/**
 * A project slug in, a credential Linear will accept out — or the reason there isn't one.
 *
 * This was `pollSources`'s preamble and it moved here the moment a second caller needed
 * it. The second caller is the Sources editor asking Linear what the workspace's teams,
 * statuses and labels are called, and the rule it must not re-decide is ADR-0014's: **an
 * OAuth grant wins over a personal API key.** A project can hold both — connecting does
 * not delete the key — so two call sites choosing independently is two different answers
 * to "which credential is live", and the one that loses is whichever an operator is not
 * looking at when they rotate something.
 *
 * The three states are `usableGrant`'s, deliberately, and they are not collapsed. A poll
 * writes `refused` and `failed` into different ledger rows because the remedies differ; a
 * request a person is waiting on prints the detail beside an empty picker. Neither reader
 * can recover the distinction once it is one string, so it is never made into one here.
 */
export type ProjectCredential =
  | { state: 'ready'; credential: LinearCredential }
  /** A fact about the configuration that will still be true in five minutes. */
  | { state: 'refused'; detail: string }
  /** A fact about this moment — the network, Linear, or this machine's store. */
  | { state: 'failed'; detail: string; kind: 'transport' | 'local' }

export type CredentialDeps = {
  secrets?: typeof readProjectSecret
  grant?: typeof usableGrant
}

export async function projectLinearCredential(
  slug: string,
  deps: CredentialDeps = {},
): Promise<ProjectCredential> {
  /**
   * Which credential, decided in `readProjectSecret` and nowhere else (ADR-0014).
   *
   * An OAuth grant wins over a personal API key, and the reasoning for that lives with the
   * function that applies it rather than being restated — the point of putting precedence
   * in one place is that this file cannot hold a second opinion about it.
   */
  const key = await (deps.secrets ?? readProjectSecret)(slug, 'linear')

  if (key.state === 'granted') {
    /**
     * The refresh, immediately before the request that needs the token, because a token
     * that lasts 24 hours and a poller that wakes at 3am never coincide by accident. See
     * `linear-grant.ts` for why this is not a timer and not a reaction to a 401.
     */
    const usable = await (deps.grant ?? usableGrant)(slug, 'linear', key.grant)
    if (usable.state === 'refused') return { state: 'refused', detail: usable.detail }
    if (usable.state === 'failed') {
      // Taken from the grant rather than guessed at here. `usableGrant` is the only thing
      // that knows whether the token endpoint was unreachable or the write to this
      // machine's store failed, and those two want opposite advice.
      return { state: 'failed', detail: usable.detail, kind: usable.kind }
    }
    return { state: 'ready', credential: usable.credential }
  }

  if (key.state === 'present') {
    /**
     * `expose()` at the wire and nowhere else — the one place per consumer ADR-0012 asks
     * for. The value goes straight into the client that puts it in a header; it is never
     * held in a variable this function logs, records, or puts in a `source_polls` row.
     */
    return { state: 'ready', credential: { kind: 'api-key', token: key.secret.expose() } }
  }

  return { state: 'refused', detail: missingKey(slug, key) }
}

/**
 * The ways a credential can be missing, each with the sentence that fixes it.
 *
 * Written out per state rather than templated, because the whole value of
 * `readProjectSecret` returning a state per remedy is lost the moment they share a
 * message. The `unreadable` case is the one that matters most and reads least like a
 * credential problem: the store is broken — a config.json mangled by an unrelated edit —
 * and the key is very likely still in it, so telling somebody to go and set one would send
 * them to overwrite a file that is already failing to parse.
 *
 * `unconnected` is the one ADR-0014 added, and it is the same mistake one step further
 * along: an operator who has registered an OAuth application and not finished the
 * authorization has done most of the work, and telling them to paste a personal API key
 * sends them backwards to the credential they were migrating off.
 */
export function missingKey(
  slug: string,
  key: Exclude<ProjectSecret, { state: 'present' } | { state: 'granted' }>,
): string {
  const set = `\`ogun connect linear --project ${slug}\``
  switch (key.state) {
    case 'unconnected':
      return (
        `"${slug}" has a linear oauth application registered (client ${key.clientId}) and ` +
        'nobody has finished the authorization, so there is nothing to poll with. Connect ' +
        `it from Settings, or run \`ogun connect linear --project ${slug}\``
      )
    case 'malformed':
      return (
        `the linear oauth entry for "${slug}" is not a shape this build can read ` +
        `(${key.reason}). The store itself is fine — this one project needs reconnecting`
      )
    case 'absent':
      return `"${slug}" is not connected to linear on this machine — run ${set}`
    case 'empty':
      return (
        `the linear api key for "${slug}" is set to an empty value, which the write path ` +
        `refuses to create — something wrote a blank over it. Run ${set} --api-key again`
      )
    case 'unreadable':
      return (
        `this machine's secret store could not be read (${key.reason}), so the linear key ` +
        `for "${slug}" could not be looked up — it is probably still there, and the store ` +
        'is what needs fixing'
      )
  }
}
