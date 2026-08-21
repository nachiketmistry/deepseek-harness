# @deepseek-ai/dsh-cf-web

English | [中文](README.zh.md)

The dsh web GUI assembled for Cloudflare: a Worker serves the browser shell, one Host Durable Object hosts the harness plugin tree, and one Sandbox SDK container per user holds the git projects that sessions work in. This app owns the wrangler configuration, the Worker entry, and the workerd bundle of the host tree; the Cloudflare Service Providers live under `packages/cf/*`.

## Gate 0: the web host tree on workerd

`pnpm --filter @deepseek-ai/dsh-cf-web run gate0` bundles every package row of the web composition (`packages/bundle/base` plus `packages/bundle/web-app`) for workerd through the workspace resolver and writes [gate0-imports.md](gate0-imports.md): each Node builtin with its importers and the compressed size against the 10 MiB Worker limit, once for the complete tree and once for the CF target composition (the tree minus the rows the CF packages replace). `pnpm --filter @deepseek-ai/dsh-cf-web run test:workerd` is the runtime half: it evaluates every CF-target package module in isolation inside workerd (`nodejs_compat`) and fails on any module whose top-level evaluation throws.

Results: the complete tree bundles with zero unresolved imports (0.98 MiB gzip); the CF target composition is 0.40 MiB gzip and every one of its 108 package modules evaluates under workerd. Every Node coupling in the target composition is call-time (a provider touching disk, a process, or a listening socket at mount), which is what the `packages/cf/*` Service Providers replace behind the existing Service Definitions.

## Layout

- `scripts/workspace-resolver.mjs` resolves `@deepseek-ai/*` imports to each package's built `lib/` through its `exports` map with the `workerd` condition, so the Worker consumes the published artifact plane, never workspace source.
- `scripts/composition.mjs` reads the package rows of the two web bundle layers and names the rows the CF composition does not mount, with the replacing package or the reason.
- `scripts/gate0.mjs`, `scripts/build-probe.mjs`, and `tests/workerd/gate0-eval.workerd.ts` are the two halves of gate 0.
- `scripts/build.mjs` bundles `src/worker.ts` into `dist/worker.js`; `wrangler.jsonc` deploys that prebuilt file.
- `tests/workerd/*.workerd.ts` run inside workerd through `@cloudflare/vitest-pool-workers` (`vitest.workerd.config.ts`); the repository's Node vitest globs do not match the suffix.

## Known Limitations and Deferred Work

- `src/worker.ts` is a placeholder until the Host Durable Object, the Sandbox binding, and the CF Service Providers land.
- The workflow engine (`dsh-workflow-worker-thread`, `dsh-tool-workflow`, `dsh-tool-ralph`), the Code Mode worker-thread runtime, and `dsh-cordis-host-runner` need `node:worker_threads` or `node:vm` and stay out of the CF composition.
