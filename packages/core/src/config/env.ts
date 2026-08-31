import { randomBytes, randomUUID } from 'node:crypto'
import { z } from 'zod'

/**
 * The environment a project's own stack needs, declared in `.ogun/config.yaml` and
 * resolved on the host before the container exists.
 *
 * ### Why this is not the project's Dockerfile
 *
 * `.ogun/Dockerfile` can already bake variables, and heirchive-api's does — its
 * `SUPABASE_URL` and the two well-known demo JWTs are `ENV` lines. That works right up
 * until the repository moves. A migration landed there requiring `MONITOR_PASSWORD`, and
 * because the image is a snapshot pinned when the project was added, every gate for that
 * project began failing in the entrypoint, before any command ran, with a Postgres
 * exception. The image could not have known: the requirement arrived in a commit.
 *
 * A declaration in `config.yaml` can arrive in the same patch as the migration that needs
 * it, is versioned with the repository, and is read from the blob at the pinned base like
 * every other gate input. That is the whole argument for this file.
 *
 * ### Three shapes, and only three
 *
 *   `NAME: some-string`            a literal. The common case, and the reason a bare
 *                                  scalar is accepted rather than `{ literal: ... }`:
 *                                  most of what a stack needs is a URL or a flag.
 *   `NAME: { generate: password }` a value that must *exist* and must be *consistent*
 *                                  within the run, and whose content nothing checks.
 *   `NAME: { secret: stripe-test }` a value only this machine holds, out of the 0600
 *                                  store (ADR-0012). Never the default, and never
 *                                  something a run gets by accident.
 *
 * ### Why `generate` is a closed set and not a template language
 *
 * The obvious generalisation is an expression — `{{ faker.internet.password() }}`, or any
 * of the fake-data libraries that do this well. It is the wrong tool twice over.
 *
 * Those libraries generate *plausible human data*: names, addresses, emails, for seeding a
 * database. Nothing here is human data. `MONITOR_PASSWORD` is a credential shape, and a
 * realistic-looking fake password is strictly worse than 32 random bytes — lower entropy,
 * and it looks like a real credential when it turns up in a log.
 *
 * The second reason is the one that closes the question. `.ogun/config.yaml` is a file a
 * *modifier writes*. Ogun's whole containment story is that a patch cannot widen the gates
 * it is about to be judged by, which is why the pinned blob is read rather than the tree.
 * An expression evaluated out of that file is an evaluation surface an agent holds the pen
 * on. A closed set of four generators is auditable by reading this file; an expression
 * language is auditable by reading every config that ever gets written.
 *
 * So the set stays closed, the implementation is `node:crypto` — already the source for
 * every other random value in this codebase — and adding a fifth generator is a commit
 * somebody reviews rather than a string somebody writes.
 */

/**
 * The alphabet a generated password is drawn from.
 *
 * Chosen by where these values land rather than by any password policy. A generated
 * password reaches Postgres inside `format('... PASSWORD %L', pw)`, a connection string, a
 * shell command in an entrypoint, and a YAML file — so every character that quotes,
 * escapes, delimits or substitutes in any of those is out: quotes, backslash, `$`, backtick,
 * `:`, `/`, `@`, `&`, `?`, `#`, `%`, `;`, `|`, and the bracket families.
 *
 * What is left is alphanumerics plus three joiners, which is 65 characters and just over 6
 * bits each. At the default length that is ~192 bits, which is not the constraint — the
 * constraint is that the value survives being passed through four parsers unaltered.
 */
const PASSWORD_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_.'

/**
 * The largest byte value that can be reduced modulo the alphabet without bias.
 *
 * 256 is not a multiple of 65, so `byte % 65` would draw the first 61 characters slightly
 * more often than the last four. The bias is tiny and it is also free to remove: reject
 * the 61 bytes in the ragged tail and draw again.
 */
const UNBIASED_CEILING = 256 - (256 % PASSWORD_ALPHABET.length)

/** A password that is safe in SQL, shell, URL and YAML positions. */
function generatePassword(length: number): string {
  let out = ''
  while (out.length < length) {
    for (const byte of randomBytes(length)) {
      if (byte >= UNBIASED_CEILING) continue
      out += PASSWORD_ALPHABET[byte % PASSWORD_ALPHABET.length]
      if (out.length === length) break
    }
  }
  /**
   * A leading `-` or `.` reads as an option or a relative path to something eventually,
   * and the one character it costs is not worth the class of bug. Redrawn from the
   * alphanumeric prefix rather than trimmed, so the length stays what was asked for.
   */
  const alnum = PASSWORD_ALPHABET.slice(0, 62)
  if (!alnum.includes(out[0] as string)) {
    let first: number
    do first = randomBytes(1)[0] as number
    while (first >= 248)
    return (alnum[first % 62] as string) + out.slice(1)
  }
  return out
}

export const GENERATORS = ['password', 'hex', 'base64', 'uuid'] as const
export type Generator = (typeof GENERATORS)[number]

/**
 * The generators, each with the knob that is meaningful for it and no others.
 *
 * `password` counts characters and `hex`/`base64` count *bytes before encoding*, which is
 * the difference that matters in practice: heirchive-api's `DOC_ENCRYPTION_KEY` has to
 * decode to exactly 32 bytes or the application throws while starting. Sharing one `length`
 * across all three would make that declaration ambiguous at the moment it is written.
 *
 * A discriminated union with `.strict()` on every member, so `{ generate: uuid, bytes: 4 }`
 * is a parse error rather than a knob that silently does nothing. A setting that is
 * accepted and ignored is the same failure as a gate that is present and inert.
 */
const generatorSchema = z.discriminatedUnion('generate', [
  z
    .object({
      generate: z.literal('password'),
      /** Characters. Long by default because nothing here has to be typed by a person. */
      length: z.number().int().min(8).max(256).default(32),
    })
    .strict(),
  z
    .object({
      generate: z.literal('hex'),
      /** Bytes before encoding; the string is twice this. */
      bytes: z.number().int().min(1).max(256).default(32),
    })
    .strict(),
  z
    .object({
      generate: z.literal('base64'),
      /** Bytes before encoding — what a consumer that decodes the value will get. */
      bytes: z.number().int().min(1).max(256).default(32),
    })
    .strict(),
  z.object({ generate: z.literal('uuid') }).strict(),
])
export type GeneratorSpec = z.infer<typeof generatorSchema>

const secretRefSchema = z
  .object({ secret: z.string().min(1, 'a `secret:` reference needs a name') })
  .strict()

/**
 * A literal, written as a bare scalar.
 *
 * Numbers and booleans are coerced rather than refused, because `PORT: 9000` and
 * `DEBUG: false` are what people write and YAML hands them over already typed. An
 * environment variable is a string either way; refusing the natural spelling would only
 * teach everyone to quote everything.
 *
 * `null` is refused. `FOO:` with nothing after it is almost always an unfinished line, and
 * turning it into the empty string is how a variable ends up set-but-empty — which reads
 * as "configured" to everything downstream and behaves as "missing".
 */
const literalSchema = z
  .union([z.string(), z.number(), z.boolean()])
  .transform((value) => String(value))

export const envValueSchema = z.union([literalSchema, generatorSchema, secretRefSchema], {
  error:
    'each entry under `env:` is either a bare value (`SUPABASE_URL: http://…`), ' +
    '`{ generate: password | hex | base64 | uuid }`, or `{ secret: <name> }`',
})
export type EnvValue = z.infer<typeof envValueSchema>

/**
 * Names Ogun sets itself, which a project may not.
 *
 * `docker run` takes the last `--env` for a name, so whichever list is pushed second wins.
 * The structural answer is in `containerArgs`, which now pushes the project's block first
 * and Ogun's after it — a collision there costs the project its value and cannot cost Ogun
 * its variable. This refusal is the message rather than the mechanism: `OGUN_PERMISSIONS`
 * or `OGUN_EGRESS_SOCKET` in a config file is somebody trying something, and the useful
 * response is to say so at parse time rather than to silently drop it at run time.
 */
export const RESERVED_ENV_PREFIX = 'OGUN_'

/**
 * `env:` itself.
 *
 * The key rule is POSIX's, and it is enforced because `docker run --env 'a b=c'` does not
 * fail — it creates a variable no shell can read, and the project is left with a stack that
 * starts and behaves as though the value were never declared.
 */
const envRecordSchema = z.record(
  z
    .string()
    .regex(
      /^[A-Za-z_][A-Za-z0-9_]*$/,
      'an environment variable name is letters, digits and underscore, and cannot start ' +
        'with a digit',
    )
    .refine((name) => !name.startsWith(RESERVED_ENV_PREFIX), {
      error: `\`${RESERVED_ENV_PREFIX}*\` is reserved for the variables Ogun sets on the sandbox itself`,
    }),
  envValueSchema,
)

/**
 * `env:` itself.
 *
 * The key rule is POSIX's, and it is enforced because `docker run --env 'a b=c'` does not
 * fail — it creates a variable no shell can read, and the project is left with a stack that
 * starts and behaves as though the value were never declared.
 *
 * ### Why there is a hand-written check in front of the record
 *
 * `__proto__` is a legal environment variable name and the YAML parser keeps it as an own
 * property, but `z.record` drops it during parsing rather than validating it. The variable
 * would therefore be declared, accepted, and absent — the silent drop this whole module
 * refuses everywhere else. It is refused here instead, by looking at the raw object before
 * the record ever sees it.
 *
 * (Nothing downstream depends on that refusal for safety: `resolveEnv` builds its result
 * with a null prototype, so the key could not have poisoned anything. This is about the
 * declaration being honoured or refused, never quietly lost.)
 */
export const envSchema = z
  .unknown()
  .check((ctx) => {
    const raw = ctx.value
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return
    if (Object.prototype.hasOwnProperty.call(raw, '__proto__')) {
      ctx.issues.push({
        code: 'custom',
        input: raw,
        path: ['__proto__'],
        message:
          '`__proto__` cannot be used as a name under `env:`. It is a legal environment ' +
          'variable and an illegal object key, and the parser would drop it rather than ' +
          'set it — so it is refused here instead of vanishing',
      })
    }
  })
  .pipe(envRecordSchema.default({}))
export type EnvConfig = z.infer<typeof envSchema>

/** Where a resolved value came from. Carried so a run can say what it set without saying what it set it to. */
export type EnvSource = 'literal' | 'generate' | 'secret'

export type EnvResolution =
  | { state: 'resolved'; env: Record<string, string>; sources: Record<string, EnvSource> }
  | { state: 'refused'; reason: string }

/**
 * Turn a declaration into the environment a container is started with.
 *
 * Async and injected rather than reaching for the store itself, because the store is a
 * machine-local file and this is the one piece of the feature worth testing without one.
 *
 * A missing secret refuses the whole run rather than dropping one variable. The stack this
 * environment is for either starts or does not, and "started with one variable missing" is
 * the state that produces a gate failure fifteen minutes later with a stack trace that
 * names something else entirely.
 */
export async function resolveEnv(
  declared: EnvConfig,
  lookup: (name: string) => Promise<string | undefined>,
): Promise<EnvResolution> {
  const env: Record<string, string> = Object.create(null) as Record<string, string>
  const sources: Record<string, EnvSource> = Object.create(null) as Record<string, EnvSource>

  for (const [name, value] of Object.entries(declared)) {
    if (typeof value === 'string') {
      env[name] = value
      sources[name] = 'literal'
      continue
    }
    if ('secret' in value) {
      const stored = await lookup(value.secret)
      if (stored === undefined || stored.trim() === '') {
        return {
          state: 'refused',
          reason:
            `\`env.${name}\` needs the secret \`${value.secret}\`, and this machine has no ` +
            `value stored for it — \`ogun secret set ${value.secret} <key>\`. The run is ` +
            'refused rather than started without it, because a stack missing one variable ' +
            'fails later and blames something else',
        }
      }
      env[name] = stored
      sources[name] = 'secret'
      continue
    }
    env[name] = generate(value)
    sources[name] = 'generate'
  }

  return { state: 'resolved', env, sources }
}

/** The generators themselves. Separated so a test can assert shape without a config. */
export function generate(spec: GeneratorSpec): string {
  switch (spec.generate) {
    case 'password':
      return generatePassword(spec.length)
    case 'hex':
      return randomBytes(spec.bytes).toString('hex')
    case 'base64':
      return randomBytes(spec.bytes).toString('base64')
    case 'uuid':
      return randomUUID()
  }
}
