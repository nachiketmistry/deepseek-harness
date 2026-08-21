# @deepseek-ai/dsh-client-bundle-source-node

English | [中文](README.zh.md)

The Node Service Provider for the client-bundle source (default-exported `NodeClientBundleSource`, providing `ctx.clientBundleSource` as [`dsh-client-modules`](../modules/README.md) defines it). It resolves a package name to its `package.json` through `node_modules` from the config-tree anchor `ctx.baseUrl` (the `cordis.yml` directory, whose package declares every composed plugin as a dependency; the provider's own URL would miss sibling packages under pnpm's isolated `node_modules`), reads the `dsh.client` declaration and `exports["./client"]`, and serves the built bundle and its `.map` sibling from disk. Verdicts are permanent for the process: a name that is not a resolvable package root (a Loader builtin, a subpath row) or whose declaration is not `platform: web` describes as `undefined` and stays that way, so plugin-set changes take effect on restart. A web package that exports no `./client` bundle, or declares malformed fields, throws from `describe`; an absent bundle file throws `MissingClientBundleError` from `read` (the registry groups those into one build instruction), while any other filesystem failure propagates unchanged. `locate` returns the bundle's absolute path so the HMR node half can stat-poll it. Construction throws when `ctx.baseUrl` is unset.

## Model Experience

None, as the package only locates and reads browser bundles for the client module system; nothing here reaches a model request.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

- **One anchor per process** — every package resolves from `ctx.baseUrl`; a composition whose rows live under several unrelated `node_modules` trees needs a provider that anchors per row.
