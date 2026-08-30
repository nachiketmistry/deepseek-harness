# @deepseek-ai/dsh-cf-web

English | [中文](README.zh.md)

The dsh web GUI assembled for Cloudflare: a Worker serves the browser shell, one Host Durable Object hosts the harness plugin tree, and one Sandbox SDK container per user holds the git projects that sessions work in. This app owns the wrangler configuration, the Worker entry, and the workerd bundle of the host tree; the Cloudflare Service Providers live under `packages/cf/*`.

## Gate 0: the web host tree on workerd

`pnpm --filter @deepseek-ai/dsh-cf-web run gate0` bundles every package row of the web composition (`packages/bundle/base` plus `packages/bundle/web-app`) for workerd through the workspace resolver and writes [gate0-imports.md](gate0-imports.md): each Node builtin with its importers and the compressed size against the 10 MiB Worker limit, once for the complete tree and once for the CF target composition (the tree minus the rows the CF packages replace). `pnpm --filter @deepseek-ai/dsh-cf-web run test:workerd` is the runtime half: it evaluates every CF-target package module in isolation inside workerd (`nodejs_compat`) and fails on any module whose top-level evaluation throws.

Results: the complete tree bundles with zero unresolved imports (0.98 MiB gzip); the CF target composition is 0.37 MiB gzip and every one of its 107 package modules evaluates under local workerd and under production workerd (a throwaway Worker importing the same per-package bundles reports 107 passed, 0 failed). Production differs from local workerd in two ways the local gate cannot see: `new Function` throws `EvalError: Code generation from strings disallowed`, and `import.meta.url` is undefined, so `createRequire(import.meta.url)` and `new URL(relative, import.meta.url)` throw at module load. The tree now avoids both on the load path (self-package JSON imports instead of `createRequire`, a lazily built `!!js` evaluator in the vendored loader); the one disk-asset provider that still resolves `import.meta.url` at load (`dsh-skill-badge`) is excluded from the CF composition until an asset-backed provider replaces it. Every remaining Node coupling in the target composition is call-time (a provider touching disk, a process, or a listening socket at mount), which is what the `packages/cf/*` Service Providers replace behind the existing Service Definitions.

## Signing in, and which object a request reaches

Every request is verified before any object is addressed. The Worker checks the identity service's JWT against a key set cached for the isolate, then addresses the Host object named `dsh:1:<orgId>:<userId>` for the principal that token names. A request carrying no token this deployment accepts is refused at the edge and reaches no harness surface, which is what makes tenant isolation structural: the object cannot serve the wrong principal because it was never addressed for them.

The identity service is [`apps/cf-auth`](../cf-auth/README.md), named by three vars in `wrangler.jsonc`: `AUTH_ISSUER` and `AUTH_JWKS_URL`, which the edge verifies against, and `AUTH_BASE_URL`, which the sign-in page talks to. That service's own `AUTH_TRUSTED_ORIGINS` must name this deployment's origin, or the browser discards its responses before the page sees them.

Signing in is a browser flow, so this deployment never sees a password. An unauthenticated navigation is answered `401` with the sign-in page as its body; the page asks the identity service for a token, posts it to `/__dsh/session`, and the Worker verifies it and returns it as the `dsh-principal` cookie, which expires with the token. `/__dsh/signout` clears that cookie and ends the identity session behind it. `Authorization: Bearer` is accepted too, for callers that are not browsers.

`connection` is composed with `browserAuth: 'edge'` (`scripts/compose.mjs`): this Host authenticates nothing of its own, because a Durable Object is reachable only through the Worker that already refused everyone else. Its `/api` Host and Origin fence still runs, and is what answers CSRF for a token carried in a cookie. The launch token this deployment used to hold is gone.

## Running it locally

```sh
pnpm --filter @deepseek-ai/dsh-cf-auth run dev    # the identity service on :8788
pnpm --filter @deepseek-ai/dsh-cf-auth run seed   # alice@dev.invalid and bob@dev.invalid
pnpm --filter @deepseek-ai/dsh-cf-web  run build
pnpm --filter @deepseek-ai/dsh-cf-web  run dev    # the GUI on :8790
```

`scripts/dev.mjs` points the Worker at the local identity service, because `wrangler.jsonc` names the deployed one, whose tokens carry a different issuer and are signed with a key set a local sign-in never sees. Copy `.dev.vars.example` to `.dev.vars` to give the local run a model key; without one the GUI runs and every model turn fails on a missing credential.

## Layout

- `scripts/workspace-resolver.mjs` resolves `@deepseek-ai/*` imports to each package's built `lib/` through its `exports` map with the `workerd` condition, so the Worker consumes the published artifact plane, never workspace source.
- `scripts/composition.mjs` reads the package rows of the two web bundle layers and declares the disposition of every row the CF composition does not mount: replaced by a Cloudflare provider, not applicable to this deployment, or a capability gap.
- `scripts/parity.mjs` projects those dispositions and the composer's ledger into [composition-parity.md](composition-parity.md) and fails on a stale one; the `build` script runs it ahead of the bundle, and `parity:check` fails when the checked-in report is out of date.
- `scripts/fidelity.mjs` is the second half of that report: it scans each substitute provider's source for a method body that is one unconditional `throw`, an empty body, or a single `return` of an absent value, and `parity.mjs` fails unless the disposition declares each one. Mounting a provider is not the same claim as implementing it.
- `scripts/gate0.mjs`, `scripts/build-probe.mjs`, and `tests/workerd/gate0-eval.workerd.ts` are the two halves of gate 0.
- `scripts/build.mjs` bundles `src/worker.ts` into `dist/worker.js`; `wrangler.jsonc` deploys that prebuilt file.
- `tests/workerd/*.workerd.ts` run inside workerd through `@cloudflare/vitest-pool-workers` (`vitest.workerd.config.ts`); the repository's Node vitest globs do not match the suffix. Two projects: `deployment` carries the real `wrangler.jsonc`, and `edge` carries `wrangler.edge-test.jsonc`, whose Worker is the shipped edge module over a Host object that records what it was addressed as. The assembled Worker is 15 MiB of bundled plugin tree and the pool's runtime exits on loading it, so the object's body is the one substitution.
- `tests/browser/*.e2e.ts` (`vitest.browser.config.ts`, `run test:browser`) drive a running `wrangler dev` and identity service with two isolated browser contexts; without both servers the cases skip and say so.

## Known Limitations and Deferred Work

[composition-parity.md](composition-parity.md) is the current list, generated from what the build actually composes: which web rows this deployment does not mount, which Cloudflare provider stands in for each, and which capabilities are therefore missing. Open gaps today are skills (no provider registers into the `skills` registry, so every preset's `tool-skill` serves an empty catalog) and the `minimal` preset. Separately, the report's fidelity section records that 15 of the 16 substitute providers have no test suite: `pnpm run test:coverage` rejects every one of their source files, so a replacement means mounted and bundled, not exercised. The workflow engine, the Code Mode worker-thread runtime, and `dsh-cordis-host-runner` need `node:worker_threads` or `node:vm` and stay out of the CF composition by decision, not by oversight.
