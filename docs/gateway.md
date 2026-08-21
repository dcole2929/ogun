# The egress gateway

What it is, and how a sandbox gets wired to it. The decision and its rejected
alternatives are ADR-0010; this is the operating manual and the remaining wiring.

---

## 1. What it does

```
container                          runner host                       internet
─────────                          ───────────                       ────────
claude / codex
  reads ~/.claude/.credentials.json
    → { accessToken: "ogun-gateway-placeholder", expiresAt: 2100 }
  sends Authorization: Bearer ogun-gateway-placeholder
  via HTTPS_PROXY ──── CONNECT api.anthropic.com:443 ──→ gateway
                                                          │ token ok?
                                                          │ host allowlisted?
                                                          │ 200, then TLS with a
                                                          │ leaf it signs itself
                       ←──────── request in the clear ────┤
                                                          │ authorization :=
                                                          │   Bearer <real token
                                                          │   read from the host>
                                                          └──── forwarded ──────→
```

The container never holds a credential. It holds a placeholder and a CA certificate.

### The pieces

| File | What it owns |
|---|---|
| `src/der.ts` | The DER subset X.509 needs. No parser — nothing here reads foreign bytes. |
| `src/ca.ts` | The local CA, persisted at `~/.ogun/gateway/`, and a leaf per hostname. |
| `src/hosts.ts` | The allowlist, host-pattern matching, and what a git push looks like. |
| `src/credentials.ts` | Reading the host's real credentials. The only module that does. |
| `src/inject.ts` | Which header carries which provider's credential, and what to strip. |
| `src/stubs.ts` | The placeholder credential files and the container's environment. |
| `src/server.ts` | CONNECT, TLS interception, forwarding, refusals. |
| `src/bridge.ts` | The docker bridge address; the CA's state for `doctor`. |

### Where it runs

In the runner process (`packages/runner/src/main.ts`), started before the claim loop. It
binds the docker bridge gateway address — usually `172.17.0.1`, resolved from
`docker network inspect bridge` — on an ephemeral port, and falls back to loopback on a
machine without docker. `OGUN_GATEWAY_HOST` and `OGUN_GATEWAY_PORT` override both.

Not `127.0.0.1`, because a container's loopback is its own. Not `0.0.0.0`, because that
publishes a credential-injecting proxy to the LAN.

---

## 2. The failure mode, decided

A gateway in the request path is a hard dependency at 3am: if it is down, every job fails,
where today a job with mounted credentials simply runs. That is the cost of the property
and it is paid deliberately.

**In-process, fail-closed, preflighted.**

1. **In-process, not a service.** A separate daemon creates a state that otherwise cannot
   exist — runner up, gateway down — which has to be detected, reported and decided about.
   In one process there is nothing to detect. Restarts are the host supervisor's job (§8).
2. **The runner exits non-zero if the listener cannot bind**, with the port conflict named.
   No degraded mode.
3. **No fallback to mounted credentials, ever.** This is the decision with the sharp edge.
   A fallback trades a loud failure for a silent one: the job runs, nothing looks wrong,
   and the container is holding a live OAuth token exactly as it did before — indefinitely,
   because nobody is looking. A failed nightly review costs a night.
4. **The gateway answers for itself.** A request to a provider host with no host-side
   credential gets `502 no_credential` from the gateway, not a 401 from the provider — the
   gateway knows the actual cause, and the provider's 401 sends whoever reads the
   transcript to re-authenticate something that was fine. Refusals carry
   `x-should-retry: false`, which both provider SDKs honour; without it a permanent
   refusal is retried until the job's budget is gone and is then filed as a timeout.
5. **`ogun runner doctor` reports it before a job is claimed** — the CA's presence and the
   mode of `ca.key`, and per provider what would actually be injected, including how long
   an OAuth token has left.

### What is deliberately not built

- **No token refresh.** The gateway re-reads the credential files on a five-second memo,
  so a refresh the host's own `claude` performs reaches an in-flight job. It does not
  perform one itself. Before the gateway, a container refreshed the copy it was given;
  now the host file is the only live one, and if nothing on the host runs `claude` before
  it lapses, jobs 401. `doctor` names it and says what fixes it. This is a real gap.
- **No approval flow, no rate limits, no per-worker grants, no policy DSL.** §9 lists
  multi-tenancy and RBAC as explicit non-goals.

---

## 3. Wiring `container.ts` — the remaining step

The gateway listens today and nothing uses it: `packages/runner/src/sandbox/container.ts`
still mounts the real credential files. This is the change, precisely.

### 3.1 What the runner needs per job

Before `docker run`, for each job:

```ts
const session = gateway.open()                    // { proxyUrl, token, revoke }
const stubs   = credentialStubs(opts.runtime)     // [{ containerPath, content, mode }]
const env     = sandboxProxyEnv(session.proxyUrl) // the whole environment block
```

Write each stub to a per-job directory on the host (mode `0o600`, inside the job's scratch
space, removed with it), and call `session.revoke()` in `dispose()` — the same place the
container is force-removed. A revoked token stops working immediately, so a container that
outlives its job cannot keep spending the host's credentials.

### 3.2 Mounts to delete

In `credentialMounts()`, delete these two:

```
~/.claude/.credentials.json  →  /host-credentials/claude/.credentials.json
~/.codex/auth.json           →  /host-credentials/codex/auth.json
```

Keep the other two (`settings.json`, `config.toml`) — they are configuration the CLIs need
and neither is a credential by construction. `settings.json` *can* contain an `env` block
with secrets; that is a residual exposure, recorded in ADR-0010 and reportable.

### 3.3 Mounts to add

```
<job scratch>/claude-credentials.json : /host-credentials/claude/.credentials.json : ro
<job scratch>/codex-auth.json         : /host-credentials/codex/auth.json          : ro
<gateway.caCertificatePath>           : /etc/ogun/gateway-ca.pem                    : ro
```

The stubs land at exactly the paths the deleted mounts used, so `images/base/entrypoint.sh`
and `images/base/Dockerfile` need **no change at all** — the entrypoint's `seed` already
copies whatever is at `/host-credentials/...` into the writable home. What changes is only
what is at those paths. `CA_CONTAINER_PATH` in `stubs.ts` is the constant for the third
path; do not spell it twice.

### 3.4 Environment

Merge `sandboxProxyEnv(session.proxyUrl)` into the `--env` list. It is all of:

- `HTTPS_PROXY`, `HTTP_PROXY`, `https_proxy`, `http_proxy` — **both spellings**, because
  curl reads lowercase and some Node libraries read uppercase only. One spelling is a
  container that reaches the internet directly for half its traffic.
- `NO_PROXY`, `no_proxy` = `localhost,127.0.0.1,::1` — both spellings again. Without it a
  project's test suite talking to its own postgres goes through an HTTP proxy and fails in
  a way nobody would connect back to this. If a future sandbox gets a control channel to
  the runner, that host is **appended** to this value, never substituted for it.
- `NODE_USE_ENV_PROXY=1` — Node 24+ ignores `HTTPS_PROXY` in `fetch` without it, and the
  claude CLI is Node. Omit it and the runtime talks straight past the gateway carrying a
  placeholder, every run 401s, and the gateway sits idle looking healthy.
- `NODE_EXTRA_CA_CERTS`, `SSL_CERT_FILE`, `CURL_CA_BUNDLE`, `REQUESTS_CA_BUNDLE`,
  `GIT_SSL_CAINFO` — four TLS stacks, four names, plus git's own.
- `GIT_HTTP_PROXY_AUTHMETHOD=basic` — libcurl otherwise negotiates proxy auth: first
  CONNECT without credentials, take the 407, retry. Forcing basic sends it first time.
- `GIT_TERMINAL_PROMPT=0` — an unattended run that stops to ask for a password hangs until
  the job's budget runs out and is then reported as a timeout.

Set as container environment rather than exported from the entrypoint, so a tool started
outside the entrypoint's process tree — or a `docker exec` session — trusts the gateway
too instead of failing verification.

### 3.5 The `egress` option

`egress: 'open' | 'none'` becomes `'gateway' | 'none'`, with `'gateway'` the default and
`'open'` removed. `'none'` (`--network none`) stays exactly as it is: a tool-only
verification pass needs no network and should have none.

The comment on the `egress` option in `container.ts` currently says a host allowlist
"needs a filtering proxy, which conflicts with the no-sibling-containers rule" and is
"tracked as an open question rather than faked". That is now answered — the proxy is a
host process inside the runner, not a sibling container — and the comment should say so.

### 3.6 The verification container

`verificationOptions()` builds a second container for the test gate. It should get the
same proxy environment and the same CA: a project's suite installs dependencies, and
without the proxy it has no egress at all once `open` is gone. It does **not** need the
credential stubs — no agent runs in it.

### 3.7 Order of operations

1. `session = gateway.open()`
2. write stubs to the job's scratch directory
3. `docker run` with the mounts and environment above
4. on `dispose()`: `session.revoke()`, then remove the containers and the scratch stubs

---

## 4. What is verified, and what is not

### Verified against the live network

Run by hand against this host's real credentials, not in the suite — it needs an account
and it would be a test that fails when the internet does:

- **Anthropic OAuth splicing end to end.** A client speaking real TLS through a real
  CONNECT tunnel, sending `Authorization: Bearer ogun-gateway-placeholder` and
  `anthropic-beta: oauth-2025-04-20`, got `200` from the real `api.anthropic.com`. The
  placeholder was replaced with the host's `sk-ant-oat…` at the wire and the client never
  held it. This is the whole design, working.
- **A public GitHub read with no credential configured.** `GET api.github.com/rate_limit`
  → `200`. Uncredentialed pass-through is the intended default and it is not broken by
  the injection path.
- **The allowlist.** `example.com` → `403` at CONNECT, before any TLS.
- **ADR-0005 at the gateway.** `github.com/.../info/refs?service=git-receive-pack` →
  `403 push_refused`; the same repository's `service=git-upload-pack` → `200` with a real
  pkt-line response. Reading works, writing does not.

### Not verified

The two CLIs' reaction to the stubs, which needs the actual binaries driven end to end:

- that `claude` accepts a `.credentials.json` with an empty `refreshToken` and a
  far-future `expiresAt`, sends `Authorization: Bearer <placeholder>`, and does not try to
  refresh. The fields are shaped from the real file on this host, and the shape is the one
  the reference implementation live-verified for its own harness — but "verified by
  analogy" is not verified.
- that `codex` accepts the stub `auth.json` and its hand-built `id_token`, and that the
  OpenAI arm's `chatgpt-account-id` is what a subscription Codex needs. Nothing on the
  OpenAI side was exercised live.
- that a long-running streaming completion survives the tunnel for its full duration.
  Streaming is tested for arrival *order*, over 150ms, not for minutes.

The first real job through the gateway is the test for those. If a CLI refuses its stub
the symptom will be an auth error *before* any request reaches the gateway — check that
the gateway logged nothing at all before suspecting injection.
