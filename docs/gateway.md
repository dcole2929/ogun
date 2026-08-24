# The egress gateway

What it is, and how a sandbox is wired to it. The decision and its rejected
alternatives are ADR-0010; this is the operating manual.

---

## 1. What it does

```
container                          runner host                       internet
─────────                          ───────────                       ────────
claude / codex
  reads ~/.claude/.credentials.json
    → { accessToken: "ogun-gateway-placeholder", expiresAt: 2100 }
  sends Authorization: Bearer ogun-gateway-placeholder
  via HTTPS_PROXY -> the image's forwarder -> a bind-mounted unix socket
                  ──── CONNECT api.anthropic.com:443 ──→ gateway
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

### Where it runs, and why on a unix socket

In the runner process (`packages/runner/src/main.ts`), started before the claim loop,
listening on `~/.ogun/gateway/proxy.sock` at mode 0600. `OGUN_GATEWAY_HOST` /
`OGUN_GATEWAY_PORT` switch it to TCP, which is what a `worktree` sandbox and the tests use.

The socket is the part that matters, and it is not a detail of packaging.

**On any network, `HTTPS_PROXY` is advice.** A container on a bridge network has an
interface, and a prompt-injected agent declines the proxy with `curl --noproxy '*'` and
talks to the internet directly — taking the allowlist, the injection, and every guarantee
above them with it. A container run `--network none` has no interface to decline with. The
socket is a file, so it crosses the same boundary docker already crosses for the workspace,
and it is the container's only route out. Enforcement stops being a variable the agent can
unset and becomes the shape of the network.

That also means the gateway's own address is not what the container puts in `HTTPS_PROXY`:
that variable has no syntax for a socket path. A small forwarder inside the image bridges a
loopback address to the socket, and `open(containerAuthority)` is told what that address is.
`open()` throws rather than guessing one, because a container handed a plausible-but-wrong
proxy address talks to nothing at all and says nothing about why.

The socket transport and the `--network none` sandbox came from a parallel workstream that
also shipped a second, smaller proxy of its own — allowlist only, one per sandbox. Both are
gone into this one; §3 is what replaced them.

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
   an OAuth token has left. A token is `ok` only while it outlives the next hour;
   `present` is not the question, because an expired token is present.
6. **Admission refuses a job that cannot log in**, rather than dispatching it to fail
   (§4.3). The window it checks is the worker's own `timeoutMs`, not the current instant:
   a token with five minutes left is valid right now and dead halfway through the job.
   The refusal is recorded as `refused` with the fix in the reason — a failure would be
   the wrong name for it and would latch the breaker against a worker that is fine.

### What is deliberately not built

- **No token refresh.** The gateway re-reads the credential files on a five-second memo,
  so a refresh the host's own `claude` performs reaches an in-flight job. It does not
  perform one itself, and both ways of doing so are rejected in ADR-0010: refreshing in
  memory risks the provider rotating the refresh token and logging the user out of their
  own CLI, and writing the result back races the host's `claude` over the same file.
  What replaces it is a preflight (above) plus the configuration that has nothing to
  refresh — an explicit `ANTHROPIC_API_KEY` does not expire, `credentials.ts` already
  prefers it, and `docs/setup.md` says so. The gap is real and narrowed, not closed.
- **No expiry check for codex.** `~/.codex/auth.json` records no expiry in the fields the
  gateway reads. The access token's JWT payload could be parsed for one; deliberately not
  done — it adds an unverified parse of a credential body to the one code path that must
  not throw, to predict what a 401 answers authoritatively. Codex jobs are therefore never
  refused on expiry grounds, and `doctor` says the expiry is unrecorded rather than
  printing a healthy-looking line for something nothing checked.
- **No approval flow, no rate limits, no per-worker grants, no policy DSL.** §9 lists
  multi-tenancy and RBAC as explicit non-goals.

---

## 3. How a sandbox is wired to it

`packages/runner/src/sandbox/container.ts` mounts placeholder credentials and points every
container at the socket. This is what it does, and why each part of it is the way it is.

### 3.1 Per job

`provision()` runs once per job (§5.2), before the first `docker run`, and does this:

```ts
session = gateway.open(GUEST_PROXY_AUTHORITY, allow)  // { proxyUrl, token, revoke }
stubDir = tmpdir()/ogun-credentials/<container name>
for (stub of credentialStubs(opts.runtime)) write it there, then chmod 0600
egressSession = { socketPath, caCertificatePath, proxyUrl, stubs }
```

`GUEST_PROXY_AUTHORITY` is `127.0.0.1:8118` — the loopback address the image's forwarder
listens on, which is the *container's* view of the proxy and not where the gateway listens.
`open()` throws rather than guessing one, because a container handed a
plausible-but-wrong proxy address talks to nothing at all and says nothing about why.

`allow` is this worker's resolved list, not the gateway's. One gateway serves every job on
the machine, so passing the global list would quietly widen every worker to the union of
all of them — the kind of regression that never fails a test, it just stops refusing
things.

Ordering is load-bearing in a way docker will not warn about: bind-mounting a source path
that does not exist makes docker create an empty *directory* there, and a CLI would then
find a directory where it expects its credential file and fail with something that reads
nothing like an egress fault.

`dispose()` reverses it: `session.revoke()` **first**, then `docker rm -f` on both
containers, then the stub directory.

Revoking **is** closing, and for a long time it was not. `revoke()` used to be
`sessions.delete(token)` and nothing more, and the token is consulted exactly once — on the
CONNECT that builds a tunnel. After that, TLS is terminated and the plaintext socket is fed
to an HTTP server that reads its target off the socket and calls `prepare()`, which
re-reads the host's live credential file on *every* request. So a tunnel opened while the
token was alive kept receiving freshly spliced, currently-valid credentials for as long as
it stayed open, no matter how many times `revoke()` was called. The comment in
`container.ts` named the leak — "a token that outlived a container we failed to remove" —
and then leaned on `docker rm -f` to close it, in the same breath as admitting `docker
rm -f` can hang or fail. The case it named was the case nothing covered. Under this
component's threat model that is not a corner: the adversary is a prompt-injected agent,
which can hold a socket open on purpose with a heartbeat request.

It is now two halves, because either alone has a gap:

- **Every connection is remembered by the session that opened it**, and `revoke()` destroys
  them — the CONNECT tunnels, and the upgraded relays on the absolute-form door which never
  become tunnels at all. The bookkeeping is one rule: added when the connection is
  accepted, removed on its `'close'`. A map of sockets that only grows would be its own bug
  in a process meant to run for weeks. `close()` does the same sweep for every session at
  once — `proxy.closeAllConnections()` does not reach these, because `node:http` stops
  tracking a socket the moment it hands it to `'connect'` or `'upgrade'`.
- **Every request re-checks the grant**, on the intercepted `'request'` and `'upgrade'`
  doors, by comparing the `Session` marked on the socket at CONNECT against the one the map
  holds now. In the ordinary case this never fires, which is the point: it covers a request
  that crossed the revoke in flight, and it means "does this connection still have a grant"
  is not answered solely by a `Set` being correct. A revoked tunnel answers `403
  session_revoked` with `x-should-retry: false` — not `407`, because inside the tunnel the
  client believes it is talking to the provider and a proxy challenge from the provider is
  both nonsense and an invitation to retry forever.

Revocation is per session, never global. `revoke()` runs at the end of *every* job on a
gateway shared by every container on the host, so closing "the open sockets" instead of
"this session's open sockets" would end one job by cutting the model turn of every other
job on the machine — and on the Codex path, where the turn *is* the connection, that is
total. Two tests hold that line, one per door.

Tearing down does not disturb a job that is finishing cleanly, and that is a property of
where `dispose()` is called rather than of timing: it runs in the pipeline's `finally`,
after every `exec()` has resolved, so every `docker run` for the job has already exited. A
socket still open at that moment belongs to a container that outlived its run. The
verification container is covered by the same fact — it is another `exec()` on the same
session and has long since exited too.

Revoking still goes first. A container about to be force-removed has no legitimate request
left to make, and reversing the order would leave a window between the last container dying
and the token dying.

`docker rm -f` is consequently back to being a resource cleanup rather than a security
control, and its failure is now **reported**. It used to be swallowed with
`.catch(() => undefined)`, which was defensible only because on the normal path the command
fails: `--rm` has already removed the container, so `docker rm -f` says "No such container".
On the normal path there is nothing here to remove and the command says so, and a report
that could not tell that from a real failure would print a line per job and be muted inside
a week — so the two are told apart. An already-gone container is silent (exit 0 on current
docker, `No such container` on older); a daemon that is wedged, out of disk, or refusing
the removal gets one warning naming the container and what docker said. Warned, never thrown: `dispose()`'s caller discards what it throws, so a throw would
be swallowed one level up *and* skip the stub-directory removal below it.

### 3.2 One gateway, or one per sandbox

One per **runner**, owned by `main.ts`, which already starts it before the claim loop and
closes it after the last in-flight job. The alternative — a gateway per sandbox, matching
the lifecycle the deleted proxy had — was the smaller change and was rejected:

- The gateway holds a CA private key that can impersonate every host every Ogun container
  trusts, and it is the only process that reads the host's real credentials. A copy per job
  multiplies exactly the surface this component exists to shrink.
- The isolation it would buy, the session already provides and better. A per-job socket
  bounds *which container can connect*; a per-job token bounds *which container can still
  spend the host's credentials*, and it keeps bounding it after a `--rm` that did not fire.

What that costs, named rather than waved at: the socket file is shared by every container
on the host, so the boundary between two jobs is the token and not the filesystem; the
"already being served" check in `startGateway` becomes load-bearing rather than defensive,
because two runners on one machine really would disagree about which gateway the containers
are talking to; and `~/.ogun/gateway/` must never be bind-mounted as a directory, because
`ca.key` lives in it.

### 3.3 Mounts

```
<stub dir>/.credentials.json  : /host-credentials/claude/.credentials.json : ro
<stub dir>/auth.json          : /host-credentials/codex/auth.json          : ro
<gateway.caCertificatePath>   : /etc/ogun/gateway-ca.pem                   : ro
~/.ogun/gateway/proxy.sock    : /run/ogun/egress.sock                      : rw
~/.claude/settings.json       : /host-credentials/claude/settings.json     : ro
~/.codex/config.toml          : /host-credentials/codex/config.toml        : ro
```

The stubs land at exactly the paths the deleted credential mounts used, so
`images/base/entrypoint.sh` and `images/base/Dockerfile` needed **no change at all** — the
entrypoint's `seed` already copies whatever is at `/host-credentials/...` into the writable
home. What changed is only what is at those paths. `CA_CONTAINER_PATH` in `stubs.ts` is the
constant for the third path; it is not spelled twice.

The socket mount is read-**write**: a unix socket that cannot be written to cannot be
connected to. It is the one mount that has to be, and its 0600 mode on the host is what
keeps it to this user; the container runs as uid 1000, the same uid the runner does. It is
mounted as a *file* — never its directory, which holds `ca.key`.

`settings.json` and `config.toml` are kept: configuration the CLIs need, neither a
credential by construction. `settings.json` *can* contain an `env` block with secrets; that
is a residual exposure, recorded in ADR-0010 and reportable.

### 3.4 Environment

`sandboxProxyEnv(session.proxyUrl)` is merged into the `--env` list whole, from
`@ogun/gateway`, rather than rebuilt in the runner — the list is long, every entry has a
failure mode attached, and a second copy would drift from the one the gateway's own tests
assert against. It is all of:

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

Plus `OGUN_EGRESS_SOCKET` and `OGUN_EGRESS_PORT`, which the entrypoint reads to start the
forwarder. Absent, the entrypoint starts nothing and the container is simply airgapped.

Set as container environment rather than exported from the entrypoint, so a tool started
outside the entrypoint's process tree — or a `docker exec` session — trusts the gateway
too instead of failing verification.

The `proxyUrl` carries the session token as basic credentials, which puts it in the
container's environment and in the runner's `docker run` argv. The socket's 0600 mode is
what keeps other host accounts out; the token bounds a *container*, so a host user who
could read the argv still has nothing to connect with.

### 3.5 The `egress` option

All four spellings kept, and this diverges from what this section originally proposed —
which was to remove `open` and rename the default to `gateway`. That was not done: `open`
is an escape hatch a project with a wide test suite genuinely needs, existing configs use
it, and the rename buys a word.

| `egress:` | Network | Credential |
|---|---|---|
| *absent* | `--network none` + socket | placeholder |
| a list | `--network none` + socket | placeholder |
| `open` | default bridge, no socket | **the real one** |
| `none` | `--network none`, nothing mounted | none at all — not even a placeholder |

`open` is the one path with no gateway to splice a credential in at, so the choice there is
a mounted token or an agent that cannot authenticate. It mounts, and `provision()` warns
every run naming both halves. `credentialMounts()` is deliberately the single place to look
for "does a sandbox ever see a real token".

An allowlist with no resolved session — which can only happen if `provision()` did not run
— falls to `--network none`, because the alternative is a bug in the runner's own lifecycle
silently restoring unrestricted internet with a real credential in it.

The comment on the `egress` option in `container.ts` used to say a host allowlist "needs a
filtering proxy, which conflicts with the no-sibling-containers rule" and was "tracked as an
open question rather than faked". That is answered: the proxy is a host process inside the
runner, not a sibling container.

### 3.6 Refusals the runner makes before starting a container

Three, all fail-closed, all naming the fix:

- **No gateway passed to a container sandbox.** A runner wiring bug rather than a
  configuration one, and the honest alternatives are "airgap" or "put the credential back".
- **The gateway is listening on TCP.** A `--network none` container has its own network
  namespace and no interface, so it cannot reach a loopback listener in the runner's.
  `OGUN_GATEWAY_HOST`/`OGUN_GATEWAY_PORT` exist for a `worktree` sandbox and for pointing
  something at the gateway by hand; a container gets the socket or nothing. `main.ts` says
  so at startup too, before a job is claimed.
- **An image that does not declare `OGUN_EGRESS_FORWARDER`.** An image built before the
  forwarder gets `--network none` and nothing to bridge with, so a *tightened* policy
  presents as a total airgap and is reported by the agent as an authentication failure.
  Project images inherit the marker from `FROM ogun/base`, so this is telling you to
  rebuild, which is the actual fix.

### 3.7 The verification container

`verificationOptions()` builds a second container for the test gate, and it shares the
agent's session — the same socket, the same CA, the same allowlist, one denial log. It
needs egress: a project's suite installs dependencies, and a gate with no route out fails as
a red suite that gets blamed on the modifier whose patch it was gating.

It gets **no credential file at all** — not the placeholder, and not `settings.json`. No
agent runs in it, and a test suite has no business holding either.

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

### Found by adversarial review, after it all passed

Worth recording, because the tests that existed at the time did not catch any of it:

- **Absolute-form `http://` put a real credential on plaintext TCP/80.** The scheme check
  was `protocol.startsWith('http')`, which accepted both `http:` and `httpz:`. A sandbox
  sending `GET http://api.anthropic.com/v1/messages` at the proxy port cleared the
  allowlist, had the host's live OAuth token spliced in, and had it sent unencrypted. The
  container still never held the token — the token was simply readable on the wire. The
  absolute-form path had no end-to-end test at all, which is why.
- **Cancelled responses leaked the upstream forever.** `pipe` forwards data and nothing
  else — not errors, not destruction — so an agent cancelling a turn left the upstream
  socket open and still being written, once per cancelled turn, with the provider still
  generating and billing. The mirror case was as bad: an upstream dying mid-body left the
  client waiting on a `content-length` that would never arrive until its own timeout, so
  the run was filed as a timeout rather than the upstream failure it was. `pipeline`
  fixes both directions.
- **Percent-encoding walked around ADR-0005.** GitHub decodes before routing, so
  `/git-receive-pac%6b` is a push; the matcher compared raw bytes and said it was not.
- **The CONNECT port was parsed and then ignored**, so `api.anthropic.com:22` was an
  allowlisted name pointing at somebody else's SSH port. `parseAuthority` had carried a
  comment claiming exactly this check since the first commit.
- **An unconditional `rm` of the socket** let a second runner silently steal the path from
  a first that was still serving containers, with nothing reporting the split brain.
- **The streaming test was vacuous.** It timed when the *upstream* saw the request, which a
  fully buffering proxy does exactly as fast. It would have passed against an
  implementation it was written to distinguish from.
- **`revoke()` only blocked the next CONNECT.** The token is checked once, when the tunnel
  is built; every request inside it thereafter took its target off the socket and re-read
  the host's live credential file, with nothing on that path ever consulting `sessions`
  again. A tunnel opened while the token was alive went on being handed real, current
  credentials for as long as it stayed open — and the upgrade doors, which hold the
  longest-lived sockets in the component, were worse: after the 101 they are two pipelines
  relaying bytes with no further reference to anything. See §3.1.

The pattern is worth naming: every bug was in a path with no test, and the one bad test was
bad in the specific way that made it pass. Coverage now includes the absolute-form door,
tunnel reuse, HEAD and 304, a non-443 CONNECT, cancellation, upstream death mid-body, and a
push refused with half a megabyte still uploading.

### Verified through the wired path

Run by hand against a real container on this host, once `container.ts` was wired:

- **`claude` accepts its stub and authenticates.** A `--network none` container on
  `ogun/base` and on a project image both completed a real `api.anthropic.com` turn with
  only the placeholder mounted. The CLI did not try to refresh — the empty `refreshToken`
  and far-future `expiresAt` do what they were shaped to do.
- **The container holds nothing.** The agent in that container, asked to read its own
  credential, found a 274-byte file whose `accessToken` is the literal
  `ogun-gateway-placeholder`, byte-identical to what is at `/host-credentials`, and
  `grep -rIl 'sk-ant-oat'` over its home and `/host-credentials` matched nothing but the
  transcript of the prompt that asked.
- **A non-allowlisted host is refused, and cannot be walked around.** `example.com`
  gives `curl: (56) CONNECT tunnel failed, response 403`, logged host-side as
  `refused example.com: not on this worker's allowlist`. The same container running
  `curl --noproxy '*' https://example.com` gets `Could not resolve host` — there is no
  interface to decline the proxy with.
- **`egress: none` is a genuine airgap**, and now holds no credential file either: the CLI
  reports `Not logged in` and the run exits non-zero.
- **The `OGUN_EGRESS_FORWARDER` refusal still fires** against an image built without it.
- **The verification container holds nothing.** `/host-credentials` does not exist in it.
- **`egress: open` still works**, on a bridge network, with the real credential mounted and
  the warning printed.

### Still not verified

- that `codex` accepts the stub `auth.json` and its hand-built `id_token`, and that the
  OpenAI arm's `chatgpt-account-id` is what a subscription Codex needs. Nothing on the
  OpenAI side has been exercised live, at any point.
- that a long-running streaming completion survives the tunnel for its full duration.
  Streaming is tested for arrival *order*, over 150ms, not for minutes. The longest live
  run through the gateway so far was a three-turn tool-using session of about 35s.

If a CLI refuses its stub the symptom will be an auth error *before* any request reaches
the gateway — check that the gateway logged nothing at all before suspecting injection.
