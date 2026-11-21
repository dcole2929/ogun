import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import {
  GithubAppError,
  sealSecret,
  type Grant,
  type StoredApplication,
} from '@ogun/core'
import { usableGithubGrant } from '../src/foreman/github-grant.ts'
import { projectGithubCredential } from '../src/integrations/github-credential.ts'

/**
 * Keeping a one-hour installation token alive for a poller that wakes at 3am, and the
 * precedence rule above it.
 *
 * Every test here is about a decision rather than a request: the mint is a stub, because
 * what is being protected is *when* it is called, *what happens to the store when it
 * fails*, and *whether the new token is written before it is used*. The wire itself is
 * `packages/core/test/github-app.test.ts`.
 *
 * **No GitHub App exists for this repository and no private key exists on any machine
 * here**, so none of this has spoken to GitHub. These are the only tests the App arm can
 * have, and they are tests of the rules rather than of the integration.
 */

const HOUR = 60 * 60 * 1000

const grantExpiring = (inMs: number): Grant => ({
  app: 'github:heirchive',
  access: sealSecret('ghs_old'),
  grantType: 'installation',
  expiresAt: Date.now() + inMs,
  obtainedAt: Date.now() - HOUR,
  scopes: ['pull_requests:read'],
  /**
   * The bot login, recorded at connect because it is only obtainable while holding the key
   * — `GET /user` does not work for an installation token. `loopGuard` compares comment
   * authors against it, so a wrong answer here is a source that feeds itself.
   */
  actor: 'ogun[bot]',
  account: { id: '42', name: 'Heirchive', urlKey: 'Heirchive' },
})

const registered: StoredApplication = {
  state: 'present',
  app: {
    name: 'github:heirchive',
    provider: 'github',
    method: 'private_key_jwt',
    appId: '1234567',
    installationId: '98765432',
    privateKey: sealSecret('-----BEGIN PRIVATE KEY-----\nkey\n-----END PRIVATE KEY-----'),
  },
}

const deps = (over: Parameters<typeof usableGithubGrant>[2] = {}) => ({
  readApp: async () => registered,
  store: async () => {},
  mint: async () => ({
    accessToken: 'ghs_fresh',
    expiresAt: Date.now() + HOUR,
    permissions: ['pull_requests:read'],
    repositorySelection: 'all',
  }),
  ...over,
})

// ── when it renews, and when it does not ───────────────────────────────────

/**
 * The property: a token with plenty of life is used as it stands, and the credential
 * carries the **installation id** from the application.
 *
 * The installation id is on the application rather than on the grant — the grant records
 * what came *back*, and the installation is part of what went out — which is why this path
 * reads the application even when it is not going to mint. `describeGithubCredential`
 * prints it when a poll 401s, which is the one moment it matters, and a project can hold
 * both kinds of GitHub credential.
 */
test('a healthy token is used without a mint, and names its installation', async () => {
  let minted = 0
  const usable = await usableGithubGrant(
    'heirchive-api',
    grantExpiring(10 * HOUR),
    deps({
      mint: async () => {
        minted++
        throw new Error('should not have minted')
      },
    }),
  )

  assert.equal(usable.state, 'ready')
  if (usable.state !== 'ready') return
  assert.equal(minted, 0)
  assert.equal(usable.refreshed, false)
  assert.deepEqual(usable.credential, {
    kind: 'app',
    token: 'ghs_old',
    login: 'ogun[bot]',
    installationId: 98765432,
  })
})

/**
 * The property: a token inside the horizon is renewed **before** the request, and the new
 * one is written before it is handed back.
 *
 * The three designs `linear-grant.ts` weighs apply here with more force, because the
 * lifetime is an hour rather than thirty days: a timer refreshes in a process that may not
 * be running, and with a one-hour token "the machine was asleep and it died before the
 * first tick" stops being the edge case and becomes the only case. Reacting to a 401 spends
 * a poll — the request has gone out, the page is lost, and `source_polls` records a failure
 * for a poll that was always going to need one round trip.
 *
 * The horizon is shared with Linear deliberately: ten minutes is what `doctor`, the CLI and
 * the web UI all mean by "expiring", and a second number here would make `doctor` warn
 * about a token the next poll renews by itself.
 */
test('a token inside the horizon is renewed before the request, and written first', async () => {
  const order: string[] = []
  let written: Record<string, unknown> | undefined

  const usable = await usableGithubGrant(
    'heirchive-api',
    // Five minutes left: alive right now, and dead before a paged read finishes.
    grantExpiring(5 * 60 * 1000),
    deps({
      mint: async () => {
        order.push('mint')
        return {
          accessToken: 'ghs_fresh',
          expiresAt: Date.now() + HOUR,
          permissions: ['pull_requests:read', 'contents:read'],
          repositorySelection: 'all',
        }
      },
      store: async (_slug, _provider, grant) => {
        order.push('store')
        written = grant as unknown as Record<string, unknown>
      },
    }),
  )

  assert.equal(usable.state, 'ready')
  if (usable.state !== 'ready') return
  assert.equal(usable.refreshed, true)
  assert.equal(usable.credential.token, 'ghs_fresh')
  assert.deepEqual(order, ['mint', 'store'], 'the token was not written before it was used')

  assert.equal(written?.app, 'github:heirchive', 'so the next renewal can find the key')
  assert.equal(written?.grantType, 'installation')
  assert.equal(written?.refreshToken, undefined, 'there is nothing to rotate')
  // As granted, from the mint response, which is the only place GitHub reports them.
  assert.deepEqual(written?.scopes, ['pull_requests:read', 'contents:read'])
  // Carried forward: the bot login and the account were settled when the App was installed
  // and cannot change under a renewal, so re-asking would be a request a poll does not need.
  assert.equal(written?.actor, 'ogun[bot]')
  assert.deepEqual(written?.account, { id: '42', name: 'Heirchive', urlKey: 'Heirchive' })
})

/**
 * The property: concurrent polls for one project **mint once**.
 *
 * The window is real rather than theoretical: `main.ts` drives `pollSources` from an
 * interval that does not await its callback, so two ticks overlap whenever a poll runs
 * long, and two sources in one project would then both find the same expiring grant.
 *
 * Nothing is spent by a duplicate mint — unlike a rotating refresh token — so this is
 * about not making two requests and two writes where one will do, rather than about
 * correctness. Worth saying, because the Linear version of this test is about correctness
 * and the two should not be read as the same claim.
 */
test('two concurrent polls for one project mint once', async () => {
  let minted = 0
  const slow = deps({
    mint: async () => {
      minted++
      await new Promise((done) => setTimeout(done, 10))
      return {
        accessToken: 'ghs_fresh',
        expiresAt: Date.now() + HOUR,
        permissions: [],
        repositorySelection: 'all',
      }
    },
  })

  const [a, b] = await Promise.all([
    usableGithubGrant('heirchive-api', grantExpiring(-HOUR), slow),
    usableGithubGrant('heirchive-api', grantExpiring(-HOUR), slow),
  ])

  assert.equal(minted, 1)
  assert.equal(a?.state, 'ready')
  assert.equal(b?.state, 'ready')
})

// ── when it fails ──────────────────────────────────────────────────────────

/**
 * The property: a revoked key **refuses** and a network failure **fails**, and neither
 * deletes anything.
 *
 * The classification is what the ledger is read through: a `refused` row tells an operator
 * to go and do something, a `failed` row tells them to look again tomorrow. A permanent
 * failure reported as transient is a poller retrying a revoked key every five minutes
 * forever with no row saying so.
 *
 * Nothing deletes, in either branch, and that is the load-bearing half. An operator
 * disconnects deliberately, from a surface that says what it is doing; a poller erasing a
 * credential at 3am is the destructive write `empty` exists to make visible one field over.
 * A revoked private key is a fact somebody has to see, not one to be tidied away by the
 * thing that discovered it — and GitHub shows a key only once, so "tidied away" means gone.
 */
test('a revoked key refuses, a network failure fails, and neither deletes anything', async () => {
  let stored = 0
  const counting = { store: async () => void stored++ }

  const revoked = await usableGithubGrant(
    'heirchive-api',
    grantExpiring(-HOUR),
    deps({
      ...counting,
      mint: async () => {
        throw new GithubAppError('config', 'github refused the app credential (401 …)')
      },
    }),
  )
  assert.equal(revoked.state, 'refused')
  if (revoked.state !== 'refused') return
  assert.match(revoked.detail, /Nothing was deleted/)
  assert.match(revoked.detail, /ogun connect github --app --project heirchive-api/)

  const offline = await usableGithubGrant(
    'heirchive-api',
    grantExpiring(-HOUR),
    deps({
      ...counting,
      mint: async () => {
        throw new GithubAppError('transport', 'could not reach github')
      },
    }),
  )
  assert.equal(offline.state, 'failed')
  if (offline.state !== 'failed') return
  assert.equal(offline.kind, 'transport')
  assert.match(offline.detail, /Nothing was spent/)

  assert.equal(stored, 0, 'a failed renewal wrote to the store')
})

/**
 * The property: a token that was minted and **could not be written** stops the poll, and
 * says `local` rather than `transport`.
 *
 * Nothing was spent — there is no rotation here — so proceeding on the new token would be
 * *safe*, and it is still wrong, for the reason the Linear path gives about its own
 * non-rotating grant: a poll that ran on a token the store never recorded would leave
 * `connect list`, `doctor` and the Settings card all reporting an expired grant while the
 * polls quietly worked. That is a store that disagrees with reality, which is the class of
 * bug where the evidence an operator debugs from is the thing that is wrong.
 *
 * `local` is what the ledger needs. GitHub answered and this machine could not write it
 * down; a config.json that is unwritable at 3am is unwritable at 4am, so a surface that
 * said "the next poll will retry" would be describing a loop with no exit.
 */
test('a token minted and not written stops the poll, as a local failure', async () => {
  const usable = await usableGithubGrant(
    'heirchive-api',
    grantExpiring(-HOUR),
    deps({
      store: async () => {
        throw new Error('EROFS: read-only file system')
      },
    }),
  )

  assert.equal(usable.state, 'failed')
  if (usable.state !== 'failed') return
  assert.equal(usable.kind, 'local')
  assert.match(usable.detail, /could not write it/)
  assert.match(usable.detail, /nothing was spent/)
})

/**
 * The property: a grant whose application is missing, or is another provider's, says
 * **which** and **why** rather than reporting an expired token.
 *
 * Only reachable by hand-editing config.json, which §4.5 says happens — `storeGrant`
 * refuses to write a grant naming an application that is not there, and `clearApplication`
 * refuses to remove one a grant still points at. The name is in the message because an
 * application is shared: "the application is gone" is not an answer when the machine holds
 * four, and the one that is missing is the only thing the operator can act on.
 *
 * The wrong-provider arm is the one the shared map added. Reading `appId` off a Linear
 * application would sign a JWT with `undefined` and report whatever GitHub said about it.
 */
test('a grant whose application is not usable names which one, and why', async () => {
  const absent = await usableGithubGrant(
    'heirchive-api',
    grantExpiring(-HOUR),
    deps({ readApp: async () => ({ state: 'absent' }) }),
  )
  assert.equal(absent.state, 'refused')
  assert.match(absent.state === 'refused' ? absent.detail : '', /"github:heirchive": absent/)

  const wrong = await usableGithubGrant(
    'heirchive-api',
    grantExpiring(-HOUR),
    deps({
      readApp: async () => ({
        state: 'present',
        app: {
          name: 'github:heirchive',
          provider: 'linear',
          method: 'client_credentials',
          clientId: 'client-1',
          clientSecret: sealSecret('shh'),
          redirectUri: '',
        },
      }),
    }),
  )
  assert.equal(wrong.state, 'refused')
  assert.match(wrong.state === 'refused' ? wrong.detail : '', /it is a linear application/)
})

// ── precedence, which is the thing this arm replaced a refusal with ────────

/**
 * The property: **a grant beats a personal access token**, and a dead grant **refuses**
 * rather than quietly becoming a personal one.
 *
 * This arm used to be a flat refusal — *"the app path is not wired yet"* — and the half of
 * that reasoning which survives is the half this test is about: it did not fall through to
 * a token sitting beside the grant, because *"an operator who had connected an App and also
 * left an old token in place would get the token, and their pull requests would keep being
 * authored by a human while the UI said otherwise"*.
 *
 * ADR-0014 settled this once for Linear — a grant wins, decided in one place — and the
 * fallback is rejected for the same two reasons it was rejected there: it hides a broken
 * connection behind a working poll, so nothing ever tells the operator to reconnect, and it
 * silently changes who the provider attributes writes to, which is the exact property the
 * operator connected an App in order to control.
 */
test('a grant beats a stored token, and a dead grant refuses rather than falling back', async () => {
  const both = await projectGithubCredential('heirchive-api', {
    secrets: async () => ({
      state: 'granted',
      apiKeyIgnored: true,
      grant: grantExpiring(10 * HOUR),
    }),
    grant: async () => ({
      state: 'ready',
      credential: { kind: 'app', token: 'ghs_live', login: 'ogun[bot]', installationId: 1 },
      expiresAt: Date.now() + HOUR,
      refreshed: false,
    }),
    identify: async () => {
      throw new Error('a personal token was identified, so the grant did not win')
    },
  })
  assert.equal(both.state, 'ready')
  assert.equal(both.state === 'ready' ? both.credential.kind : '', 'app')

  const dead = await projectGithubCredential('heirchive-api', {
    secrets: async () => ({
      state: 'granted',
      apiKeyIgnored: true,
      grant: grantExpiring(-HOUR),
    }),
    grant: async () => ({ state: 'refused', detail: 'the key was revoked in github' }),
    identify: async () => {
      throw new Error('it fell back to the personal token')
    },
  })
  assert.equal(dead.state, 'refused')
  /**
   * Forwarded as it stands, with its `kind` intact where it has one. `usableGithubGrant`
   * already draws the three distinctions the type carries, and a second sentence wrapped
   * around them here would be a second place for the remedies to drift apart.
   */
  assert.equal(dead.state === 'refused' ? dead.detail : '', 'the key was revoked in github')
})

/**
 * The property: an application nobody has taken a token from is `unconnected`, and the
 * remedy names the command that takes one.
 *
 * It said *"the app path is not wired yet"*, which was true and is not any more. What it
 * must not say is "set a personal token", which is where somebody who has done most of the
 * work of connecting an App would be sent by a message that collapsed this into `absent`.
 */
test('an app nobody has connected is told how to take a token, not to paste a key', async () => {
  const unconnected = await projectGithubCredential('heirchive-api', {
    secrets: async () => ({ state: 'unconnected', clientId: '1234567' }),
  })
  assert.equal(unconnected.state, 'refused')
  if (unconnected.state !== 'refused') return
  assert.match(unconnected.detail, /app 1234567/)
  assert.match(unconnected.detail, /ogun connect github --app --project heirchive-api/)
})
