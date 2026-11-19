import { readProjectSecret } from '@ogun/core'
import type { ProjectSecret } from '@ogun/core'
import { GithubUnavailable, type GithubCredential } from './github.ts'

/**
 * A project slug in, a credential GitHub will accept out — or the reason there isn't one.
 *
 * The shape of `projectLinearCredential`, deliberately, down to the three states: a
 * `refused` is a fact about the configuration that will still be true in five minutes,
 * and a `failed` is a fact about this moment. A poll writes them into different ledger
 * rows because the remedies differ, and neither reader can recover the distinction once
 * it is one string.
 *
 * ### The two identities, and why the seam is here rather than at the call site
 *
 * A personal access token and a GitHub App installation token both go on the wire as
 * `Bearer`, so a caller cannot tell them apart and should not try. What differs is who
 * Ogun *is*:
 *
 *  - **A personal token** makes Ogun indistinguishable from the human who issued it. Its
 *    pull requests are authored by that person, which is why `admitsRequest` has to fall
 *    back to a branch prefix to recognise its own work, and why `loopGuard` filters out
 *    that person's genuine comments along with Ogun's. It works, and it is the path that
 *    needs no setup.
 *  - **An App installation** gives Ogun a login of its own. "Opened by Ogun" becomes a
 *    fact; the loop guard stops eating a human's words; and a formal `CHANGES_REQUESTED`
 *    review becomes available as a trigger, because the author and the reviewer are no
 *    longer the same account.
 *
 * ADR-0014 settled the precedence question for Linear — a grant beats a key, decided in
 * one place — and the same answer holds here for the same reason: a project can hold
 * both, and two call sites choosing independently is two different answers to "which
 * credential is live".
 */
export type ProjectGithubCredential =
  | { state: 'ready'; credential: GithubCredential }
  | { state: 'refused'; detail: string }
  | { state: 'failed'; detail: string; kind: 'transport' | 'local' }

export type GithubCredentialDeps = {
  secrets?: typeof readProjectSecret
  /**
   * How the login behind a token is discovered. Injected so the precedence rules in this
   * file can be tested without a network, which is the half that has no fixture.
   */
  identify?: (token: string) => Promise<string>
}

/**
 * Who a token authenticates as.
 *
 * Asked once per poll rather than stored, for the reason `visibleTeams` is not stored: it
 * is a fact about a credential at one instant, and a stored copy would be consulted later
 * by something that believed it. It matters because `loopGuard` needs the login to know
 * which comments are Ogun's own, and a wrong answer there is a source that feeds itself.
 */
async function githubLogin(token: string): Promise<string> {
  let response: Response
  try {
    response = await fetch('https://api.github.com/user', {
      headers: {
        accept: 'application/vnd.github+json',
        authorization: `Bearer ${token}`,
        'user-agent': 'ogun',
      },
    })
  } catch (err) {
    throw new GithubUnavailable(
      'transport',
      `could not reach github to identify the token: ${err instanceof Error ? err.message : String(err)}`,
    )
  }
  if (!response.ok) {
    throw new GithubUnavailable(
      'auth',
      `github rejected the token when asked who it is: ${response.status}`,
    )
  }
  const body: unknown = JSON.parse(await response.text())
  const login = (body as { login?: unknown }).login
  if (typeof login !== 'string') {
    throw new GithubUnavailable('transport', 'github answered /user without a login')
  }
  return login
}

export async function projectGithubCredential(
  slug: string,
  deps: GithubCredentialDeps = {},
): Promise<ProjectGithubCredential> {
  const key = await (deps.secrets ?? readProjectSecret)(slug, 'github')

  /**
   * The App arm, and it is a refusal rather than a silence.
   *
   * `readProjectSecret` returns `granted` for any project with an OAuth application
   * registered under this name, because that store is generic across integrations. No
   * command writes one for GitHub yet — `ogun connect github` takes `--api-key` only — so
   * this is unreachable today, and it says so plainly rather than falling through to the
   * key beside it. Falling through would be the worse bug of the two: an operator who had
   * connected an App and also left an old token in place would get the token, and their
   * pull requests would keep being authored by a human while the UI said otherwise.
   */
  if (key.state === 'granted') {
    return {
      state: 'refused',
      detail:
        `"${slug}" has a github application registered, and this build authenticates to ` +
        'github with a personal access token only. The app path is not wired yet; until ' +
        `it is, use \`ogun connect github --api-key --project ${slug}\``,
    }
  }

  if (key.state === 'present') {
    /**
     * `expose()` at the wire and nowhere else — the one place per consumer ADR-0012 asks
     * for. The value goes into one header and into `githubLogin`; it is never held in a
     * variable this function logs or records.
     */
    const token = key.secret.expose()
    try {
      const login = await (deps.identify ?? githubLogin)(token)
      return { state: 'ready', credential: { kind: 'token', token, login } }
    } catch (err) {
      /**
       * A token GitHub will not identify is a token it will not poll with either, and
       * the distinction between "rejected" and "could not ask" is the one the ledger
       * needs. `auth` is a fact about the configuration — the token is wrong, and
       * waiting will not fix it — so it refuses rather than fails.
       */
      if (err instanceof GithubUnavailable && err.kind === 'auth') {
        return {
          state: 'refused',
          detail:
            `github rejected the token stored for "${slug}" — run ` +
            `\`ogun connect github --api-key --project ${slug}\` with a current one`,
        }
      }
      return {
        state: 'failed',
        detail: err instanceof Error ? err.message : String(err),
        kind: 'transport',
      }
    }
  }

  return { state: 'refused', detail: missingGithubKey(slug, key) }
}

/**
 * The ways a GitHub credential can be missing, each with the sentence that fixes it.
 *
 * Written out per state rather than templated, for the reason `missingKey` is: the whole
 * value of `readProjectSecret` returning a state per remedy is lost the moment they share
 * a message. `unreadable` is the one that matters most and reads least like a credential
 * problem — the store is broken and the token is very likely still in it, so telling
 * somebody to set one would send them to overwrite a file that is already failing to
 * parse.
 */
function missingGithubKey(
  slug: string,
  key: Exclude<ProjectSecret, { state: 'present' } | { state: 'granted' }>,
): string {
  const set = `\`ogun connect github --api-key --project ${slug}\``
  switch (key.state) {
    case 'unconnected':
      return (
        `"${slug}" has a github application registered (client ${key.clientId}) and nobody ` +
        `has finished the authorization. The app path is not wired yet — use ${set}`
      )
    case 'malformed':
      return (
        `the github entry for "${slug}" is not a shape this build can read (${key.reason}). ` +
        'The store itself is fine — this one project needs reconnecting'
      )
    case 'absent':
      return (
        `"${slug}" has no github credential on this machine, so there is nothing to read ` +
        `its pull requests with — run ${set}`
      )
    case 'empty':
      return (
        `the github token for "${slug}" is set to an empty value, which the write path ` +
        `refuses to create — something wrote a blank over it. Run ${set} again`
      )
    case 'unreadable':
      return (
        `this machine's secret store could not be read (${key.reason}), so the github ` +
        `token for "${slug}" could not be looked up — it is probably still there, and the ` +
        'store is what needs fixing'
      )
  }
}
