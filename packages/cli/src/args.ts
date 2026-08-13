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
export type FlagSpec = Record<string, 'string' | 'boolean'>

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
  for (const [name, type] of Object.entries(spec)) {
    options[name.replace(/^--?/, '')] = { type }
  }

  try {
    const { values, positionals } = parseArgs({
      args,
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

/** `--labels claude,docker` — a repeated concept expressed as one argument. */
export const listFlag = (value: string | undefined): string[] =>
  (value ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
