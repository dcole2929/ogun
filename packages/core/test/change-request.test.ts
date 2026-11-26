import { strict as assert } from 'node:assert'
import { describe, test } from 'node:test'
import {
  admitsRequest,
  loopGuard,
  requestBrief,
  requestKey,
  requestLabel,
  sourceSchema,
  type ChangeComment,
  type ChangeRequest,
  type GithubSourceConfig,
  requestFilterOf,
} from '../src/index.ts'

/**
 * The second source kind's deterministic rule (§4.13, ADR-0013).
 *
 * What is being protected here is narrower than `admitsTicket`'s and more dangerous to
 * get wrong. A ticket wrongly admitted costs a container and an evaluator's refusal; a
 * pull request wrongly admitted is an agent pushing commits to a branch on the strength
 * of a comment nobody checked was addressed to it — or, worse, on the strength of its own.
 */

const comment = (over: Partial<ChangeComment> = {}): ChangeComment => ({
  id: 'issue-1',
  author: 'reviewer',
  body: 'please rename the helper',
  createdAt: '2026-11-17T10:00:00Z',
  kind: 'issue',
  ...over,
})

const request = (over: Partial<ChangeRequest> = {}): ChangeRequest => ({
  repo: 'acme/api',
  number: 473,
  title: 'Make failed auth actions visible',
  body: 'Opened by Ogun.',
  url: 'https://github.com/acme/api/pull/473',
  headSha: 'a'.repeat(40),
  branch: 'ogun/implement/abc123',
  author: 'someone',
  isDraft: true,
  labels: ['ogun-revise'],
  comments: [comment()],
  updatedAt: '2026-11-17T10:00:00Z',
  ...over,
})

const filter = requestFilterOf(
  sourceSchema.parse({
    kind: 'github',
    cycle: 'revise',
    conditions: { repos: ['acme/api'], label: 'ogun-revise' },
  }) as GithubSourceConfig,
)

describe('a change request is admitted only when somebody asked', () => {
  test('a labelled pull request on an ogun branch with a comment is admitted', () => {
    const verdict = admitsRequest(filter, request())
    assert.equal(verdict.admitted, true)
  })

  test('the label is the trigger, and nothing else is', () => {
    /**
     * The whole design in one assertion. A pull request with a review on it saying
     * "please change this" and no label is somebody talking, not somebody asking — the
     * same distinction the `ogun-ready` label draws on the ticket side, for the same
     * reason: a pipeline that opens pull requests must not be started by a conversation.
     */
    const verdict = admitsRequest(filter, request({ labels: [] }))
    assert.equal(verdict.admitted, false)
    assert.match(verdict.admitted === false ? verdict.reason : '', /missing required label/)
  })

  test('a branch Ogun did not open is refused before the label is even read', () => {
    /**
     * Ordered deliberately. Somebody who labels a colleague's pull request has made a
     * mistake with no run, no base and no patch behind it, and the message has to say
     * that rather than something about labels — which would read as "nearly right".
     */
    const verdict = admitsRequest(filter, request({ branch: 'feature/login', labels: [] }))
    assert.equal(verdict.admitted, false)
    assert.match(verdict.admitted === false ? verdict.reason : '', /not one of Ogun's/)
  })

  test('a labelled pull request with nothing said on it is refused', () => {
    /**
     * The label asks for a revision; the comments say what. Admitting this would send an
     * agent to read Ogun's own report of what it did and invent an instruction from it.
     */
    const verdict = admitsRequest(filter, request({ comments: [] }))
    assert.equal(verdict.admitted, false)
    assert.match(verdict.admitted === false ? verdict.reason : '', /no comment says what to change/)
  })

  test('a repo this source does not watch is refused by name', () => {
    const verdict = admitsRequest(filter, request({ repo: 'acme/web' }))
    assert.equal(verdict.admitted, false)
    assert.match(verdict.admitted === false ? verdict.reason : '', /acme\/web/)
  })

  test('drafts are admitted, because Ogun opens drafts', () => {
    assert.equal(admitsRequest(filter, request({ isDraft: true })).admitted, true)
    const strict = { ...filter, includeDrafts: false }
    assert.equal(admitsRequest(strict, request({ isDraft: true })).admitted, false)
  })

  test('labels and repos fold case, because the rule does and GitHub does not', () => {
    assert.equal(admitsRequest(filter, request({ labels: ['OGUN-Revise'] })).admitted, true)
    assert.equal(admitsRequest(filter, request({ repo: 'ACME/api' })).admitted, true)
  })
})

describe('the identity of a round of review', () => {
  test('the same pull request at the same commit with the same comments is one round', () => {
    assert.equal(requestKey(request()), requestKey(request()))
  })

  test('a new comment is a new round', () => {
    // Without this, a reviewer's second thought never reaches an agent — which reads as
    // "Ogun ignored my review".
    assert.notEqual(
      requestKey(request()),
      requestKey(request({ comments: [comment(), comment({ id: 'issue-2' })] })),
      'a second comment is a second round',
    )
  })

  /**
   * **Ogun's own push is not a new round**, and this is the test that was inverted.
   *
   * The head sha used to be in the key, so that "a second round against a branch Ogun has
   * since revised is a different job from the first". That case is real and the comment
   * id already covers it: a reviewer asking for one more change writes a comment, and a
   * new comment id is a new key on its own — the test above.
   *
   * What the head sha added was a difference in the one case where nobody asked for
   * anything. A revision moves the branch, so the next poll computed a key nothing had
   * claimed, admitted the same review comments again, revised again, and pushed again —
   * every five minutes, with the agent, the container, the suite and a force-push each
   * time, and the breaker silent because every one of those runs succeeded.
   *
   * `loopGuard` stops Ogun acting on its own words. This is the same rule for its own
   * commits.
   */
  test('a branch Ogun has revised is not, by itself, a new round', () => {
    assert.equal(
      requestKey(request()),
      requestKey(request({ headSha: 'b'.repeat(40) })),
      'a moved head with nothing new said is the round that moved it',
    )

    // And the two together still are, because the comment is what asks for work.
    assert.notEqual(
      requestKey(request()),
      requestKey(request({
        headSha: 'b'.repeat(40),
        comments: [comment(), comment({ id: 'issue-2' })],
      })),
      'a reviewer speaking again after a revision is a new round',
    )
  })

  test('the key does not move when only the title or body changes', () => {
    /**
     * The opposite of `ticketDigest`, on purpose. An edited ticket is worth reporting
     * because a person rewrote the thing being asked for; an edited pull request title is
     * Ogun's own text and says nothing about whether the review has moved on.
     */
    assert.equal(requestKey(request()), requestKey(request({ title: 'Something else' })))
  })

  test('the readable key is the pull request, for a person reading the ledger', () => {
    assert.equal(requestLabel(request()), 'acme/api#473')
  })
})

describe('the loop guard', () => {
  test("Ogun's own comments are not an instruction to Ogun", () => {
    /**
     * Without this the source feeds itself: a revision pushes a commit, GitHub says so on
     * the thread, that is a new comment, that is a new round, and every iteration costs a
     * container.
     */
    const kept = loopGuard(
      [comment({ author: 'ogun-bot' }), comment({ id: 'issue-2', author: 'reviewer' })],
      'ogun-bot',
    )
    assert.deepEqual(kept.map((c) => c.id), ['issue-2'])
  })

  test('it folds case, because GitHub logins are matched case-insensitively', () => {
    assert.equal(loopGuard([comment({ author: 'Ogun-Bot' })], 'ogun-bot').length, 0)
  })
})

describe('the brief handed to an agent', () => {
  test('it fences the comments as data and says they are not instructions', () => {
    const verdict = admitsRequest(filter, request())
    assert.equal(verdict.admitted, true)
    const brief = requestBrief(verdict.admitted === true ? verdict.request : (null as never))

    assert.match(brief, /-----BEGIN REVIEW-----/)
    assert.match(brief, /-----END REVIEW-----/)
    assert.match(brief, /not as instructions about who you are/)
    // The pull request it is revising, by url, so the agent is not guessing which branch.
    assert.match(brief, /acme\/api#473/)
    assert.match(brief, /ogun\/implement\/abc123/)
  })

  test('every comment reaches the agent, in order, with its author', () => {
    const verdict = admitsRequest(
      filter,
      request({
        comments: [
          comment({ id: 'a', body: 'first', createdAt: '2026-11-17T10:00:00Z' }),
          comment({ id: 'b', body: 'second', author: 'other', createdAt: '2026-11-17T11:00:00Z' }),
        ],
      }),
    )
    assert.equal(verdict.admitted, true)
    const brief = requestBrief(verdict.admitted === true ? verdict.request : (null as never))
    assert.ok(brief.indexOf('first') < brief.indexOf('second'), 'oldest first')
    assert.match(brief, /other \(issue\) on/)
  })
})
