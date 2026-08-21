---
status: accepted
---

# The sandbox never holds a credential

ADR-0005 removed the *git* credential from the container and made the never-pushes rule
structural. It left the model credentials where they were: `~/.claude/.credentials.json`
and `~/.codex/auth.json` bind-mounted read-only, copied into a writable home by the
entrypoint, with egress `open`. §4.6 called the worst case "burning rate limit".

That was wrong twice over. An `adversarial-review` worker is pointed, on purpose, at
exactly the material that carries prompt injection — a crafted README, a test fixture, a
dependency's source — and the first thing an injected agent can do is read its own
credential file and post it to an allowed host. And that file is not only the Anthropic
session: on a working machine `~/.claude/.credentials.json` also carries `mcpOAuth`, with
live access *and refresh* tokens for every MCP server the user has connected. Ogun was
handing an unattended agent a set of third-party credentials from unrelated products.

So the container gets **placeholder** credentials — real enough in shape for the CLI to
decide it is logged in, worth nothing to anyone who steals them — plus `HTTPS_PROXY`
pointing at a gateway on the runner host and a CA to trust. The gateway terminates the
TLS, splices the real credential into the request headers, and forwards. You cannot
exfiltrate a token that was never in the container.

`packages/gateway` is the whole of it: a local CA minting a leaf per hostname, CONNECT
with TLS interception, a host allowlist, and injection for three providers (`anthropic`,
`openai`, `github`). It runs **in the runner process**, not beside it.

## Considered Options

- **Leave the credentials mounted and rely on the container boundary.** Rejected — the
  boundary is real and irrelevant. It stops the agent reaching the host; it does nothing
  about an agent that reads a file it was handed and makes an ordinary HTTPS request with
  the contents. Every protection in ADR-0005 and ADR-0006 is intact while this happens.
- **A separate gateway service, supervised like the server and the runner.** Rejected —
  it creates a state that otherwise cannot exist: runner up, gateway down. That state has
  to be detected, reported, and decided about, and each of those is a thing to get wrong
  at 3am. In one process there is nothing to detect: if the runner is claiming jobs the
  gateway is listening, because they are the same object. §8 already says restarts are
  the host's supervisor's business, and this inherits that unchanged.
- **Fall back to mounting credentials when the gateway is unavailable.** Rejected, and
  this is the decision with the sharpest edge. The fallback trades a loud failure for a
  silent one: the job runs, nothing looks wrong, and the container is holding a live OAuth
  token exactly as it did before — indefinitely, because nobody is looking. A failed
  nightly review costs a night. A leaked credential costs whatever it can reach. **The
  runner refuses to start if the gateway cannot bind, and a job whose request the gateway
  cannot serve fails with a reason.**
- **A filtering proxy as a sibling container.** Rejected by ADR-0006, and that ADR
  explicitly names this as why the per-host allowlist "has no cheap implementation". The
  gateway is a *host process inside the runner*, which is not a sibling container and
  needs no daemon reach — so ADR-0006 is not being re-litigated, its premise simply does
  not apply to this shape. ADR-0005's paragraph on the allowlist is amended accordingly.
- **`iptables` inside the container.** Rejected — it needs `NET_ADMIN` plus a privilege
  drop, which hands back capability the profile exists to remove, and it still fails
  against endpoints whose IPs rotate. It also does nothing at all about the actual
  problem: an allowlisted `api.anthropic.com` is exactly where a stolen Anthropic token
  would be spent.
- **A policy engine — rules, conditions, per-worker grants, approval flows.** Rejected.
  §9 lists multi-tenancy and RBAC as explicit non-goals and Ogun is one user on one host.
  A rule language here would be configuration for a decision that has one right answer:
  the sandbox gets the host's credentials for the runtime it is running, and nothing else.
- **Rust, following the reference implementation this was studied from.** Rejected —
  ADR-0008 settles that Node runs the TypeScript with no build step, and a second
  toolchain in the request path would undo it for a component Node can express: `node:tls`
  terminates the interception, `node:http` emits `'connect'`, and `node:crypto` signs.
- **A certificate library for the CA.** Rejected — this is the one module that holds a
  signing key capable of impersonating every host every Ogun container trusts, and a
  dependency in that position is a supply-chain hole aimed at the thing the gateway
  exists to protect. The DER subset X.509 needs is ~150 lines that never parse
  attacker-controlled input, and Node's own X.509 parser plus a real TLS handshake check
  the output in the tests.

## Consequences

- **The gateway is in the request path, so it is a hard dependency.** Every agent request
  goes through it. That is the cost of the property, and it is paid deliberately rather
  than mitigated: the failure mode is fail-closed at three points — the runner exits
  non-zero if the listener cannot bind; a request to a provider host with no host-side
  credential is answered `502 no_credential` by the gateway itself rather than forwarded
  to collect somebody else's 401; and `ogun runner doctor` reports the CA's presence and
  mode plus what each provider would actually be handed, before a job is ever claimed.
- **A per-job token, revoked when the job ends.** The listener is on the docker bridge
  address, reachable from every container on the host — so "can you connect" and "may you
  use it" are different questions. Without the token the gateway would be an open
  credential oracle for anything else on the box.
- **The gateway does not refresh an OAuth token; it re-reads the file the host refreshes.**
  This is a real gap and it is named rather than hidden. Before, a container refreshed the
  copy it was given; now the container has a placeholder that never expires and the *host*
  file is the only live one. If nothing on the host runs `claude` before the token lapses,
  jobs 401. `doctor` says "expired 6h ago — run `claude` once on this host", which is the
  difference between a two-minute fix and an evening. **A finding that the gateway should
  refresh is a real finding.**
- **The allowlist is not the security property.** It bounds what a compromised agent can
  reach through the gateway's connection, which is worth having. It does not stop
  exfiltration: `api.anthropic.com` is on the list, and anything an agent can put in a
  prompt leaves through it. ADR-0005 said that was a different and harder problem. It
  still is, and this does not close it.
- **Egress moves from `open | none` to allowlist-by-default.** A project whose test suite
  reaches a host outside the default list will fail its verification gate where it used to
  pass. The list is a constant with a reason written beside every entry (`hosts.ts`); the
  per-project extension point is designed and unbuilt.
- **The container, the image and the entrypoint are unchanged.** The stubs land at the
  same `/host-credentials/...` paths `entrypoint.sh` already copies from, so what changes
  is only *what is at those paths*. That was the deciding factor between several
  bootstrap shapes.
- **`~/.claude/settings.json` and `~/.codex/config.toml` are still mounted, and they can
  contain secrets.** `settings.json` supports an `env` block. Removing them is a separate
  change with its own behaviour risk; carrying them across is a residual exposure and is
  reportable.
- **This does not settle how the runner passes the session to a container.** The wiring —
  which mounts to delete, which env to set, where the CA is bind-mounted — is written out
  step by step in `docs/gateway.md` and is mechanical, but `packages/runner/src/sandbox/
  container.ts` still mounts the real credential files today. Until that lands, the
  gateway listens and nothing uses it. **A finding that the sandbox still receives live
  credentials is a real finding.**
