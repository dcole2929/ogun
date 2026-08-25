import { basename, resolve as resolvePath, sep } from 'node:path'
import { localConfigPath, loadProjectConfig, resolveProjectPath, type LocalConfig } from '@ogun/core'
import { dim, fail, yellow } from './output.ts'

/**
 * Which project a command acts on, when the command does not make you say.
 *
 * `ogun project add` and `ogun project sync` have always taken the current directory and
 * read the name out of its `.ogun/config.yaml`. Setting a credential did not, and the
 * `<project>` positional was the only reason its namespace existed. This is that
 * resolution, extracted once so every command agrees, and so the next one does not invent
 * a second ladder.
 *
 * It reaches nothing. No server, no database, no network: every rung is a file on this
 * machine, which is what lets `ogun connect` keep its promise of working before `ogun
 * init` and with the database down.
 *
 * What a caller *checks* the resolved slug against used to differ per command — "each
 * command checks against the best oracle it already depends on", which was true while
 * `secret set` and `linear app` were separate commands with separate dependencies. Two
 * oracles is an asymmetry nobody can predict: the same words, the same slug, two different
 * refusals. So `requireKnownProject` below is the one rule, and every command that writes
 * a credential under a slug — `connect` in all its kinds, and `secret set` — calls it
 * before it asks for anything. The control plane's own check on the routes that reach one
 * is the server refusing a write it should not accept, not a second rule to learn.
 */

/**
 * Where the slug came from, carried beside the slug itself.
 *
 * Not a bare string, because every message printed about an inferred project has to say how
 * the name was arrived at. `"heirchive-api" is not a project this machine knows` is a
 * different sentence depending on whether the operator typed it or a directory name
 * supplied it, and only one of those two is fixed by `cd`.
 */
export type ProjectSource =
  | 'flag'
  | '.ogun/config.yaml'
  | 'the registered path containing this directory'
  | 'the directory name'

export type ResolvedProject = { slug: string; from: ProjectSource }

/**
 * The rungs, in order, most trustworthy first:
 *
 *  1. `--project`, for a repo that is not checked out on this machine at all. That is the
 *     hosted control plane, and it is why the flag exists rather than being sugar.
 *  2. `.ogun/config.yaml` in the current directory. A repository naming itself is the best
 *     evidence available — better than this machine's projects map, which is a cache of
 *     that declaration taken at whatever time somebody last ran `sync`.
 *  3. The registered project whose root contains the current directory. `project add` does
 *     not need this rung because it takes a `[dir]` and its entire job is to be told one;
 *     the commands here have no positional to spare, and without it an operator standing in
 *     `packages/cli/` of a repo this machine has known for months gets refused. Longest
 *     root wins, so a checkout vendored inside another resolves to the inner one.
 *  4. The directory's own name, which is a guess. `project add` accepts that guess and says
 *     so, because the consequence there is a path registered under a slightly wrong name;
 *     the callers here check it against something before acting, because their consequence
 *     is a credential filed where nothing will ever read it.
 */
export async function resolveProject(
  flag: string | undefined,
  config: LocalConfig,
): Promise<ResolvedProject> {
  if (flag !== undefined) return { slug: flag, from: 'flag' }
  const cwd = resolvePath(process.cwd())

  const configured = await loadProjectConfig(cwd)
    .then((l) => l.config.project.name)
    .catch(() => null)
  if (configured) return { slug: configured, from: '.ogun/config.yaml' }

  const registered = registeredContaining(config, cwd)
  if (registered) {
    return { slug: registered, from: 'the registered path containing this directory' }
  }

  return { slug: basename(cwd), from: 'the directory name' }
}

/** The registered project this directory sits inside, deepest root first. */
function registeredContaining(config: LocalConfig, cwd: string): string | undefined {
  return Object.keys(config.projects)
    .map((slug) => ({ slug, root: resolvePath(resolveProjectPath(config, slug) ?? '') }))
    // A bare `startsWith(root)` matches `/srv/repo-old` against `/srv/repo`; the separator
    // is what makes this a containment test rather than a prefix test.
    .filter(({ root }) => cwd === root || cwd.startsWith(root + sep))
    .sort((a, b) => b.root.length - a.root.length)[0]?.slug
}

/**
 * How to spell this project in a command printed back to the operator.
 *
 * Empty when the slug came from the directory, because `ogun connect linear` is the command
 * they should actually run and `ogun connect linear --project ogun` reads as though the
 * flag were required. Explicit when they typed the flag, because they are then somewhere
 * the inference would not have reached, and a hint that only works elsewhere is worse than
 * no hint.
 *
 * Messages printed by the *server* — a poll refusal, a `doctor` line — spell it out
 * unconditionally instead, since nothing there knows what directory anybody is standing in.
 */
export const projectFlag = (project: ResolvedProject): string =>
  project.from === 'flag' ? ` --project ${project.slug}` : ''

/**
 * A slug this machine has never heard of is refused, and nothing is stored.
 *
 * ### One oracle, and the asymmetry that used to exist is gone
 *
 * ADR-0014 had two rules: `ogun secret set` checked the slug against this machine's
 * projects map with an `--allow-unregistered` escape, while `ogun linear app` checked it
 * against the control plane's database with no escape. The stated principle — *"each
 * command checks the slug against the best oracle it already depends on"* — was sound while
 * they were two commands. Under one `connect` it would become "each *kind* checks against
 * a different oracle", which is an asymmetry an operator has no way to predict: the same
 * command, the same slug, two different refusals and one flag that works in one of them.
 *
 * So there is one user-visible rule: **every command that writes a credential under a slug
 * checks it against this machine's own evidence, before it asks for anything.** That is
 * `connect` in all its kinds and `ogun secret set`, and this function is why the rule
 * cannot end up existing at one of those doors and not the other. Local evidence costs no
 * network and — the part that matters — arrives *before the prompts*, which is the property
 * that made the control-plane check worth having in the first place.
 *
 * The control plane still checks its database when a command reaches one. That is not a
 * second rule for the operator to learn: it is the server refusing a write it should not
 * accept, in the same sentence it always did, and with a database present there is no case
 * where an unknown slug is the right answer.
 *
 * ### Why there is an escape at all
 *
 * A hosted control plane is the legitimate case and is not exotic. `project sync` runs
 * where the repo is checked out; the machine that polls may never have held a copy, so its
 * projects map is legitimately empty while it polls four projects. The credential still
 * works there — `readProjectSecret` looks one up by slug and never consults that map — so a
 * refusal with no way through would lock the *correct* operator out of the one path that
 * works with the database down.
 *
 * `--allow-unregistered`, spelled out rather than `--force`, because what is being
 * overridden should be legible in the line that overrode it. It warns on the way through:
 * silence was the bug, and a flag somebody had to type is not silence.
 *
 * A slug read out of a `.ogun/config.yaml` in the current directory is accepted with no
 * flag even when the map has never heard of it. A repository declaring its own name is
 * stronger evidence than this machine's cache of that declaration, and demanding a
 * `project add` first would make "connect it, then sync" impossible for no gain.
 *
 * `disconnect` and `ogun secret rm` call none of this, on purpose: a closed set and a known
 * slug guard *writes*, where a wrong one creates a credential nothing reads. A removal
 * creates nothing, and a row the listing shows has to be a row you can remove.
 */
export function requireKnownProject(
  project: ResolvedProject,
  config: LocalConfig,
  allowUnregistered: boolean,
): void {
  if (Object.hasOwn(config.projects, project.slug) || project.from === '.ogun/config.yaml') return

  if (allowUnregistered) {
    console.log(
      yellow(`  "${project.slug}" is not a project this machine knows — connecting anyway.`),
    )
    console.log(
      dim(
        '  Nothing here can confirm the slug, so a typo stays a typo until a poll 401s.\n' +
          '  It has to match the name the control plane polls this project under, exactly.',
      ),
    )
    return
  }

  const known = Object.keys(config.projects).sort()
  fail(
    `"${project.slug}" is not a project this machine knows.\n` +
      '  ' +
      (known.length > 0
        ? `Known here: ${known.join(', ')}.`
        : `No projects are registered in ${localConfigPath()}.`) +
      '\n' +
      '  Nothing was stored. A credential filed under a slug nothing polls reports as\n' +
      '  connected and is read by nothing.\n' +
      (project.from === 'the directory name'
        ? '  This directory has no .ogun/config.yaml, so the name was guessed from it. Run\n' +
          '  this inside the repository instead, or pass --project <slug>.\n'
        : '') +
      '  Register it with `ogun project sync` (or `ogun project add`), or — if the repo is\n' +
      '  checked out on another machine entirely — repeat with --allow-unregistered.',
  )
}
