---
description: "Node Service Provider for the client-bundle source: resolves each Loader row's package through the Loader and node_modules, and serves its built browser bundle and source map from disk."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-bundle-source-node

English | [中文](README.zh.md)

## Summary

The Node Service Provider for the client-bundle source (default-exported `NodeClientBundleSource`, providing `ctx.clientBundleSource` as [`dsh-client-modules`](../modules/README.md) defines it). `resolve(loaderName, baseUrl)` locates the package a Loader row mounts through the same resolution that imported the row's host half — Loader internals where the runtime has them, a tree-anchored `require` otherwise — walks to the nearest ancestor manifest that declares the module, and reads its `dsh.client` declaration and `exports["./client"]`. `snapshot` stats the bundle before reading its bytes, so a write landing between the two leaves the baseline older than the bytes and the watcher rebuilds; `readSourceMap` validates the `.map` sibling as Source Map v3; `watchPath` hands back the absolute path the HMR node half stat-polls.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

---

<a id="use-this-package"></a>

## Use this package

Mount it ahead of `@deepseek-ai/dsh-client-modules`, which injects `clientBundleSource` and reads declarations and bytes only through it:

```yaml
- id: client-bundle-source
  name: '@deepseek-ai/dsh-client-bundle-source-node'
- id: modules
  name: '@deepseek-ai/dsh-client-modules'
```

A host with no filesystem composes a different provider over the same Service Definition; the registry does not change.

<a id="understand-the-implementation"></a>

## Understand the implementation

A row that resolves to no package root — a Loader builtin (`cordis:include`), a subpath entry — and a package whose declaration is not `platform: web` both answer `undefined`. The registry caches that verdict per row for the process, so plugin-set changes take effect on restart.

A web package that exports no `./client` bundle, or declares malformed `dsh.client` fields, throws from `resolve`. An absent bundle throws `MissingClientBundleError` from `snapshot`, which the registry groups into one build instruction; any other filesystem failure propagates unchanged.

<a id="model-experience"></a>

## Model Experience

None, as the package only locates and reads browser bundles for the client module system; nothing here reaches a model request.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

<a id="known-limitations-and-deferred-work"></a>

## Known Limitations and Deferred Work

- **Verdicts are permanent for the process** — the registry never re-asks whether a row became a client package, so installing one into a running host needs a restart.

### Dev Note

The resolution logic here was the client-module registry's own until the bundle source became a Service Definition. It stays behaviourally identical so a Node deployment sees no change; the seam exists so a platform host can answer from a build-time manifest instead.
