# Agent Note: the web GUI host tree on Cloudflare

Status: proposed

English | [中文](2026-08-21-cloudflare-web-host.zh.md)

## Problem

The web GUI runs only as a Node process: `apps/cli` composes the tree from disk profiles, `dsh-host-webserver` listens on `node:http`, `dsh-client-connection` upgrades WebSockets through `ws`, `dsh-client-modules` scans `node_modules` for client bundles, and every durable or execution provider (JSONL persistence, JSON storage, settings and credential files, attachments, spill, local filesystem, local subprocesses, OS sandboxes, the OS directory chooser) touches the host machine. The cordis-cf-poc phases 1 to 4b proved that the agent spine, DO-SQLite persistence reusing the harness codec, and facet-hosted tools run on workerd with zero harness edits; the host and web layer is what remains to host the complete product on Cloudflare: a Worker serving the browser shell, one Host Durable Object per deployment holding the tree, and one Sandbox SDK container per user holding git projects.

## Proposal

Assemble the web GUI on Cloudflare in five pull requests, each a draft at its boundary:

1. **Gate 0** (`apps/cf-web`): bundle the web composition for workerd and evaluate every CF-target package module inside workerd. Shipped: the complete tree bundles with zero unresolved imports at 0.98 MiB gzip; the CF target composition (108 package rows) is 0.40 MiB gzip and every module evaluates. No structural blocker: every Node coupling is call-time.
2. **Seam extraction** in existing packages: a Service Definition for the web server as a fetch handler over the existing `ctx.webServer` route registry (the Node listener becomes one Service Provider); a Service Definition for the WebSocket downlink (the `ws` upgrade path becomes one Service Provider); a client-bundle-source Service Definition replacing `node_modules` scanning in `dsh-client-modules` with a build-time manifest; a file-free composition path and an agent-preset source that does not read the disk profile. The vendored Loader already runs over a module table in the browser; the CF host runs it over a build-time module table with literal (no `!!js`) rows.
3. **cwd through `ctx.fs`**: workspace realpath and mkdir and `session.create` cwd resolution go through the filesystem Service Definition; `process.cwd()` defaults leave `sandbox-policy`, `fs-sandbox`, `apiproxy`, `agent-instructions`, and `file-reference-local`.
4. **`packages/cf/*`** Service Providers behind the existing Service Definitions: `webserver-cf` (hibernatable WebSockets), `assets-cf`, `persistence-do` (the PoC port), `storage-do`, `settings-do`, `credentials-secrets`, `attachment-r2`, `spill-r2`, `fs-cf-sandbox`, `subprocess-cf-sandbox`, `sandbox-passthrough`, `directory-picker-cf` (browse `/workspace` plus clone-a-git-URL), and a skill provider over `ctx.fs`.
5. **`apps/cf-web`**: the Worker, the Host Durable Object, the Sandbox binding, and the wrangler configuration, deployed to workers.dev.

Fixed decisions: single user with no authentication beyond the trusted-hosts fence; one sandbox per user with projects as directories under `/workspace/<name>`; workspace creation clones a git URL, private repositories through a GitHub token from Worker secrets materialized as `GH_TOKEN` plus git configuration in the sandbox; git is the durability story for project files; the Sandbox SDK `@next` line (argv `exec`, process handles, no process stdin, `setEnvVars`), not E2B; UI bundles stay untouched. Out of scope: authentication and multi-tenancy, the worker-thread workflow engine and Code Mode runtime, `dsh-cordis-host-runner`, R2 backups.

## Alternatives considered

- **Fork the host packages into CF variants** — rejected: the seam design exists so one provider swap moves the whole product; a fork of `apiproxy`, `connection`, or `modules` would diverge on every later change. Gate 0 shows the Node coupling sits in providers and in three narrow host seams, which is exactly the extraction in step 2.
- **Run the Node web app under a Node-in-container** — rejected: it gives up Durable Object persistence, hibernatable sockets, and the per-wake reconcile the PoC proved, and keeps a long-lived process the platform would idle out.
- **Sandbox SDK stable line (`exec(string)`, sessions, stdin)** — rejected: the preview removes sessions and process stdin, which the subprocess Service Provider must design around (argv only, `{ data }` stdin through a sandbox file); targeting stable would re-port at 1.0.

## Acceptance criteria

On the deployed workers.dev URL: the GUI boots; "clone git URL" creates a project; a session on it runs a turn where the model edits a file and runs `git commit` and `git push` through the ordinary bash tool, with the commit visible on the remote; the session log survives a real Durable Object eviction; the keyless `text-turn` snapshot replays through the Host Durable Object identically.

## Risks

- `!!js` rows in the shipped presets and bundle layers cannot evaluate on workerd; the CF composition supplies literal rows, so preset and bundle rows gain a second source that must stay consistent.
- Process stdin is absent on the Sandbox SDK preview; consumers that need `stdin: 'pipe'` (LSP, external subagent providers) are outside the CF composition.
- The Sandbox SDK preview replaces containers behind a stable sandbox id; process handles do not survive that, so a bash turn spanning a container replacement fails and restarts rather than resumes.
