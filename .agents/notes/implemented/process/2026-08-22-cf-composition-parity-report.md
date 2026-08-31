# Agent Note: composition parity for the Cloudflare deployment

Status: implemented

English | [中文](2026-08-22-cf-composition-parity-report.zh.md)

## Problem

The Cloudflare web host is the web composition minus the rows that cannot run on workerd, plus the `packages/cf/*` providers that stand in for them. The first assembly expressed that subtraction as a `Map` from package name to a prose reason and a separate table of replacement rows, and applied it to the host plane only: preset rows went through the same transform with an empty replacement map, so any preset row naming an excluded package was dropped with no substitute, no error, and no record.

A report of what is mounted answers only half the question in any case. A substitute can be mounted, bundled, and evaluated on workerd while throwing from every method or returning nothing where the Service Definition promises a value, and the composition cannot tell the difference.

The deployment therefore shipped with capabilities missing and nothing said so. Both shipped presets mount `tool-skill` over a `skills` registry that no provider registers into, so the model is offered a loader whose catalog is always empty. The `code` preset mounts `tool-presentation`, which waits on `codeRuntime` forever, so the preset that exists for Code Mode serves native tools. The host mounts the workflow run UI with no workflow engine behind it. Each was found by reading the generated composition by hand, which is not a signal anyone gets by default.

## Decision

One declaration decides what the build does with a row and what the report says about it. `apps/cf-web/scripts/composition.mjs` maps every web composition row the CF build does not mount as written to a disposition: `replaced` (with the substitute rows, or the substitute the Worker entry mounts ahead of the composition), `not-applicable` (dev-only tooling, another platform, an optional catalog), or `gap` (a capability this deployment does not have, with the rows that stay mounted and depend on it). `CF_SKIPPED_PRESETS` does the same for a preset directory that does not ship.

`compose.mjs` applies the dispositions on both planes and records every disposed row in a ledger. A preset row whose package is replaced on the host plane fails the build unless its disposition says what a preset should do: a host replacement is not automatically right inside a preset, where a second copy of a singleton provider throws at boot.

`scripts/parity.mjs` projects the dispositions and the ledger into [composition-parity.md](../../../../apps/cf-web/composition-parity.md) — capability gaps with their status and orphaned dependents, the host plane row by row, and per-preset row counts against the web app. The `build` script runs it, so the report tracks the bundle that is deployed; `parity:check` fails when the checked-in file is out of date.

`scripts/fidelity.mjs` answers the second half. It scans each substitute's own source for a method body that is one unconditional `throw`, an empty body, or a single `return` of an absent value, and `parity.mjs` reconciles the findings against the `reduced` list on the disposition that names the substitute: an undeclared finding and a declaration the source has outgrown both fail. `degraded` states a platform limit no scan can see — the Sandbox SDK exposing no process stdin, a passthrough sandbox reporting `partial` enforcement — and the report labels it declared rather than derived, so nobody reads it as verified.

Absent-value literals only: a capability getter answering `true` declares that the deployment has the capability, which is the shape the Service Definition asks for. A stub returning `true` from real work is the accepted blind spot.

Test counts are reported and not enforced. `pnpm run test:coverage` is the gate that owns them — per-file 100% over `packages/*/*/src`, with no exemption for `packages/cf` — and duplicating enforcement would put two gates on one fact.

The generator refuses to write a report it cannot stand behind. It fails on a disposition for a row the web composition no longer carries, a gap naming an orphan the composition no longer mounts, a replacement neither the composition nor `src/worker.ts` mounts, a `replaced` disposition that names no substitute, and a skipped preset whose directory is gone.

## Alternatives considered

- **A hand-written tracker in the README or an Agent Note** — rejected: the gaps it would list are exactly the facts that already drifted out of the README, which still described `src/worker.ts` as a placeholder after the Host Durable Object shipped. A tracker maintained beside the build, rather than by it, rots at the same rate as the thing it tracks.
- **Fail the build on any gap** — rejected: Code Mode, the workflow engine, and `cordis-host-runner` need `node:worker_threads` or `node:vm` and are out of scope by decision. A gate that cannot express "known and accepted" is turned off, and turning it off is how the unknown gaps hid among the known ones. `status` carries that distinction instead, and the stale-claim checks are what fail.
- **Fail the build on a provider with no tests** — rejected: `test:coverage` already fails on every `packages/cf/*` source file, and a second gate asserting the same thing would be the one that gets exempted. The parity report states the count and cites the gate that enforces it.
- **Derive the dangling consumers instead of declaring them** — rejected for now: a module-level `inject` is readable from the built package, but the losses that matter here are registry seams (`skills` has a registry and no registrations) and a lazy `ctx.inject` inside a plugin body, neither of which a static read reports. Declaring the dependents and verifying each is still mounted gives the same protection against rot without inferring the relationship.

## Consequences

A capability leaving the Cloudflare deployment is now a diff in a checked-in report rather than something found by poking at the running app, and the two planes are transformed by the same rules. The cost is a declaration to maintain: a new row excluded from the CF composition does not build until its disposition is written, and a gap must name what it costs and what still depends on it.

The report is generated, not translated: it carries no Chinese counterpart, as with `gate0-imports.md`.

At the time of writing the fidelity scan records four reductions — no bound address on the Worker carrier, no per-session artifact to locate, no authorable preset location, and the Sandbox SDK's stdin and signal limits — of which read-only presets is the one a user meets: the GUI cannot duplicate or edit a preset on this deployment. It also records that 15 of 16 substitutes have no test suite.

The open gaps it records at the time of writing are skills and the `minimal` preset; the workflow engine, Code Mode, and self-modification are recorded as out of scope, tracked by [the Cloudflare web host proposal](../../proposed/architecture/2026-08-21-cloudflare-web-host.md).
