# Agent Note: the plugin package inventory has no filesystem to read on Cloudflare

Status: implemented

English | [中文](2026-08-31-plugin-package-inventory-has-no-filesystem-on-cloudflare.zh.md)

## Problem

Every model turn in the Cloudflare web GUI failed with `REQUEST_EXTENSION`, `DeepSeek request extension preparation failed`, before any request reached the provider.

`plugin-package-inventory-deepseek` contributes `dsh_plugin_packages` to official DeepSeek requests, and it resolves each active Loader entry to the package that owns it by reading that package's `package.json`. It finds the file through `createRequire(anchor).resolve.paths(name)` and `existsSync`, both of which need the packages to be laid out on disk. A Worker has no filesystem: the deployment is one bundle, `node:fs` is a stub, and the harness packages exist only as bundled modules. The resolver finds no manifest for the first active entry and throws, rather than reporting an inventory it knows to be incomplete.

The throw is per request, so the failure was not a load-time one the composition could notice. The row bundled, the tree activated, and the deployment was healthy in every respect except the one that is the product: a person could sign in, create a workspace, and start a chat, and the turn failed on the first request.

## Decision

`CF_ROW_DISPOSITIONS` records the row as a `plugin-package-inventory` gap. The Cloudflare build does not mount it, and official requests from this deployment carry no `dsh_plugin_packages` field.

A gap rather than a substitution because this is the whole capability, not a backend of it. The extension reports which packages assembled a request, and nothing else in the composition needs it, so removing the row removes exactly one field from one wire request and orphans nothing.

The disposition is where this belongs rather than an `enabled: false` config override in `compose.mjs`. `composition.mjs` is the single place that decides what the build does with a row, and `parity.mjs` fails when the report and the build disagree; a config override would have dropped the field from the product while the report still claimed the capability.

## Alternatives considered

**A static inventory generated at build time.** Deferred, and the right way to close the gap: the CF build already resolves all 130 host rows and both preset trees, so the package identities the extension reports are known before the Worker runs, and the repository already answers this class of problem this way in `dsh-typert-artifacts-static`, `dsh-agent-presets-static`, and `dsh-client-bundle-source-static`. It is a package with generated data, not a two-line disposition, and it does not have to land with the fix for the failure.

**Catch the resolution failure inside the plugin and report the packages it could resolve.** Rejected: a silent partial inventory is a wrong answer sent to the API rather than an absent one, and the caller cannot tell the two apart. Reporting nothing is honest; reporting some is not.

**Make `barePackageManifest` fall back to the entry name with no version.** Rejected for the same reason, and worse: a fabricated identity is indistinguishable on the wire from a real one.

**Leave it mounted and accept the failed turns.** Rejected: the turn is the product.

## Consequences

The Cloudflare deployment sends official DeepSeek requests without `dsh_plugin_packages`. Anything downstream that reads that field sees this deployment as it would one running an older harness, not as one whose inventory is empty.

Open gaps in `composition-parity.md` go from two to three. The other two cost a capability a person can see missing; this one costs a field only the API reads, which is why it went unnoticed until a turn was run against the real provider.

Nothing gates a plugin against being mounted where its runtime cannot answer. `gate0` proves every module in the CF composition evaluates in workerd, and this one does — it throws later, on a request, and only when a model turn happens. Rows whose failure is deferred to a request path are not covered by any gate today.
