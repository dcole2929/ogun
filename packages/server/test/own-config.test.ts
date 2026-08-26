import { strict as assert } from 'node:assert'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { parse as parseYaml } from 'yaml'
import { projectConfigSchema, readTestCommand } from '@ogun/core'
import { modifierReadiness } from '../src/foreman/admission.ts'

/**
 * Ogun's own `.ogun/config.yaml`, held to the schema that will read it.
 *
 * Nothing else does. Every other test builds a config in a temp directory, which proves
 * the parser and says nothing about the file this repository actually ships — and that
 * file is read at 3am by the foreman, not by anybody at a keyboard. A worker stanza with
 * a key the schema does not know, or a skill name that does not resolve, fails at
 * dispatch time and is reported as a broken worker rather than as a broken config.
 *
 * Scoped to what is knowable offline. Whether a *run* succeeds depends on an image, a
 * database and a model API; whether it can be *dispatched* depends only on this file and
 * the tree around it, and that is what these assert.
 */

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const configText = await readFile(join(root, '.ogun', 'config.yaml'), 'utf8')

test('the config this repository ships parses under the schema that reads it', () => {
  const config = projectConfigSchema.parse(parseYaml(configText))
  assert.equal(config.project.name, 'ogun')
  assert.ok(Object.keys(config.workers).length > 0, 'a config with no workers runs nothing')
})

/**
 * A skill name in `.ogun/config.yaml` is resolved at run time, inside the workspace, after
 * a clone — so a typo is discovered by a job that has already provisioned a container.
 *
 * The runner also searches `~/.ogun/skills`, which is a fact about somebody's machine and
 * therefore not something a test can or should assert. This is the narrower claim: every
 * worker *this repository* defines names a skill *this repository* ships, so the answer
 * does not depend on whose laptop the runner is.
 */
test('every worker names a skill this repository ships', () => {
  const config = projectConfigSchema.parse(parseYaml(configText))
  for (const [name, worker] of Object.entries(config.workers)) {
    const skill = join(root, 'skills', worker.skill, 'SKILL.md')
    assert.ok(existsSync(skill), `worker "${name}" names ${worker.skill}, which is not in skills/`)
  }
})

/**
 * The two things admission checks before it will dispatch a modifier at all (§4.3), asked
 * of this repository directly.
 *
 * Both are properties of the tree rather than of the run: no `.ogun/Dockerfile` means the
 * job would get `ogun/base`, which cannot run this suite; no `tests.command` means nothing
 * could show a patch works. A modifier refused for either reason has spent a clone and a
 * container to learn something this file could have said. It is also the pair most likely
 * to be broken by an unrelated change — moving the Dockerfile, or reorganising the config
 * — and neither edit looks anything like "you have disabled the write path".
 */
test('a modifier could be admitted against this repository', () => {
  const verdict = modifierReadiness('ogun', {
    root,
    hasImage: existsSync(join(root, '.ogun', 'Dockerfile')),
    ...(readTestCommand(configText) ? { testCommand: readTestCommand(configText) } : {}),
  })
  assert.deepEqual(verdict, { ready: true })
})

/**
 * `policies.allowSandboxDowngrade` is false here, and a modifier on the `worktree` sandbox
 * is an agent editing files directly in the checkout on the host — which is the one
 * configuration where "the sandbox never pushes" stops being structural, because the
 * checkout it is editing has a remote and a credential.
 *
 * The API refuses that combination when a worker is created through it. Nothing refuses it
 * in a file somebody edits by hand, and this is the file.
 */
/**
 * A worker whose product is a *verdict* has one failure nothing else catches: it produces a
 * perfectly valid document that answers nothing, and the run is recorded `approved` — so
 * its dependents are released and the rest of a ticket pipeline runs on a ticket nobody
 * judged (§4.13). The `verdict` lens is what turns that into a failed gate, and it is
 * declared per worker rather than defaulted, which means it is one line away from being
 * quietly deleted.
 *
 * Written against the *skill* rather than against the worker's name, because the way this
 * would actually be lost is a second binding — `security-review` is already a second
 * binding of `adversarial-review`, and nobody copying that pattern would think to bring the
 * `verify:` block along.
 */
test('every worker running scope-a-ticket is required to produce a verdict', () => {
  const config = projectConfigSchema.parse(parseYaml(configText))
  for (const [name, worker] of Object.entries(config.workers)) {
    if (worker.skill !== 'scope-a-ticket') continue
    const lenses = worker.verify?.expectations.map((l) => l.name) ?? []
    assert.ok(
      lenses.includes('verdict'),
      `"${name}" judges tickets and does not declare the verdict lens, so a run that ` +
        'answered nothing would release the pipeline behind it',
    )
    // It reads and decides; it writes nothing. A modifier here is an evaluator that can
    // start doing the work it was asked to judge.
    assert.notEqual(worker.permissions, 'modifier', `"${name}" must not be able to write`)
  }
})

test('no modifier in this config runs outside a container', () => {
  const config = projectConfigSchema.parse(parseYaml(configText))
  for (const [name, worker] of Object.entries(config.workers)) {
    if (worker.permissions !== 'modifier') continue
    assert.equal(worker.sandbox, 'container', `modifier "${name}" is not sandboxed in a container`)
  }
})
