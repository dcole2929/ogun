/**
 * The container's half of the egress path: where the runner's gateway socket appears
 * inside a sandbox, and the address the image's forwarder presents it at.
 *
 * Three constants and no code, which is the honest shape now that the proxy itself has
 * gone. This file used to be `egress-proxy.ts` and used to contain a second, smaller
 * forward proxy — allowlist only, no TLS interception, no credential injection — running
 * one instance per sandbox. `packages/gateway` does everything it did and the thing it
 * could not do (keep the credential out of the container), so keeping both meant two
 * implementations of one enforcement point, which is two places for a rule to be true in
 * and one place for it to quietly stop being true. The proxy was deleted; these three
 * facts about the *image* outlived it, because they are a contract with
 * `images/base/entrypoint.sh` and `images/base/egress-forwarder.mjs` rather than
 * anything about how the host end is built.
 *
 * Deliberately not moved into `container.ts`: the entrypoint reads two of them out of
 * the environment and the third is baked into the forwarder's default, so they are a
 * shared interface with a file that is not TypeScript and cannot import from here. A
 * name that says "this is the guest side" is what makes the next person check the image
 * before changing a value.
 */

/**
 * Where the gateway's unix socket is bind-mounted inside the container.
 *
 * Under `/run` rather than the workspace, so that nothing an agent is asked to read or
 * write is anywhere near it, and so a `git status` in the workspace never shows it.
 */
export const GUEST_EGRESS_SOCKET = '/run/ogun/egress.sock'

/**
 * The loopback port the in-container forwarder listens on, bridging TCP to the socket.
 *
 * Fixed rather than allocated: the container is `--network none`, so its network
 * namespace holds one interface and one listener, and there is nothing to collide with.
 * A per-container port would be a value to plumb through for no benefit.
 */
export const GUEST_PROXY_PORT = 8118

/**
 * What the *container* puts in `HTTPS_PROXY`, and what `gateway.open()` has to be told.
 *
 * Not where the gateway listens. The gateway listens on a unix socket on the host, and
 * `HTTPS_PROXY` has no syntax for a socket path — the forwarder inside the image exists
 * solely to present that socket as a TCP endpoint. `open()` refuses to guess this rather
 * than composing a plausible address, because a container handed a silently wrong proxy
 * address reaches nothing at all and says nothing about why.
 */
export const GUEST_PROXY_AUTHORITY = `127.0.0.1:${GUEST_PROXY_PORT}`
