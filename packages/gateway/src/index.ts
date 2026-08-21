/**
 * `@ogun/gateway` — the credential-injecting egress gateway.
 *
 * The problem it exists for: a sandbox used to be handed the host's live OAuth
 * credentials as bind-mounted files, and an `adversarial-review` worker is pointed at
 * exactly the material — a crafted README, a test fixture, a dependency's source — that
 * carries a prompt injection. An agent that reads its own `~/.claude/.credentials.json`
 * and posts it somewhere has taken the host's Anthropic session, and on a real machine
 * that file also holds live OAuth tokens for every MCP server the user has connected.
 *
 * What replaces it: the container gets placeholder credentials that are just real enough
 * for the CLI to start, plus `HTTPS_PROXY` pointing here and a CA to trust. This process,
 * on the host, terminates the TLS, splices the real credential into the request headers,
 * and forwards. You cannot exfiltrate a token that was never in the container.
 *
 * See `docs/adr/0009-the-sandbox-never-holds-a-credential.md` for what was decided and
 * what was rejected, including why this is not a sibling container (ADR-0006) and why a
 * gateway does not reopen the question of pushing from a sandbox (ADR-0005).
 */

export {
  CA_SUBJECT,
  caState,
  defaultCaDirectory,
  defaultSocketPath,
  loadOrCreateCa,
} from './ca.ts'
export type { CaState, CertificateAuthority, Leaf } from './ca.ts'

export {
  credentialReader,
  credentialStatuses,
  defaultCredentialPaths,
  readCredentials,
} from './credentials.ts'
export type {
  Credential,
  CredentialPaths,
  CredentialSet,
  CredentialStatus,
  Provider,
} from './credentials.ts'

export {
  ALLOWED_CONNECT_PORT,
  DEFAULT_ALLOWED_HOSTS,
  hostMatches,
  isAllowedHost,
  isAllowedPort,
  isGitPushRequest,
  parseAuthority,
} from './hosts.ts'

export {
  applyInjections,
  gitBasicAuthorization,
  HOP_BY_HOP_HEADERS,
  injectionsFor,
  planInjections,
  providerForHost,
  requiresCredential,
  stripHopByHop,
} from './inject.ts'
export type { Injection } from './inject.ts'

export {
  CA_CONTAINER_PATH,
  CLAUDE_STUB_CONTAINER_PATH,
  claudeCredentialStub,
  CODEX_STUB_CONTAINER_PATH,
  codexAuthStub,
  credentialStubs,
  PLACEHOLDER,
  sandboxProxyEnv,
} from './stubs.ts'
export type { CredentialStub } from './stubs.ts'

export { proxyToken, startGateway } from './server.ts'
export type { Dial, Gateway, GatewayOptions, GatewaySession, Listening } from './server.ts'
