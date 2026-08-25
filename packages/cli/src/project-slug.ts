import { basename, resolve as resolvePath, sep } from 'node:path'
import { loadProjectConfig, resolveProjectPath, type LocalConfig } from '@ogun/core'

/**
 * Which project a command acts on, when the command does not make you say.
 *
 * `ogun project add` and `ogun project sync` have always taken the current directory and
 * read the name out of its `.ogun/config.yaml`. Two commands did not — setting a secret and
 * registering a Linear application — and in both cases the `<project>` positional was the
 * only reason their namespace existed. This is that resolution, extracted once so the two
 * agree, and so the third command that needs it does not invent a third ladder.
 *
 * It reaches nothing. No server, no database, no network: every rung is a file on this
 * machine, which is what lets `ogun secret set` keep its promise of working before `ogun
 * init` and with the database down. What a caller then *checks* the slug against differs,
 * and deliberately: each command uses the best oracle it already depends on.
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
 * Empty when the slug came from the directory, because `ogun linear connect` is the command
 * they should actually run and `ogun linear connect --project ogun` reads as though the
 * flag were required. Explicit when they typed the flag, because they are then somewhere
 * the inference would not have reached, and a hint that only works elsewhere is worse than
 * no hint.
 *
 * Messages printed by the *server* — a poll refusal, a `doctor` line — spell it out
 * unconditionally instead, since nothing there knows what directory anybody is standing in.
 */
export const projectFlag = (project: ResolvedProject): string =>
  project.from === 'flag' ? ` --project ${project.slug}` : ''
