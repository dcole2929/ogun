import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { parse as parseYaml } from 'yaml'
import { CONNECTED_APPS, connectionHosts, namesConnectionHost } from '../src/connections.ts'
import { egressSchema, workerSchema } from '../src/config/index.ts'

/**
 * How a worker declares that its skill may call a connected application, and — mostly —
 * how it cannot get one by accident.
 *
 * The naive version of this feature has no config surface at all: `api.linear.app` goes on
 * the gateway's standing allowlist and every worker can reach it. That version passes every
 * test about Linear working. What it gets wrong is that `adversarial-review` is pointed at
 * untrusted repository content on purpose, and would then have a credentialed path to the
 * project's issue tracker with nothing anywhere recording that it had been given one.
 *
 * So the assertions below are about the default (nothing), about the two ways of asking for
 * a connection that cannot work, and about the mistake a person actually makes first —
 * writing the host into `egress:` and expecting it to authenticate.
 */

const worker = (yaml: string) => workerSchema.parse(parseYaml(yaml))
const refusal = (yaml: string): string => {
  const result = workerSchema.safeParse(parseYaml(yaml))
  assert.equal(result.success, false, 'expected this worker to be refused')
  return result.success ? '' : result.error.issues.map((i) => i.message).join(' | ')
}

// ── the default ────────────────────────────────────────────────────────────

/**
 * A worker that says nothing has no connection, and the field is *absent* rather than an
 * empty array. Those read the same at every call site that matters, and only the first
 * survives being round-tripped back into yaml by the UI without inventing a line the
 * operator did not write.
 */
test('a worker that says nothing about connections has none', () => {
  const parsed = worker(`skill: adversarial-review
runtime: claude
permissions: reviewer
sandbox: container`)
  assert.equal(parsed.connections, undefined)
})

test('a worker can declare the applications its skill calls', () => {
  const parsed = worker(`skill: ticket-work
sandbox: container
connections: [linear]`)
  assert.deepEqual(parsed.connections, ['linear'])
})

/**
 * A closed set, not `string[]`. A name this build does not recognise has no safe
 * interpretation — dropped it is a worker that silently loses its connection, honoured it
 * is a host lookup that returns nothing today and something the day somebody adds a table
 * entry. The refusal says which names exist.
 */
test('an application this build does not know is refused at parse, not at 3am', () => {
  const message = refusal(`skill: ticket-work
sandbox: container
connections: [jira]`)
  assert.match(message, /linear/)
})

// ── the two ways of asking for one that cannot work ────────────────────────

/**
 * `egress: open` bypasses the gateway entirely (ADR-0010's named escape hatch), so there is
 * nothing on that path to splice a credential in at. Left to parse, the config would carry
 * a claim in the opposite direction to what it does: `connections: [linear]` reads as a
 * *narrowing* — "this worker may reach one extra application" — sitting beside unrestricted
 * internet and a real mounted model credential.
 */
test('`egress: open` and a connection cannot be asked for together', () => {
  const message = refusal(`skill: ticket-work
sandbox: container
egress: open
connections: [linear]`)
  assert.match(message, /gateway/)
})

test('`egress: none` and a connection cannot be asked for together', () => {
  assert.match(
    refusal(`skill: ticket-work
sandbox: container
egress: none
connections: [linear]`),
    /airgap/,
  )
})

/**
 * Refused rather than dropped-with-a-note, which is how a worktree treats `egress:`.
 *
 * The difference is that there is nothing to protect. A worktree agent runs as the runner,
 * on the runner's network, with read access to the runner's home — which is where
 * `~/.ogun/config.json` and the project's grant live. Injecting a credential into a process
 * that can already open the file it came from is theatre, and a note saying "not applied"
 * would still leave the config claiming a protection that was never available.
 */
test('a worktree worker cannot declare a connection at all', () => {
  const message = refusal(`skill: ticket-work
sandbox: worktree
connections: [linear]`)
  assert.match(message, /sandbox: container/)
})

// ── the mistake a person makes first ───────────────────────────────────────

/**
 * `egress: [api.linear.app]` is the obvious thing to write, and it half works: the host
 * lands on the allowlist, the request goes out carrying the container's placeholder, and
 * Linear answers `AUTHENTICATION_ERROR`. An operator reads that as "Linear rejected the
 * credential" and rotates a key that was never sent.
 *
 * Refused at parse because that is the only place the failure can be named cheaply — the
 * alternative is an explanation that arrives inside an agent transcript at 3am.
 */
test('a connection host written into egress is refused, and names the field that works', () => {
  const result = egressSchema.safeParse(['api.linear.app'])
  assert.equal(result.success, false)
  const message = result.success ? '' : result.error.issues.map((i) => i.message).join(' | ')
  assert.match(message, /connections: \[linear\]/)
})

/**
 * Only exact names, and only through normalization. `linear.app` is Linear's marketing
 * site and a perfectly legitimate `egress:` entry; refusing it would be a rule that fires
 * on something it was not written for.
 */
test('a host that merely resembles a connection host is an ordinary egress entry', () => {
  assert.equal(namesConnectionHost('api.linear.app'), true)
  assert.equal(namesConnectionHost('API.Linear.App.'), true)
  assert.equal(namesConnectionHost('linear.app'), false)
  assert.equal(namesConnectionHost('evil-api.linear.app'), false)
  assert.equal(egressSchema.safeParse(['linear.app']).success, true)
})

// ── the table ──────────────────────────────────────────────────────────────

/**
 * Exact names, never a wildcard. This table decides where a real workspace credential is
 * allowed to go, and `*.linear.app` would hand it to every subdomain Linear ever adds — a
 * file host, a marketing site, an endpoint that takes a token and returns a session.
 */
test('no connection host is a wildcard', () => {
  for (const host of connectionHosts([...CONNECTED_APPS])) {
    assert.equal(host.includes('*'), false, `${host} must be an exact name`)
  }
})
