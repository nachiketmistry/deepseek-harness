---
description: "The identity package group: who a request acts as, and the anonymous per-harness-home correlation id shared by telemetry, feedback, and DeepSeek provider requests."
kind: "package-group"
---

# identity/ — shared identity

English | [中文](README.zh.md)

## Summary

The identity group answers two separate questions. The principal seam says who a request acts as, which is what every per-caller storage key is derived from; the anonymous id gives one harness home a correlation value that telemetry, feedback, and DeepSeek requests attach to their records without identifying the user. This page maps the group, and each package README owns the details.

## Table of Contents

- [Packages](#packages)
- [Related documentation](#related-documentation)
- [Dev Note](#dev-note)

<a id="packages"></a>
## Packages

| Package | Role |
|---|---|
| [`anonymous-user-id`](anonymous-user-id/README.md) | Gives every harness home one anonymous id that telemetry, feedback, and DeepSeek requests attach to their records, so records from one installation can be recognized without identifying the user |
| [`principal`](principal/README.md) | Says who a request acts as, and owns the Durable Object name derived from that principal |
| [`principal-local`](principal-local/README.md) | Answers with one configured principal, for a deployment with no identity service |

<a id="related-documentation"></a>
## Related documentation

- [Identity subsystem](../../docs/subsystems/identity.md) — the principal seam, its types, and the object-name scheme.
- [Session telemetry subsystem](../../docs/subsystems/session-telemetry.md) — the telemetry feature that carries the id on exports.
- [dsh-llm-deepseek](../llm/llm-deepseek/README.md) — the DeepSeek provider that carries the id on requests.
- [dsh-command-feedback](../feedback/command-feedback/README.md) — the feedback command that names the anonymous installation in its acknowledgement.

<a id="dev-note"></a>
## Dev Note

None.
