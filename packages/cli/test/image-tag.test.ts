import { strict as assert } from 'node:assert'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { baseImage, projectImage } from '@ogun/core'
import { projectSlug } from '../src/commands/image.ts'
/**
 * Reaching across packages on purpose. `ogun image build` decides what an image is
 * *called* and the runner decides what to *ask docker for*, they are in different
 * packages, and the whole bug was that nothing ever compared the two answers. A test that
 * imported only one of them would assert a naming convention rather than an agreement,
 * and the naming convention was never what was broken — both sides had it right.
 */
import { imageFor } from '../../runner/src/pipeline.ts'

/**
 * The builder and the runner must produce the same image name for the same project.
 *
 * They did not. `ogun image build <dir>` tagged `ogun/project-<basename of dir>` while the
 * runner asked for `ogun/project-<job.projectSlug>`, and those agree only when the checkout
 * directory happens to be named after the project. Ogun's own repository, worked on
 * through the git worktrees under `.claude/worktrees/`, is a permanent counterexample: the
 * build succeeded, printed a tag, and produced an image that no job would ever request.
 * What the modifier then reported was docker's `Unable to find image
 * 'ogun/project-ogun:latest'` — a message about the image nobody built, naming nothing
 * about the one that was.
 *
 * A naive implementation passes a test that checks the format string on either side. The
 * property that matters is only visible with both, and only when the directory name and
 * the slug differ — so these fixtures make them differ deliberately.
 */

const withProject = async (dirName: string, body: string) => {
  const root = await mkdtemp(join(tmpdir(), 'ogun-image-tag-'))
  const dir = join(root, dirName)
  await mkdir(join(dir, '.ogun'), { recursive: true })
  await writeFile(join(dir, '.ogun', 'config.yaml'), body)
  return { dir, cleanup: () => rm(root, { recursive: true, force: true }) }
}

test('a checkout whose directory is not named after the project still builds the image the runner wants', async (t) => {
  // Exactly the shape this repository is checked out in while an agent works on it.
  const { dir, cleanup } = await withProject(
    'agent-aecf307520f058094',
    'project:\n  name: ogun\n  defaultBranch: main\nworkers: {}\n',
  )
  t.after(cleanup)

  const built = projectImage(await projectSlug(dir))
  const wanted = imageFor({ permissions: 'modifier', projectSlug: 'ogun' })

  assert.equal(built, wanted)
  assert.equal(built, 'ogun/project-ogun:latest')
})

test('--name overrides, because `ogun project add --name` can too', async (t) => {
  const { dir, cleanup } = await withProject(
    'checkout',
    'project:\n  name: from-config\n  defaultBranch: main\nworkers: {}\n',
  )
  t.after(cleanup)
  // The path map is what makes a repo reachable, and `project add --name` writes it under
  // the override. An image built from the config's name would then be one the job cannot
  // find, which is the original bug with a different cause.
  assert.equal(
    projectImage(await projectSlug(dir, 'registered-as')),
    imageFor({ permissions: 'modifier', projectSlug: 'registered-as' }),
  )
})

test('with no config at all the directory name is the guess, and both sides make it', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'ogun-image-tag-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const dir = join(root, 'unregistered')
  await mkdir(dir, { recursive: true })
  // Same fallback `ogun project add` uses, so the two still agree about a project neither
  // of them has been told the real name of.
  assert.equal(projectImage(await projectSlug(dir)), 'ogun/project-unregistered:latest')
})

/**
 * Reviewers do not get a project image. §5.1: the base image is enough to read a repo and
 * deliberately not enough to build one, so a reviewer never depends on a project having
 * run `ogun image build` at all.
 */
test('a reviewer runs in the base image, not a project one', () => {
  assert.equal(imageFor({ permissions: 'reviewer', projectSlug: 'ogun' }), baseImage())
  assert.equal(imageFor({ permissions: 'observer', projectSlug: 'ogun' }), baseImage())
})

/**
 * And neither does the one modifier whose patch is what creates the project image
 * (ADR-0016).
 *
 * Not a special case bolted on: it is the same rule read forwards. The project image
 * exists so a patch can be proved against the project's real toolchain, and this worker's
 * patch *is* the toolchain — there is no image to run it in, which is exactly the condition
 * it was dispatched to fix. Asking for one would fail on docker's "Unable to find image",
 * which is the same misleading error this whole file exists about, arriving for a project
 * where nobody could have built it.
 */
test('a bootstrap modifier runs in the base image, because the image is what it is writing', () => {
  assert.equal(
    imageFor({ permissions: 'modifier', projectSlug: 'ogun', bootstrap: 'project-image' }),
    baseImage(),
  )
  // And an ordinary modifier is unaffected, which is the half that must not regress.
  assert.equal(
    imageFor({ permissions: 'modifier', projectSlug: 'ogun' }),
    projectImage('ogun'),
  )
})
