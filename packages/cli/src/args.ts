import { parseArgs } from 'node:util'
import { fail } from './output.ts'

/**
 * Argument parsing for every command, on top of `node:util`'s parser.
 *
 * Each command used to find its positional with `args.find((a) => !a.startsWith('--'))`,
 * which cannot work: `--name foo` is two arguments, and the value is not a flag, so it
 * looks exactly like a positional. `ogun project add --name foo` resolved `./foo` as the
 * repository, and `ogun skill new --dir /repo` made `/repo` the skill's name. Nothing
 * warned — you got a confident message about the wrong thing.
 *
 * A real parser needs to be told which flags take values, which is the whole fix: it can
 * only tell a value from a positional if it knows the flag before it expects one.
 *
 * Unknown flags are an error rather than being ignored. A misspelled `--projct` that
 * silently does nothing is the same failure in a different costume.
 */

/**
 * `optional-string` is a flag that may or may not carry its value, and it exists for
 * exactly one shape: a flag that names *what kind of thing* is being connected and can
 * also carry the credential for it.
 *
 * `--api-key` is both. As a `boolean` with the key as a positional, `--api-key=<key>` —
 * which is what the usage line `--api-key <key>` invites somebody to type — dies with
 * *"Option '--api-key' does not take an argument"*, on the one invocation where the value
 * they just typed is a live credential and the fix is not obvious. As a `string`, the bare
 * `--api-key` that means "prompt me, or read the pipe" becomes *"argument missing"*, which
 * removes the recommended path entirely.
 *
 * So the value is optional: absent when the flag is, `''` when the flag was given without
 * one, and the value otherwise. Node's parser has no such type, so a bare occurrence is
 * rewritten to `--flag=` before it gets there.
 *
 * The cost is that a value beginning with `-` has to be written `--api-key=-abc`, because
 * a following `-token` is read as the next flag rather than as this one's value. Node's
 * own parser refuses that case for a plain `string` flag rather than guessing, and this
 * follows it: guessing wrong here means either storing a flag name as a credential or
 * swallowing a flag into one.
 */
export type FlagSpec = Record<string, 'string' | 'boolean' | 'optional-string'>

/** Specs are written as they are typed (`'--name'`); results are keyed without dashes. */
type Name<K> = K extends `--${infer R}` ? R : K extends `-${infer R}` ? R : K

export type Parsed<F extends FlagSpec> = {
  flags: { [K in keyof F as Name<K>]?: F[K] extends 'boolean' ? boolean : string }
  positionals: string[]
  /** First positional, which is what most commands want. */
  first: string | undefined
}

export function parse<F extends FlagSpec>(args: string[], spec: F, usage: string): Parsed<F> {
  const options: Record<string, { type: 'string' | 'boolean' }> = {}
  const optional: string[] = []
  for (const [name, type] of Object.entries(spec)) {
    options[name.replace(/^--?/, '')] = { type: type === 'boolean' ? 'boolean' : 'string' }
    if (type === 'optional-string') optional.push(name)
  }

  try {
    const { values, positionals } = parseArgs({
      args: withEmptyValues(args, optional),
      options,
      allowPositionals: true,
      // Single-dash flags like `-q` are declared long-form and matched by name; letting
      // the parser guess would make `-quiet` mean four separate short flags.
      allowNegative: false,
    })
    return {
      flags: values as Parsed<F>['flags'],
      positionals,
      first: positionals[0],
    }
  } catch (err) {
    // The parser's own message names the offending argument, which is the useful half;
    // the usage line is the other half.
    fail(`${(err as Error).message}\n  usage: ${usage}`)
    throw err
  }
}

/**
 * Rewrite a bare `--flag` into `--flag=` so Node's parser sees a value it does not have.
 *
 * "Bare" is decided by what follows: nothing, another option, or the `--` terminator. A
 * value is anything else, including one that happens to look like a path or a number.
 * Everything after `--` is left exactly as it arrived — that is the escape hatch for a
 * positional beginning with a dash, and rewriting inside it would break the one thing it
 * promises.
 */
function withEmptyValues(args: string[], optional: string[]): string[] {
  if (optional.length === 0) return args
  const out: string[] = []
  let terminated = false
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] as string
    if (arg === '--') terminated = true
    const next = args[i + 1]
    out.push(
      !terminated && optional.includes(arg) && (next === undefined || next.startsWith('-'))
        ? `${arg}=`
        : arg,
    )
  }
  return out
}

/** `--labels claude,docker` — a repeated concept expressed as one argument. */
export const listFlag = (value: string | undefined): string[] =>
  (value ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
