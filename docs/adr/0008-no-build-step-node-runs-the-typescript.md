---
status: accepted
---

# No build step: Node runs the TypeScript

The server, runner and CLI are TypeScript on Node 24+, which strips types natively. That
makes a compile step optional, and an optional step that sits in every edit-run cycle is
worth examining rather than inheriting.

`node packages/server/src/main.ts` runs the server. `tsc` is typecheck-only — `pnpm
typecheck` is a gate, not a build — and there is no `dist/` for the server, runner or CLI
sources.

The price is a dialect restriction. `erasableSyntaxOnly` is on, so no enums and no
parameter properties: the constructs whose meaning survives type erasure only if something
emits code for them. That is compiler-enforced rather than a convention, and it is a fair
trade for deleting a compile step from every change.

## Considered Options

- **Compile with `tsc` to `dist/` and run that.** Rejected — it buys back enums and
  parameter properties, and charges a compile step on every edit, every run, and every
  stack trace. The dialect restriction costs less than the step does.
- **Bundle the server and runner the way the CLI is bundled.** Rejected — the CLI is
  bundled with esbuild for a specific reason: it ships *into* the sandbox image, so it must
  carry no `node_modules` and must not drift from the validator it enforces on the way back
  in. The server and runner never leave the host and get none of that.

## Consequences

- Two things are still built, both deliberately: the web app with Vite, and the CLI binary
  that goes into the sandbox image with esbuild.
- Code in `packages/` may not use enums or parameter properties. A reviewer finding a *use*
  of one has found a real break — the process will not start. A reviewer proposing that the
  project adopt a build step so those constructs become available is re-litigating this.
- Stack traces point at source files that exist, with nothing between a 3am crash and the
  line that caused it.
