import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { after, before, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { LinearUnavailable, linearHttp } from '../src/integrations/linear.ts'
import { fixtureText } from './linear-fixtures.ts'

/**
 * The Linear client, against recorded responses served over a real socket.
 *
 * A local `http.createServer` rather than a stubbed `fetch`, because the things worth
 * proving here live on the wire: the header shape, the fact that one document goes out and
 * only its variables change, and that a 400 carrying `RATELIMITED` is not read as a
 * permanent failure. A stubbed fetch would let all three be asserted against whatever the
 * stub was written to expect, which is the failure mode of a fixture nobody recorded.
 */

type Handler = (req: IncomingMessage, res: ServerResponse, body: string) => void

let server: Server
let endpoint: string
let handler: Handler
/** Every request the client made, so a test can assert what went out as well as what came back. */
let sent: Array<{ headers: NodeJS.Dict<string | string[]>; body: unknown }> = []

before(async () => {
  server = createServer((req, res) => {
    let raw = ''
    req.on('data', (chunk) => {
      raw += chunk
    })
    req.on('end', () => {
      sent.push({ headers: req.headers, body: JSON.parse(raw || '{}') })
      handler(req, res, raw)
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (typeof address === 'string' || address === null) throw new Error('no port')
  endpoint = `http://127.0.0.1:${address.port}/graphql`
})

after(() => {
  server.close()
})

const serving = (status: number, body: string, headers: Record<string, string> = {}): void => {
  handler = (_req, res) => {
    res.writeHead(status, { 'content-type': 'application/json', ...headers })
    res.end(body)
  }
}

const client = (token = 'lin_api_test') =>
  linearHttp({ credential: { kind: 'api-key', token }, endpoint })

/** The same client authenticating with an OAuth grant instead (ADR-0014). */
const oauthClient = (token = 'lin_oauth_test', workspace?: string) =>
  linearHttp({ credential: { kind: 'oauth', token, workspace }, endpoint })

describe('the linear client', () => {
  it('sends the key raw, with no Bearer prefix', async () => {
    /**
     * Linear's two authentication modes share one header and disagree about its shape: a
     * personal API key is `Authorization: <key>`, an OAuth token is
     * `Authorization: Bearer <token>`. Prefixing a personal key is the single most common
     * way to get a rejection out of this API, and it fails as an authentication error
     * rather than as anything that names the cause — so the shape is asserted here rather
     * than discovered on the first machine that ever holds a real key.
     */
    sent = []
    serving(200, await fixtureText('issues-page-2'))
    await client('lin_api_abc123').issues({ filter: { team: { key: { eq: 'ENG' } } }, first: 50 })

    assert.equal(sent[0]?.headers.authorization, 'lin_api_abc123')
  })

  it('sends one fixed query document, varying only its variables', async () => {
    /**
     * The read-only guarantee is structural rather than a promise: the document is a module
     * constant with no parameter behind it, so there is no way to ask this client to send a
     * mutation. Asserting it here means a later refactor that "helpfully" makes the
     * document an argument breaks a test that says why it must not be.
     */
    sent = []
    serving(200, await fixtureText('issues-page-2'))
    await client().issues({ filter: { team: { key: { eq: 'ENG' } } }, first: 50, after: 'cur' })

    const body = sent[0]?.body as { query: string; variables: Record<string, unknown> }
    assert.match(body.query, /^query OgunSourcePoll\(/)
    assert.doesNotMatch(body.query, /mutation/)
    assert.deepEqual(body.variables, {
      filter: { team: { key: { eq: 'ENG' } } },
      first: 50,
      after: 'cur',
    })
  })

  it('reads the blocking end of a blocks relation, not the blocked end', async () => {
    /**
     * The direction of `IssueRelation` is the one thing in this file that is silently
     * invertible. `type: "blocks"` runs *from* the blocker *to* the blocked, so a ticket's
     * blockers arrive under `inverseRelations` — the relations where it is the target.
     * Reading `relations` instead compiles, parses, and produces a filter that excludes
     * every ticket that blocks something while admitting every ticket that is waiting on
     * something: the rule exactly backwards, with no error anywhere.
     *
     * ENG-104 in the fixture is blocked by ENG-90 (started); ENG-105 carries a `blocks`
     * relation from a *completed* issue and a `related` relation, neither of which is a
     * blocker.
     */
    serving(200, await fixtureText('issues-page-1'))
    const { tickets } = await client().issues({ filter: {}, first: 50 })

    const blocked = tickets.find((t) => t.identifier === 'ENG-104')
    assert.deepEqual(blocked?.blockedBy, [{ identifier: 'ENG-90', statusType: 'started' }])

    const resolvedBlocker = tickets.find((t) => t.identifier === 'ENG-105')
    assert.deepEqual(resolvedBlocker?.blockedBy, [
      { identifier: 'ENG-77', statusType: 'completed' },
    ])
  })

  it('normalizes a null description to an empty string', async () => {
    /**
     * `Issue.description` is nullable in the schema, and ENG-102 has none. Left as null it
     * reaches a prompt as the literal text "null" — a small bug that is only ever seen by
     * an agent, in a run nobody is watching.
     */
    serving(200, await fixtureText('issues-page-1'))
    const { tickets } = await client().issues({ filter: {}, first: 50 })

    assert.equal(tickets.find((t) => t.identifier === 'ENG-102')?.description, '')
  })

  it('follows a cursor only while hasNextPage says there is one', async () => {
    /**
     * Linear returns an `endCursor` on the final page too. A client that paged while a
     * cursor was present rather than while `hasNextPage` was true would follow that last
     * cursor forever, re-reading the same tail every poll until `maxPages` stopped it.
     */
    serving(200, await fixtureText('issues-page-1'))
    const first = await client().issues({ filter: {}, first: 50 })
    assert.equal(first.next, 'YXJyYXljb25uZWN0aW9uOjE=')

    serving(200, await fixtureText('issues-page-2'))
    const last = await client().issues({ filter: {}, first: 50 })
    assert.equal(last.next, undefined)
  })

  it('tells a rate limit apart from a broken request, though both are a 400', async () => {
    /**
     * The property that makes this worth a test: Linear answers a rate limit with a **400**
     * and a `RATELIMITED` code in the body. A client switching on the status code alone
     * reads that as "your query is malformed" — a permanent failure — so a poll would
     * record a config error every five minutes while the only correct action was to wait.
     */
    serving(400, await fixtureText('error-ratelimited'), {
      'x-ratelimit-requests-remaining': '0',
    })

    const err = await client()
      .issues({ filter: {}, first: 50 })
      .then(() => null, (e: unknown) => e)

    assert.ok(err instanceof LinearUnavailable)
    assert.equal(err.kind, 'ratelimited')
    assert.match(err.message, /0 requests left/)
  })

  it('reports a rejected key as an auth failure, not as a transport problem', async () => {
    /**
     * The remedies differ and nothing downstream can tell them apart once they are one
     * string (principle 6): an auth failure needs a person to put a new key on this
     * machine, a transport failure needs nothing at all.
     */
    serving(400, await fixtureText('error-authentication'))

    const err = await client()
      .issues({ filter: {}, first: 50 })
      .then(() => null, (e: unknown) => e)

    assert.ok(err instanceof LinearUnavailable)
    assert.equal(err.kind, 'auth')
  })

  it('sends an oauth access token with a Bearer prefix, and a personal key without one', async () => {
    /**
     * The property: one client, two credential shapes, and the shape is decided by the
     * credential rather than by the caller remembering (ADR-0014).
     *
     * What a naive implementation gets wrong is not the code — it is that both mistakes
     * are *silent*. A personal key sent as `Bearer lin_api_…` and an OAuth token sent raw
     * are both well-formed requests, and Linear answers both with the same
     * `AUTHENTICATION_ERROR` it answers a revoked credential with. So the symptom of
     * getting this backwards is indistinguishable from "your key stopped working", which
     * is the failure an operator will spend an afternoon on. Asserting the bytes here is
     * the only place this can be caught, because there is no Linear credential on any
     * machine in this project to find it live.
     */
    sent = []
    serving(200, await fixtureText('issues-page-2'))
    await oauthClient('lin_oauth_zzz').issues({ filter: {}, first: 50 })
    assert.equal(sent[0]?.headers.authorization, 'Bearer lin_oauth_zzz')

    sent = []
    serving(200, await fixtureText('issues-page-2'))
    await client('lin_api_zzz').issues({ filter: {}, first: 50 })
    assert.equal(sent[0]?.headers.authorization, 'lin_api_zzz')
  })

  it('names which credential linear rejected, and never quotes it', async () => {
    /**
     * The property: an auth failure says *which* credential failed, because a project can
     * hold both a personal API key and an OAuth grant at once — the key is the documented
     * fallback and connecting does not remove it (ADR-0014).
     *
     * The naive message is "linear rejected the api key", hard-coded, which is what this
     * client said before there were two shapes. On a project authenticating with a grant
     * that sentence sends an operator to rotate a key nothing reads, and every observation
     * they make afterwards confirms the wrong theory: the poll still fails, the key still
     * looks fine, and nothing anywhere connects the two.
     *
     * The second half is that naming the credential must not become quoting it. A message
     * that helpfully included the last four characters would put part of a live token into
     * `source_polls.detail`, which is a database column the run page renders.
     */
    serving(400, await fixtureText('error-authentication'))

    const err = await oauthClient('lin_oauth_secret_value', 'Acme')
      .issues({ filter: {}, first: 50 })
      .then(() => null, (e: unknown) => e)

    assert.ok(err instanceof LinearUnavailable)
    assert.equal(err.kind, 'auth')
    assert.match(err.message, /oauth access token for Acme/)
    assert.doesNotMatch(err.message, /lin_oauth_secret_value/)

    serving(400, await fixtureText('error-authentication'))
    const keyErr = await client('lin_api_secret_value')
      .issues({ filter: {}, first: 50 })
      .then(() => null, (e: unknown) => e)

    assert.ok(keyErr instanceof LinearUnavailable)
    assert.match(keyErr.message, /personal api key/)
    assert.doesNotMatch(keyErr.message, /lin_api_secret_value/)
  })

  it('does not mistake an html error page for an empty result', async () => {
    /**
     * A proxy or a maintenance page in front of the API returns markup with a 502. Parsed
     * leniently that becomes "zero issues", which a poll would record as a successful look
     * that found nothing — the exact collapse principle 6 forbids, and one that would hide
     * an outage for as long as it lasted.
     */
    handler = (_req, res) => {
      res.writeHead(502, { 'content-type': 'text/html' })
      res.end('<html><body>Bad Gateway</body></html>')
    }

    const err = await client()
      .issues({ filter: {}, first: 50 })
      .then(() => null, (e: unknown) => e)

    assert.ok(err instanceof LinearUnavailable)
    assert.equal(err.kind, 'transport')
    assert.match(err.message, /502/)
  })
})
