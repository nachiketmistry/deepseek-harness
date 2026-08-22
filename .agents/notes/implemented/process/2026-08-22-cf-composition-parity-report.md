# Agent Note: composition parity for the Cloudflare deployment

Status: implemented

English | [中文](2026-08-22-cf-composition-parity-report.zh.md)

## Problem

The Cloudflare web host is the web composition minus the rows that cannot run on workerd, plus the `packages/cf/*` providers that stand in for them. The first assembly expressed that subtraction as a `Map` from package name to a prose reason and a separate table of replacement rows, and applied it to the host plane only: preset rows went through the same transform with an empty replacement map, so any preset row naming an excluded package was dropped with no substitute, no error, and no record.

The deployment therefore shipped with capabilities missing and nothing said so. Both shipped presets mount `tool-skill` over a `skills` registry that no provider registers into, so the model is offered a loader whose catalog is always empty. The `code` preset mounts `tool-presentation`, which waits on `codeRuntime` forever, so the preset that exists for Code Mode serves native tools. The host mounts the workflow run UI with no workflow engine behind it. Each was found by reading the generated composition by hand, which is not a signal anyone gets by default.

## Decision

One declaration decides what the build does with a row and what the report says about it. `apps/cf-web/scripts/composition.mjs` maps every web composition row the CF build does not mount as written to a disposition: `replaced` (with the substitute rows, or the substitute the Worker entry mounts ahead of the composition), `not-applicable` (dev-only tooling, another platform, an optional catalog), or `gap` (a capability this deployment does not have, with the rows that stay mounted and depend on it). `CF_SKIPPED_PRESETS` does the same for a preset directory that does not ship.

`compose.mjs` applies the dispositions on both planes and records every disposed row in a ledger. A preset row whose package is replaced on the host plane fails the build unless its disposition says what a preset should do: a host replacement is not automatically right inside a preset, where a second copy of a singleton provider throws at boot.

`scripts/parity.mjs` projects the dispositions and the ledger into [composition-parity.md](../../../../apps/cf-web/composition-parity.md) — capability gaps with their status and orphaned dependents, the host plane row by row, and per-preset row counts against the web app. The `build` script runs it, so the report tracks the bundle that is deployed; `parity:check` fails when the checked-in file is out of date.

The generator refuses to write a report it cannot stand behind. It fails on a disposition for a row the web composition no longer carries, a gap naming an orphan the composition no longer mounts, a replacement neither the composition nor `src/worker.ts` mounts, a `replaced` disposition that names no substitute, and a skipped preset whose directory is gone.

## Alternatives considered

- **A hand-written tracker in the README or an Agent Note** — rejected: the gaps it would list are exactly the facts that already drifted out of the README, which still described `src/worker.ts` as a placeholder after the Host Durable Object shipped. A tracker maintained beside the build, rather than by it, rots at the same rate as the thing it tracks.
- **Fail the build on any gap** — rejected: Code Mode, the workflow engine, and `cordis-host-runner` need `node:worker_threads` or `node:vm` and are out of scope by decision. A gate that cannot express "known and accepted" is turned off, and turning it off is how the unknown gaps hid among the known ones. `status` carries that distinction instead, and the stale-claim checks are what fail.
- **Derive the dangling consumers instead of declaring them** — rejected for now: a module-level `inject` is readable from the built package, but the losses that matter here are registry seams (`skills` has a registry and no registrations) and a lazy `ctx.inject` inside a plugin body, neither of which a static read reports. Declaring the dependents and verifying each is still mounted gives the same protection against rot without inferring the relationship.

## Consequences

A capability leaving the Cloudflare deployment is now a diff in a checked-in report rather than something found by poking at the running app, and the two planes are transformed by the same rules. The cost is a declaration to maintain: a new row excluded from the CF composition does not build until its disposition is written, and a gap must name what it costs and what still depends on it.

The report is generated, not translated: it carries no Chinese counterpart, as with `gate0-imports.md`.

The open gaps it records at the time of writing are skills and the `minimal` preset; the workflow engine, Code Mode, and self-modification are recorded as out of scope, tracked by [the Cloudflare web host proposal](../../proposed/architecture/2026-08-21-cloudflare-web-host.md).
