import { strict as assert } from 'node:assert'
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs'
import { mkdir, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { test } from 'node:test'

/**
 * `githubCli` itself, driven with no network and no credential.
 *
 * `publish.test.ts` fakes the whole `PublishRemote` seam, which is the right shape for
 * every question about *whether* to publish and the wrong one for this question: the seam
 * being faked everywhere means the one implementation that actually holds the credential
 * is the one piece nothing has ever executed. What is asserted here is the argv — because
 * that is the entire security posture of this file. Nothing goes through a shell, so
 * quoting is a dead attack and argument injection is the live one, and an argv assertion
 * is the only thing that notices when a later edit reaches for `exec` or interpolates a
 * number into a string.
 *
 * The method under test is `comment`, which is the one that exists and is not yet called
 * by anything. `countOpenPullRequests` and `publish` are left to the seam's own tests for
 * now: this file is the place to add them, and a fake `gh` that has to also impersonate
 * `git push` to a real remote is the fixture `publish.test.ts` already is.
 */

/**
 * A `gh` on `PATH` that does nothing but write down what it was handed.
 *
 * On `PATH` and not injected, because `githubCli` resolves the binary by name — which is
 * the thing being tested, since "the host's own `gh`, with whatever credential the person
 * already has" is the implementation's whole premise. `GH_ENV` is built when the module is
 * loaded, so `PATH` is set here, at the top of the file, and `publish.ts` is imported
 * dynamically inside each test rather than at the top where the import would be hoisted
 * above this.
 */
const bin = mkdtempSync(join(tmpdir(), 'ogun-fake-gh-'))
writeFileSync(
  join(bin, 'gh'),
  [
    '#!/bin/sh',
    '# Everything is recorded in $PWD — which is the cwd the publisher chose — so each',
    '# test gets its own record with no environment plumbing to go stale.',
    'record="$PWD/gh-argv"',
    ': > "$record"',
    'printf "cwd=%s\\n" "$PWD" >> "$record"',
    'printf "prompt=%s\\n" "$GH_PROMPT_DISABLED" >> "$record"',
    'printf "notifier=%s\\n" "$GH_NO_UPDATE_NOTIFIER" >> "$record"',
    '# Who invoked us. A shell in this slot is the failure this file exists to catch.',
    'if [ -r "/proc/$PPID/cmdline" ]; then',
    '  printf "parent=%s\\n" "$(tr \'\\0\' \' \' < /proc/$PPID/cmdline)" >> "$record"',
    'fi',
    'for a in "$@"; do printf "arg=%s\\n" "$a" >> "$record"; done',
    '# The body file, copied out before the publisher removes its staging directory.',
    'if [ -r "$5" ]; then cp "$5" "$PWD/gh-body"; fi',
    'if [ -f "$PWD/gh-should-fail" ]; then',
    '  echo "gh: could not add comment: HTTP 404 Not Found" >&2',
    '  exit 1',
    'fi',
    'exit 0',
  ].join('\n'),
  { mode: 0o755 },
)
process.env.PATH = `${bin}${delimiter}${process.env.PATH ?? ''}`

/** Loaded after `PATH` is set, so the module's `GH_ENV` carries the fake. */
const publisher = async () => (await import('../src/publish.ts')).githubCli()

/** A stand-in for a project's checkout: the fake `gh` only ever reads its own cwd. */
const checkout = async (name: string): Promise<string> => {
  const repo = join(mkdtempSync(join(tmpdir(), 'ogun-comment-repo-')), name)
  await mkdir(repo, { recursive: true })
  return repo
}

type Record = { cwd?: string; prompt?: string; notifier?: string; parent?: string; args: string[] }

const recorded = async (repo: string): Promise<Record> => {
  const raw = await readFile(join(repo, 'gh-argv'), 'utf8')
  const out: Record = { args: [] }
  for (const line of raw.split('\n').filter(Boolean)) {
    const [key = '', ...rest] = line.split('=')
    const value = rest.join('=')
    if (key === 'arg') out.args.push(value)
    else if (key === 'cwd') out.cwd = value
    else if (key === 'prompt') out.prompt = value
    else if (key === 'notifier') out.notifier = value
    else if (key === 'parent') out.parent = value
  }
  return out
}

/**
 * The argv, exactly, and the body intact on the way through a file.
 *
 * The body is deliberately the nastiest thing a caller could pass — command substitution,
 * a semicolon, a quote, a newline, a backtick — and the assertion is that it arrives
 * byte for byte. Through `execFile` and a file, every one of those is just text; a shell
 * anywhere on this path turns the first of them into a command.
 */
test('a comment reaches gh as argv, in the repository, and through no shell', async () => {
  const repo = await checkout('project')
  const body = ['`$(touch /tmp/ogun-pwned)`;', "rm -rf / # 'quoted'", 'line two'].join('\n')

  await (await publisher()).comment({ repo, number: 41, body })

  const call = await recorded(repo)
  assert.equal(call.args.length, 5, `gh got ${call.args.join(' ')}`)
  assert.deepEqual(call.args.slice(0, 4), ['pr', 'comment', '41', '--body-file'])
  assert.equal(call.cwd, repo, 'gh ran somewhere other than the project checkout')

  // `GH_ENV` and not a bare environment: a `gh` nobody is watching must not print a
  // banner on stderr or sit on a prompt holding a nightly run open until morning.
  assert.equal(call.prompt, '1')
  assert.equal(call.notifier, '1')

  // Not `/bin/sh -c`. The file's own comments say "every call in this file is
  // `execFile`", and this is the assertion that keeps saying it.
  if (call.parent !== undefined) {
    assert.match(call.parent, /node/, `gh was invoked by ${call.parent}`)
    assert.doesNotMatch(call.parent, /\bsh\b\s+-c|\bbash\b\s+-c/, `gh was invoked by a shell`)
  }

  assert.equal(await readFile(join(repo, 'gh-body'), 'utf8'), body)
  assert.equal(existsSync('/tmp/ogun-pwned'), false, 'something expanded the body')

  // The staging directory the body was written into is gone, like `publish`'s.
  assert.equal(existsSync(call.args[4]!), false, 'the comment body was left on disk')
})

/**
 * A `gh` that failed is not a comment that was posted.
 *
 * Nothing is read back out of a successful call, so a swallowed rejection here would be
 * indistinguishable from success at every caller forever — which is the one failure mode
 * a method returning `void` can have.
 */
test('a gh that fails surfaces rather than being swallowed', async () => {
  const repo = await checkout('project')
  writeFileSync(join(repo, 'gh-should-fail'), '')

  await assert.rejects(
    (await publisher()).comment({ repo, number: 7, body: 'nope' }),
    (err: Error) => {
      assert.match(err.message, /HTTP 404|exited|Command failed/i, err.message)
      return true
    },
  )
})

/**
 * A number that is not a pull request number, refused before `gh` is started.
 *
 * `-5` is the one that matters: it is not a malformed number, it is an *option*, and
 * `gh pr comment -5` is argument injection of exactly the kind `branchFor` was written
 * against. The rest are here because a guard that admits `NaN` or `1.5` would hand `gh`
 * a positional that means nothing and get an error about the wrong thing.
 */
test('a number that is not a pull request number never reaches gh', async () => {
  const remote = await publisher()
  for (const number of [-5, 0, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 2]) {
    const repo = await checkout(`n${String(number).replace(/[^a-z0-9]/gi, '')}`)
    await assert.rejects(
      remote.comment({ repo, number, body: 'x' }),
      /refusing to comment/,
      `${number} was not refused`,
    )
    assert.equal(existsSync(join(repo, 'gh-argv')), false, `${number} reached gh`)
  }
})
