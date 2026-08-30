# @deepseek-ai/dsh-cf-web

English | [中文](README.zh.md)

The dsh web GUI assembled for Cloudflare: a Worker serves the browser shell, one Host Durable Object hosts the harness plugin tree, and one Sandbox SDK container per user holds the git projects that sessions work in. This app owns the wrangler configuration, the Worker entry, and the workerd bundle of the host tree; the Cloudflare Service Providers live under `packages/cf/*`.

## Gate 0: the web host tree on workerd

`pnpm --filter @deepseek-ai/dsh-cf-web run gate0` bundles every package row of the web composition (`packages/bundle/base` plus `packages/bundle/web-app`) for workerd through the workspace resolver and writes [gate0-imports.md](gate0-imports.md): each Node builtin with its importers and the compressed size against the 10 MiB Worker limit, once for the complete tree and once for the CF target composition (the tree minus the rows the CF packages replace). `pnpm --filter @deepseek-ai/dsh-cf-web run test:workerd` is the runtime half: it evaluates every CF-target package module in isolation inside workerd (`nodejs_compat`) and fails on any module whose top-level evaluation throws.

Results: the complete tree bundles with zero unresolved imports (0.98 MiB gzip); the CF target composition is 0.37 MiB gzip and every one of its 107 package modules evaluates under local workerd and under production workerd (a throwaway Worker importing the same per-package bundles reports 107 passed, 0 failed). Production differs from local workerd in two ways the local gate cannot see: `new Function` throws `EvalError: Code generation from strings disallowed`, and `import.meta.url` is undefined, so `createRequire(import.meta.url)` and `new URL(relative, import.meta.url)` throw at module load. The tree now avoids both on the load path (self-package JSON imports instead of `createRequire`, a lazily built `!!js` evaluator in the vendored loader); the one disk-asset provider that still resolves `import.meta.url` at load (`dsh-skill-badge`) is excluded from the CF composition until an asset-backed provider replaces it. Every remaining Node coupling in the target composition is call-time (a provider touching disk, a process, or a listening socket at mount), which is what the `packages/cf/*` Service Providers replace behind the existing Service Definitions.

## Deploying and signing in

The deployment holds its own launch token, because a Worker has no terminal to print a generated one to and the platform restarts the Durable Object whenever it likes. Set it once before the first deploy, as a Worker secret of at least 32 characters:

```sh
wrangler secret put DSH_LAUNCH_TOKEN
```

`connection` is composed with `launchTokenRef: DSH_LAUNCH_TOKEN` (`scripts/compose.mjs`; `DSH_CF_LAUNCH_TOKEN_REF` renames it at build time) and resolves it through the Cloudflare credential store, which falls back to the Worker secret of that name. A deployment whose secret is unset fails its boot rather than serving a GUI nobody can enter. Sign in by opening `https://<public host>/?token=<the secret>` once: the index response exchanges the token for the browser-session cookie and redirects to a clean `/`. The cookie's signing secret is durable, so the session survives isolate restarts and redeploys.

## Layout

- `scripts/workspace-resolver.mjs` resolves `@deepseek-ai/*` imports to each package's built `lib/` through its `exports` map with the `workerd` condition, so the Worker consumes the published artifact plane, never workspace source.
- `scripts/composition.mjs` reads the package rows of the two web bundle layers and declares the disposition of every row the CF composition does not mount: replaced by a Cloudflare provider, not applicable to this deployment, or a capability gap.
- `scripts/parity.mjs` projects those dispositions and the composer's ledger into [composition-parity.md](composition-parity.md) and fails on a stale one; the `build` script runs it ahead of the bundle, and `parity:check` fails when the checked-in report is out of date.
- `scripts/fidelity.mjs` is the second half of that report: it scans each substitute provider's source for a method body that is one unconditional `throw`, an empty body, or a single `return` of an absent value, and `parity.mjs` fails unless the disposition declares each one. Mounting a provider is not the same claim as implementing it.
- `scripts/gate0.mjs`, `scripts/build-probe.mjs`, and `tests/workerd/gate0-eval.workerd.ts` are the two halves of gate 0.
- `scripts/build.mjs` bundles `src/worker.ts` into `dist/worker.js`; `wrangler.jsonc` deploys that prebuilt file.
- `tests/workerd/*.workerd.ts` run inside workerd through `@cloudflare/vitest-pool-workers` (`vitest.workerd.config.ts`); the repository's Node vitest globs do not match the suffix.

## Known Limitations and Deferred Work

[composition-parity.md](composition-parity.md) is the current list, generated from what the build actually composes: which web rows this deployment does not mount, which Cloudflare provider stands in for each, and which capabilities are therefore missing. Open gaps today are skills (no provider registers into the `skills` registry, so every preset's `tool-skill` serves an empty catalog) and the `minimal` preset. Separately, the report's fidelity section records that 15 of the 16 substitute providers have no test suite: `pnpm run test:coverage` rejects every one of their source files, so a replacement means mounted and bundled, not exercised. The workflow engine, the Code Mode worker-thread runtime, and `dsh-cordis-host-runner` need `node:worker_threads` or `node:vm` and stay out of the CF composition by decision, not by oversight.
