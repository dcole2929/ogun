import { z } from 'zod'
import type { ChangeComment, ChangeRequest } from '@ogun/core'

/**
 * GitHub, behind one seam — the second source kind (§4.13, ADR-0013).
 *
 * Built to the same rules as `linear.ts` and for the same reasons, so the differences are
 * the only part worth reading:
 *
 * **It is REST, not GraphQL.** Linear has one endpoint and a schema, so one document
 * answers the whole poll. The three things a change request is made of — the pull
 * requests, their reviews, their comments — are three REST collections, and GitHub's
 * GraphQL would answer them in one query at the cost of a token with different scopes
 * than the one `gh` already issues. The poll is bounded and infrequent; the extra round
 * trips are cheaper than a second credential story.
 *
 * **Read-only by construction, the same way.** Every path this file can build is a `GET`,
 * the method is not a parameter of anything, and nothing here takes a body. Ogun comments
 * on a pull request through the *runner's* publisher, never from the control plane, so a
 * client that could `POST` would be a second route to writing that no ADR covers.
 *
 * **The credential never enters a sandbox.** It is read from the per-project secret store
 * by the poll and used in one header (ADR-0012). It is not the gateway's
 * `OGUN_GATEWAY_GITHUB_TOKEN`, which is a different value for a different consumer.
 */

export const GITHUB_API = 'https://api.github.com'

/**
 * How a project authenticates to GitHub, as a value rather than a boolean.
 *
 * Two shapes, and unlike Linear's they agree about the header — both are `Bearer`. They
 * are kept apart anyway, because what differs is *lifetime and identity*: a personal
 * token is a human's, lasts until revoked, and makes Ogun's pull requests indistinguishable
 * from that human's own; an app installation token belongs to Ogun, expires in an hour,
 * and is what makes "opened by Ogun" a fact rather than a branch-prefix guess.
 *
 * `describe` is here for the reason `describeCredential` is there: when a poll 401s the
 * only useful first question is which credential GitHub rejected, and a project can hold
 * both.
 */
export type GithubCredential =
  | { kind: 'token'; token: string; login: string }
  | { kind: 'app'; token: string; login: string; installationId: number }

export const describeGithubCredential = (c: GithubCredential): string =>
  c.kind === 'app'
    ? `the app installation token for installation ${c.installationId}`
    : `the personal access token for ${c.login}`

/**
 * GitHub could not answer, and which kind of "could not" it was.
 *
 * The same three `LinearUnavailable` draws, because the remedies are the same three and
 * nothing downstream can tell them apart once they are one string. `ratelimited` is worth
 * more here than there: GitHub's secondary rate limits are easy to reach with a poll that
 * fans out over pull requests, and they pass on their own.
 */
export class GithubUnavailable extends Error {
  readonly kind: 'auth' | 'ratelimited' | 'transport'
  constructor(kind: 'auth' | 'ratelimited' | 'transport', message: string) {
    super(message)
    this.name = 'GithubUnavailable'
    this.kind = kind
  }
}

/**
 * The response shapes, parsed rather than trusted.
 *
 * Narrow on purpose: unknown keys are dropped, so this keeps working when GitHub adds a
 * field and stops when GitHub removes one this depends on. Every `nullable()` is a claim
 * about their schema — `body` is nullable on both a pull request and a review, `label.name`
 * is not, and `user` is nullable on anything authored by a deleted account.
 */
const userSchema = z.object({ login: z.string() }).nullable()

const pullSchema = z.object({
  number: z.number(),
  title: z.string(),
  body: z.string().nullable(),
  html_url: z.string(),
  draft: z.boolean().optional(),
  updated_at: z.string(),
  user: userSchema,
  head: z.object({ ref: z.string(), sha: z.string() }),
  labels: z.array(z.object({ name: z.string() })),
})

const reviewSchema = z.object({
  id: z.number(),
  body: z.string().nullable(),
  state: z.string(),
  submitted_at: z.string().nullable(),
  user: userSchema,
})

const commentSchema = z.object({
  id: z.number(),
  body: z.string().nullable(),
  created_at: z.string(),
  user: userSchema,
})

/**
 * What the poll needs from GitHub, and nothing else.
 *
 * One method, for the reason `LinearApi` gives: a wider interface is surface no test
 * covers and no caller needs, sitting in the file that is supposed to be the narrow part.
 */
export type GithubApi = {
  /**
   * Every open pull request in `repo`, with its reviews and comments attached.
   *
   * Throws `GithubUnavailable` for everything that is not a page of pull requests, on the
   * same terms the Linear client throws: a poll turns that into a recorded failure rather
   * than a crash, because the ledger is the only evidence a source leaves.
   */
  changeRequests(input: { repo: string; perPage: number; maxPages: number }): Promise<ChangeRequest[]>
}

export type GithubHttpOptions = {
  credential: GithubCredential
  /** Overridden only by tests, which point it at a local server. */
  endpoint?: string
  fetch?: typeof globalThis.fetch
}

const asMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err))

export function githubHttp(options: GithubHttpOptions): GithubApi {
  const endpoint = options.endpoint ?? GITHUB_API
  const doFetch = options.fetch ?? globalThis.fetch

  /**
   * One GET, and every way it can fail to be the JSON asked for.
   *
   * `path` is built by this module and never by a caller — `GithubApi` exposes one method
   * that takes a repo and three numbers — so the read-only property holds for the same
   * structural reason the Linear client's does.
   */
  const get = async <T extends z.ZodTypeAny>(path: string, schema: T): Promise<z.infer<T>> => {
    let response: Response
    try {
      response = await doFetch(`${endpoint}${path}`, {
        headers: {
          accept: 'application/vnd.github+json',
          'x-github-api-version': '2022-11-28',
          authorization: `Bearer ${options.credential.token}`,
          // GitHub asks for one and rejects some requests without it. Named for the
          // product rather than the library, because it is what shows up in their logs.
          'user-agent': 'ogun',
        },
      })
    } catch (err) {
      throw new GithubUnavailable('transport', `could not reach ${endpoint}: ${asMessage(err)}`)
    }

    const text = await response.text()

    /**
     * Rate limiting before authentication, because GitHub answers a secondary limit with
     * a **403** carrying a `x-ratelimit-remaining: 0` header — the same status it uses for
     * a token without the scope. Read as auth, that sends an operator to reissue a
     * perfectly good credential; the remedy is to wait.
     */
    if (response.status === 403 || response.status === 429) {
      const remaining = response.headers.get('x-ratelimit-remaining')
      const reset = response.headers.get('x-ratelimit-reset')
      if (response.status === 429 || remaining === '0') {
        throw new GithubUnavailable(
          'ratelimited',
          `github rate limit` +
            (reset ? ` until ${new Date(Number(reset) * 1000).toISOString()}` : '') +
            `: ${text.slice(0, 200)}`,
        )
      }
    }

    if (response.status === 401 || response.status === 403) {
      throw new GithubUnavailable(
        'auth',
        `github rejected ${describeGithubCredential(options.credential)}: ` +
          `${response.status} ${text.slice(0, 200)}`,
      )
    }

    if (!response.ok) {
      throw new GithubUnavailable(
        'transport',
        `${response.status} from ${endpoint}${path}: ${text.slice(0, 200)}`,
      )
    }

    try {
      return schema.parse(JSON.parse(text))
    } catch (err) {
      /**
       * A 200 whose body is not the shape asked for. In practice this is a proxy or a
       * maintenance page, and the useful half is a short prefix — the whole thing lands
       * in a database column.
       */
      throw new GithubUnavailable(
        'transport',
        `${endpoint}${path} answered 200 with a body this build cannot read ` +
          `(${asMessage(err)}): ${text.slice(0, 200)}`,
      )
    }
  }

  return {
    async changeRequests({ repo, perPage, maxPages }) {
      const out: ChangeRequest[] = []

      for (let page = 1; page <= maxPages; page++) {
        const pulls = await get(
          `/repos/${repo}/pulls?state=open&sort=updated&direction=desc` +
            `&per_page=${perPage}&page=${page}`,
          z.array(pullSchema),
        )
        if (pulls.length === 0) break

        for (const pull of pulls) {
          /**
           * Reviews and comments are fetched per pull request, which is the cost of REST
           * here. It is bounded by `maxPerPoll`'s sibling `maxPages` above and by the
           * filter running *after* this — the alternative, filtering on labels first and
           * fetching only for survivors, is what a later version should do once there is
           * a repository big enough to notice.
           */
          const [reviews, issueComments, inlineComments] = await Promise.all([
            get(`/repos/${repo}/pulls/${pull.number}/reviews?per_page=100`, z.array(reviewSchema)),
            get(`/repos/${repo}/issues/${pull.number}/comments?per_page=100`, z.array(commentSchema)),
            get(`/repos/${repo}/pulls/${pull.number}/comments?per_page=100`, z.array(commentSchema)),
          ])

          const comments: ChangeComment[] = [
            ...reviews.flatMap((r): ChangeComment[] =>
              // A review with no body is a bare approval or a container for inline
              // comments that are already carried below. It says nothing to act on.
              r.body === null || r.body.trim() === ''
                ? []
                : [
                    {
                      id: `review-${r.id}`,
                      author: r.user?.login ?? 'ghost',
                      body: r.body,
                      createdAt: r.submitted_at ?? pull.updated_at,
                      kind: 'review',
                      state: r.state,
                    },
                  ],
            ),
            ...issueComments.map((c): ChangeComment => ({
              id: `issue-${c.id}`,
              author: c.user?.login ?? 'ghost',
              body: c.body ?? '',
              createdAt: c.created_at,
              kind: 'issue',
            })),
            ...inlineComments.map((c): ChangeComment => ({
              id: `inline-${c.id}`,
              author: c.user?.login ?? 'ghost',
              body: c.body ?? '',
              createdAt: c.created_at,
              kind: 'inline',
            })),
          ].sort((a, b) => a.createdAt.localeCompare(b.createdAt))

          out.push({
            repo,
            number: pull.number,
            title: pull.title,
            body: pull.body ?? '',
            url: pull.html_url,
            headSha: pull.head.sha,
            branch: pull.head.ref,
            author: pull.user?.login ?? 'ghost',
            isDraft: pull.draft ?? false,
            labels: pull.labels.map((l) => l.name),
            comments,
            updatedAt: pull.updated_at,
          })
        }

        if (pulls.length < perPage) break
      }

      return out
    },
  }
}
