import { z } from 'zod'

/**
 * What a worker's sandbox is allowed to reach (§4.6).
 *
 * §4.6 always specified egress as a host allowlist. What landed was `open | none`, with
 * `open` as the default — and §9 recorded the divergence as an open question rather than
 * a bug, on the grounds that a filtering proxy would be a sibling container and therefore
 * ruled out by ADR-0006. That reasoning held for the proxy's *packaging* and was then
 * used to justify the *default*, which is where it went wrong: `open` is unrestricted
 * internet, and every sandbox is mounted a live OAuth credential it can read. The worst
 * case was never "burning rate limit"; it was a prompt-injected agent reading
 * `~/.claude/.credentials.json` out of its own home and POSTing it somewhere. An
 * adversarial reviewer is pointed *at* untrusted repository content on purpose, so the
 * injection vector is the job description.
 *
 * Three shapes, and the union is what keeps every config that predates this working:
 *
 *   `'none'`   — no network at all. Structural: `--network none`, nothing mounted, no
 *                proxy. The right answer for a tool-only pass, and wrong for anything
 *                that runs an agent, because the runtime itself calls a model API.
 *   `'open'`   — unrestricted. Kept, because a project whose suite pulls from a dozen
 *                hosts needs an escape hatch that is not "give up on egress control".
 *                It is a loud opt-out: you have to type it, and the runner logs it.
 *   `string[]` — extra hosts this worker may reach, on top of the defaults below.
 *
 * Absent means the defaults alone, which is the case that had to be shippable: existing
 * configs name no egress at all, and a change that turned them into airgaps would have
 * been a change that broke every job while looking like a security improvement.
 *
 * Additive rather than replacing, deliberately. A list that replaced the defaults would
 * let a worker declare `egress: [registry.npmjs.org]` and lock its own agent runtime out
 * of the model API — which does not produce a stricter worker, it produces one that
 * cannot start, and it fails at 3am rather than at parse time.
 */
export const egressSchema = z.union([
  z.literal('open'),
  z.literal('none'),
  z.array(egressHost()).min(1),
])
export type EgressPolicy = z.infer<typeof egressSchema>

/**
 * One entry in an allowlist: a hostname, or `*.` plus a parent domain.
 *
 * Validated at parse rather than at match time because the failure is otherwise silent
 * and late. `https://api.example.com/v1` is what a person writes the first time, and a
 * matcher that simply never matches it turns a typo into a connection refused inside a
 * container at 3am, reported as "the agent could not reach the API". A port is rejected
 * for the same reason and a different one: the allowlist is about *where*, and a rule
 * that also pinned the port would have to be honoured by CONNECT's port field, which is
 * a policy engine — explicitly not what this is.
 */
function egressHost(): z.ZodString {
  return z
    .string()
    .min(1)
    .max(253)
    .regex(
      /^(\*\.)?(?!-)[a-z0-9-]{1,63}(?<!-)(\.(?!-)[a-z0-9-]{1,63}(?<!-))*$/i,
      'must be a hostname such as `registry.npmjs.org`, or `*.example.com` — no scheme, ' +
        'no port, no path',
    )
    // `*` alone would be `open` spelled in a way that does not read as an opt-out.
    .refine((h) => h !== '*' && h !== '*.', 'use `egress: open` to say "anywhere"')
}

/**
 * What every sandbox may reach before a worker asks for anything.
 *
 * The constraint that decides this set: a default that breaks every existing job is not
 * shippable. An agent runtime with no route to its model API does not run at all, so
 * "deny by default" applied to the model API produces a factory that never starts a job
 * and reports it as an egress policy working correctly.
 *
 * Scoped to the runtime that is actually going to run, so a claude worker carries no
 * OpenAI rule and vice versa. That is free — the runner knows the runtime before it
 * builds the container — and it is the difference between an allowlist and a list.
 *
 * Vendor domains are wildcarded rather than enumerated, which is a real decision and not
 * laziness. Enumerating means guessing at today's endpoint names — the model API, the
 * OAuth refresh host, the feature-flag host a CLI stalls on when it cannot reach it — and
 * being wrong produces a 30-second hang or a broken auth refresh that reads as anything
 * but an egress rule. Against the threat this exists for it costs nothing: the attacker
 * in the prompt-injection story does not control a host under `anthropic.com`. What the
 * wildcard does not cover is exfiltration *through* the model API itself, by an agent
 * writing a secret into a completion request. That is a different and harder problem, it
 * is still open, and no allowlist closes it.
 *
 * Measured rather than guessed. Both runtimes were run for real against this list, in a
 * `--network none` container with only the proxy socket mounted, and both completed a
 * live model call. What they *also* reached for, and were refused without harm, is the
 * useful half of the result:
 *
 *   claude -> http-intake.logs.us5.datadoghq.com   (telemetry, third-party)
 *   codex  -> sdmntpr…southcentralus.oaiusercontent.com  (OpenAI's own asset CDN)
 *
 * The Datadog host stays off the list on purpose: it is a third party, it is exactly the
 * shape of host this exists to exclude, and claude completed its call without it. The
 * `oaiusercontent.com` wildcard was added because it is OpenAI's own domain and falls
 * under the same reasoning as `*.openai.com` — a region-sharded CDN name is precisely the
 * kind of endpoint nobody enumerates correctly.
 */
export function defaultEgressAllow(runtime: 'claude' | 'codex'): string[] {
  return [
    // The registry, for every runtime. §9's tests-must-pass gate runs the project's own
    // suite in this same sandbox, and a suite that begins `pnpm install` against a
    // blocked registry fails as a red suite — which is not a stricter gate, it is a gate
    // that reports the wrong thing about a modifier's patch. Read-only exposure: nothing
    // in here holds a publish token.
    'registry.npmjs.org',
    ...(runtime === 'claude'
      ? ['anthropic.com', '*.anthropic.com']
      : [
          'openai.com',
          '*.openai.com',
          'chatgpt.com',
          '*.chatgpt.com',
          '*.oaiusercontent.com',
        ]),
  ]
}

/**
 * The hosts a container may reach, given its worker's declaration.
 *
 * `open` and `none` return no list at all — they are not allowlists and the caller has to
 * branch on them anyway, so returning `[]` for `none` and something enormous for `open`
 * would be two ways to say the same thing wrong.
 */
export function resolveEgressAllow(
  policy: EgressPolicy | undefined,
  runtime: 'claude' | 'codex',
): string[] | undefined {
  if (policy === 'open' || policy === 'none') return undefined
  const declared = policy ?? []
  return [...new Set([...defaultEgressAllow(runtime), ...declared.map(normalizeHost)])]
}

/** Lowercased, with the root's trailing dot dropped — `API.Example.com.` and
 *  `api.example.com` are the same host, and only one of them matches a naive compare. */
export const normalizeHost = (host: string): string => host.trim().toLowerCase().replace(/\.$/, '')

/**
 * There used to be an `isHostAllowed` here, and its absence is the point.
 *
 * It was the matcher for the per-sandbox forward proxy that `@ogun/gateway` replaced.
 * When that proxy was deleted this function kept every one of its tests and lost every
 * one of its callers — a security rule in the worst possible state, passing loudly while
 * deciding nothing. Two matchers for one question is also how they drift: this one
 * dropped the DNS root's trailing dot and the gateway's did not, so `api.anthropic.com.`
 * was allowed by the tested implementation and refused by the running one.
 *
 * The matcher now lives exactly where the decision is made: `hostMatches` /
 * `isAllowedHost` in `packages/gateway/src/hosts.ts`. This module still *builds* the
 * list — that is a config concern and belongs here — and no longer claims to apply it.
 */
