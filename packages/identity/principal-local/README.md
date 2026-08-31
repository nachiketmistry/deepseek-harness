---
description: "The single-principal provider for maintainers running the harness without an identity service: one configured organization and user for every request."
kind: "package-reference"
---

# @deepseek-ai/dsh-principal-local

English | [中文](README.zh.md)

## Summary

This package is what a deployment with no identity service looks like from inside the harness. It provides `ctx.principal` and answers every request with the same configured organization and user, so the CLI and headless profiles have a real principal and nothing downstream has to branch on whether identity exists. The keys derived from that principal are the same shape a multi-principal deployment writes, which is what keeps single-user from being a separate code path.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Compose it wherever the deployment has exactly one caller:

```yaml
- principal-local:
    org: org_local
    user: usr_local
```

Both fields are required. They are not defaulted because they land in permanent object and storage keys, and a deployment that has not chosen them must fail at load rather than silently adopt a shared name that another deployment also picked.

<a id="understand-the-implementation"></a>
## Understand the implementation

`LocalPrincipalResolver` extends [`PrincipalResolver`](../principal/README.md) and builds one frozen `Principal` in its constructor, which `current()` returns for every request. There is no per-request work, no cache, and no lifecycle beyond the plugin's own: the configured value is the whole state.

The subject is always the `user` variant. A deployment without an identity service has a person at the keyboard, not a machine caller, so no other variant is reachable here.

<a id="further-exploration"></a>
## Further Exploration

- [`dsh-principal`](../principal/README.md) — the Service Definition, the principal value, and `hostObjectName`.
- [The principal seam Agent Note](../../../.agents/notes/proposed/architecture/2026-08-29-principal-seam-and-per-principal-addressing.md) — why a single-principal deployment is modelled as a provider rather than as an absent principal.

<a id="model-experience"></a>
## Model Experience

None, as this provider answers an identity question that request assembly never reads.

#### KV Cache effect

No direct effect; nothing here reaches a model request, so no cached prefix is extended or invalidated by this package.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **The principal is fixed at load** — changing it means reloading the plugin. There is no way to switch principal within a running tree, which is deliberate: the storage keys derived from it are already in use by then.
- **No identity-service validation** — the configured identifiers are accepted as given. Nothing checks that they correspond to a real organization or user, so a typo produces a working deployment addressing an object nobody else will ever address.

<a id="dev-note"></a>
### Dev Note

None.
