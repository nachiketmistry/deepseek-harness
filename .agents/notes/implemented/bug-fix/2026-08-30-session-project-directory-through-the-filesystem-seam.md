# Agent Note: a Session's project directory goes through the filesystem seam

Status: implemented

English | [中文](2026-08-30-session-project-directory-through-the-filesystem-seam.zh.md)

## Problem

Creating a Session ensures its project directory exists, and `session-controller` did that with `mkdir` imported from `node:fs/promises`.

That call is correct in exactly one kind of deployment: one whose files are on the host running the harness. It is wrong wherever the `fs` seam points somewhere else, and it fails outright on Cloudflare, where the Worker's `node:fs` is a stub and the deployment's files live in a sandbox container the Worker cannot reach. Every attempt to start a chat in the Cloudflare web GUI failed with `failed to ensure project directory "/workspace/…": operation not permitted`, which is the stub refusing, not a permission problem anyone could fix in configuration.

Nothing caught it. The seam's whole purpose is that a caller does not know which backend answers, and one direct import silently opted this path out of that for every deployment at once. The composition-parity ledger records rows the Cloudflare build drops, and it cannot record a Node call inside a row it keeps.

## Decision

`ApiSessionAgentController` calls `this.ctx.fs.ensureDirectory(cwd)`, and `SessionController` injects `fs`. The seam already owned the operation; nothing new was added to it.

Injecting rather than reaching for `ctx.get('fs')` is deliberate. A Session whose project directory cannot be created is not a Session, so a deployment that composes this controller without a filesystem provider should fail to activate rather than fail on the first chat. Every profile that composes the controller already composes a provider: `packages/bundle/base` mounts `fs-sandbox`, the Cloudflare build replaces that row with `fs-cf-sandbox`, and `sdk-minimal` mounts `fs-local`.

The two suites that build a context by hand now mount the real `LocalFileSystem` rather than a fake. What those cases assert about a project directory — that creation under a regular file fails, that a raced creation is shared — is host-filesystem behavior, and a stub that answers `undefined` would have turned them into tests of the stub.

`list.ts` still imports `node:fs`'s `stat`, for the cold-blank probe on a session log's own on-disk location. That path is reached only when session persistence reports a physical artifact, which the Durable Object backend does not, so it is left where it is rather than widened speculatively.

## Alternatives considered

**`ctx.get('fs')` with a `node:fs` fallback.** Rejected: it is a hidden default inside a run path, which the repository's explicit-over-implicit rule excludes at package boundaries, and it preserves exactly the failure being fixed — a deployment that forgot its provider would keep silently writing to the host running the harness instead of where its files are.

**A Cloudflare-only branch in the controller.** Rejected: the controller has no business knowing which platform it is on, and the branch would have to be repeated at the next `node:fs` call rather than removed by the seam that already exists.

**Adding `ensureDirectory` to the seam.** Not needed: `FileSystem.ensureDirectory` already existed with the semantics this call wants, which is why the direct import was a violation rather than a gap.

**Leaving it and dropping the Session-creation row from the Cloudflare composition.** Rejected: starting a chat is the product, so the row cannot be dropped, and a parity ledger entry would have recorded a capability gap where there is a two-line fix.

## Consequences

`session-controller` now waits for `fs`, so a hand-built context that provides neither a provider nor the service stalls rather than reaching the assertion. That is the intended failure, and it is loud at activation instead of quiet until someone starts a chat.

The Cloudflare deployment can create a Session, which is what made the [browser acceptance run](../architecture/2026-08-30-edge-verified-principal-and-the-browser-session.md) possible; it was the run that surfaced this.

One `node:fs` import remains in the package, named above. Anything else in `packages/` that reaches for `node:fs` on a path a non-Node deployment executes has the same defect and is not covered by any gate today.
