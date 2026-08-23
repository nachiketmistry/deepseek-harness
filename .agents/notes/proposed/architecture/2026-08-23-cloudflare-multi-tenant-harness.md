# Agent Note: multi-tenant harness on Cloudflare

Status: proposed

English | [中文](2026-08-23-cloudflare-multi-tenant-harness.zh.md)

## Problem

[The Cloudflare web host](2026-08-21-cloudflare-web-host.md) put the product on Workers with authentication and multi-tenancy declared out of scope, and the deployment reflects that literally: one Host Durable Object named `default`, one Sandbox container named `default`, provider credentials as deployment-level Worker secrets, and no principal anywhere in the harness. `SessionHeader` records `id`, `createdAt`, `cwd`, and lineage, and no owner. The only value called a user id is `dsh-anonymous-user-id`, a telemetry UUID scoped to `$DSH_HOME` and deliberately derived from nothing identifying.

There is also no authentication. `dsh-client-connection` documents `trustedHosts` as a DNS-rebinding fence, "explicitly not authentication", and keeps the privileged configuration plane pinned to loopback until a real authentication layer exists. The CF composition overrides `privilegedHosts` with the public host, so settings mutation, credential reconnaissance, preset management, and `llm.discoverModels` — which makes the Worker issue a GET to a caller-chosen URL and reports the result — are reachable by anyone who knows the hostname.

Two further facts decide the shape rather than merely constrain it. Container disk on Cloudflare is ephemeral: an instance that sleeps restarts from its image with a fresh disk, and the platform stops instances on host restarts at an irregular cadence. The current single sandbox therefore already loses its git checkouts on every idle period, which means the deployment is following an ephemeral workspace pattern without having chosen one. And the product intends to sell model capacity rather than accept customer provider keys, which removes a per-tenant credential store from the design and replaces it with a metering and quota obligation.

## Proposal

### Identity and tenancy

Identity is delegated to a self-hosted Better Auth service and never modelled in the harness. Managed Better Auth on Neon exposes a subset of plugins that excludes Teams and enterprise SSO, both of which this product needs, so the service runs as our own deployment against Neon Postgres with the organization, teams, and SSO plugins enabled.

The tenancy hierarchy is organization, team, user, session. **The organization is the isolation boundary, the user is the coordination atom, and a team is a grant** — a way to give several people access to the same projects and presets, never a separate data world. Team membership therefore affects authorization only; it never appears in a storage key, because a user who changes team must not lose their sessions.

Better Auth records an active organization on the session, and a user may belong to several. The verified principal is consequently a pair, `(orgId, userId)`, carried with the user's role and team grants. Keying anything by user alone merges a person's two organizations into one world and is the most likely tenancy defect in this design.

### The principal seam

Authentication becomes a capability seam in core, not a Cloudflare concern. The Service Definition exposes the verified principal for the current request. A Node Service Provider answers with one fixed local principal, so the CLI and headless profiles keep working with no network identity at all; single-user stops being a separate code path and becomes a deployment with one principal. A Cloudflare Service Provider verifies a Better Auth JWT.

Verification happens in the Worker's `fetch` handler, against JWKS cached per isolate with a refresh floor of five to ten minutes. The Durable Object never authenticates: it receives an already-verified principal and derives its own identity from it, which is what makes the isolation structural rather than advisory. This also keeps the auth service off the request path — a sleeping auth container costs a slow sign-in, never a slow product.

`dsh-client-connection` gates the privileged configuration plane by host today. That gate is replaced by principal and role, and the CF composition stops overriding `privilegedHosts`.

### Topology

One Durable Object class hosts the harness tree, addressed by `org:user`. This follows Cloudflare's own rule to model a Durable Object around the atom of coordination and names the global singleton as the anti-pattern. An organization-wide Durable Object is rejected: it puts every member's sessions behind one single-threaded lock.

There is no second Durable Object class. Organization-shared harness state — the team-scoped preset library, the project roster — lives in Postgres beside the organization data that governs it, because it is read-mostly and needs no single writer.

One sandbox per `org:user:session`, destroyed when the task completes. The identifier carries the trust boundary, which the Sandbox SDK states as one sandbox per user or per trust boundary, since sessions inside a sandbox share a filesystem and process space and are not a security boundary. The lifecycle is ephemeral because the platform allows nothing else. Explicit `destroy()` is preferred over the idle timeout: it releases the `max_instances` slot and stops paying for idle capacity.

Because the container can stop mid-task, the harness must reconstitute a workspace from git at any point in a run, and that path is tested rather than assumed. Uncommitted work is the exposed edge: git is the durability story only if the agent commits often enough to make it true.

### Data authority

Postgres is authoritative for who exists, who belongs where, and what they are owed. It holds the Better Auth tables, GitHub installation records, the usage ledger, and organization-shared harness configuration.

The Durable Object is authoritative for what a user did: their session log, storage, settings, and attachments metadata. It stores opaque `orgId` and `userId` references and never denormalizes names, emails, or roles, which change in Postgres and would go stale. Deleting a user or organization in Postgres therefore needs a harness-side deletion path, because nothing informs the Durable Object on its own.

R2 holds attachments and spill. The container filesystem holds nothing durable.

### Credentials

The product does not accept customer model keys, so there is no per-tenant provider credential store.

GitHub access uses a GitHub App. Installation access tokens act as the app and last one hour; user access tokens act as a person, last eight hours with a six-month refresh token, and carry **the intersection of the app's permissions and that user's own access**. That intersection is the enforcement of "the agent reaches only what the human reaches", and GitHub enforces it rather than the harness. Anything a human triggered uses their user token, so revocation is immediate and the repository audit trail names the person; installation tokens are reserved for genuinely humanless work.

What is stored is therefore small: the app private key, installation ids, and user refresh tokens. Access tokens are minted per operation and never persisted. Refresh tokens are encrypted at rest with envelope encryption, the data key wrapped by a root key held in Secrets Store, so root-key rotation costs a rewrap rather than a re-encryption.

This changes the sandbox contract. `cf-sandbox` materializes `GH_TOKEN` into the container at preparation, where it outlives the request and is readable by every process in that container. A token minted per git operation replaces it, ideally through a git credential helper that calls back rather than a persistent environment variable.

Root secrets — the GitHub App private key, the envelope root key, the Cloudflare email API token, Better Auth signing material — live in Secrets Store, which is an account-level store of 100 secrets and explicitly not a per-tenant vault.

### Model access and billing

All model traffic routes through AI Gateway on Unified Billing. Cloudflare passes provider inference pricing through with no markup and charges a flat five percent on credit purchases, so the cost basis is provider list price plus five percent and transparent pricing is a defensible claim rather than a slogan.

The default models are DeepSeek V4 Pro and V4 Flash hosted on Workers AI, which are credit-billable, support function calling and thinking mode, and carry a 1,048,576-token context window. They are reached over the OpenAI-compatible HTTP endpoint rather than the `env.AI.run()` binding: the LLM adapter already resolves `baseURL` and a credential reference per request, so HTTP keeps one provider for every deployment and makes the Cloudflare difference a configuration value. Model selection is settled by running the snapshot and e2e suites against candidates, not from capability tables.

Every request carries `org_id` and `user_id` as AI Gateway custom metadata, within the five-entry limit. Spend limits scoped to those dimensions with **Split by value** give each organization an independent budget without a bespoke quota service, and exhaustion routes to a cheaper model through a Dynamic Route instead of returning 429, so a long task degrades rather than dies.

AI Gateway is the enforcement point and not the system of record. Its cost tracking is best-effort estimation and its spend limits are eventually consistent, which parallel subagents will overshoot. The billing ledger is ours, in Postgres, keyed by organization, user, and session, projected from `TokenUsage` on session events — which already distinguishes input, output, cache-read, and cache-write tokens — and reconciled against Cloudflare monthly. Cached input is priced at roughly three percent of fresh input, so a plan's included credits must be sized against cache-warm sessions.

Plan-tiered model access is enforced in the harness by not offering the model, and again at the gateway. Gateway-only enforcement leaks the plan structure through error codes.

### The authentication service

Better Auth runs in a Cloudflare Container behind its own Worker, separate from `dsh-cf-web`, so an auth deploy and a harness deploy are independent and the harness bundle carries only `jose`. A container is required rather than preferred: the SSO plugin's SAML half depends on samlify, which is unlikely to run on workerd, and a container also gives plain Postgres over TCP with no Hyperdrive on the path.

The service is stateless. All state including JWKS private keys is in Postgres, instances are routed with `getRandom` across a fixed pool, and the image handles `SIGTERM`, because the platform stops instances on host restarts with a fifteen-minute drain. Region placement is pinned near the Neon project, since every auth request is a database round trip.

Transactional email — verification, magic links, and organization invitations — uses the Cloudflare Email Sending REST API, because bindings are Worker-side and unavailable in a container. The REST field names differ from the binding (`from.address`, `reply_to`), only 429 and 500 are retried, and the sending domain must be onboarded with SPF, DKIM, and DMARC before the first send.

### Inventory of harness changes

`SessionHeader` gains an owner. The principal seam is added to core with its two providers. `dsh-client-connection` gates by principal and role rather than host. Persistence, storage, settings, attachments, spill, and workspace key by principal. `cf-sandbox` moves to per-session identifiers with explicit destruction and per-operation credentials. The DeepSeek adapter's resolve step gains AI Gateway metadata headers, and its user-id header becomes the real principal instead of the telemetry UUID. Each of these lands as a disposition in [composition-parity.md](../../../../apps/cf-web/composition-parity.md), so a capability that changes hands stays visible.

## Alternatives considered

- **Managed Better Auth on Neon** — rejected: the managed plugin subset does not enable Teams and does not list enterprise SSO, and both are required. Migrating later re-mints JWKS keys and invalidates every live session, and the managed service's value is lowest exactly where the missing plugins are needed.
- **Model tenancy inside the harness** — rejected: modelling organizations, teams, or roles in `packages/` duplicates what the auth layer owns and guarantees divergence. The harness consumes a verified principal and stores opaque identifiers.
- **Session data in Postgres under row-level security** — rejected: the session log is an append-heavy single-writer event stream with hibernatable WebSockets, which is what a Durable Object is for and what `session-persistence-do` implements. Row-level security adds nothing once the Worker establishes the principal before selecting the Durable Object. A Neon-backed projection behind the existing `session-query` seam remains available for cross-session reporting.
- **Bring-your-own model keys** — rejected as a product decision: it moves cost and quota to the customer at the price of a per-tenant credential vault, and the transparent-pricing model needs neither.
- **Long-lived per-user sandboxes** — rejected because the platform does not offer them. All container disk is ephemeral and a slept instance restarts from its image, so a per-user sandbox is a stable name in front of a workspace that must be rebuilt anyway. Naming by session makes the real lifecycle explicit.
- **A second Durable Object class per organization** — rejected: organization-shared harness state is read-mostly and needs no single writer, and membership is Postgres's to own. One class avoids a second authority for the same facts.

## Acceptance criteria

A request without a valid token reaches no harness surface, and the privileged configuration plane is unreachable without a role that permits it. Two organizations containing the same user resolve to different Durable Objects and different sandboxes, and neither can read the other's sessions. A user removed from an organization loses access within one token lifetime. The CLI and headless profiles run unchanged with no authentication service present. A sandbox killed mid-task is reconstituted from git on the next turn. Every model request appears in the Postgres ledger attributed to an organization, a user, and a session, and the monthly total reconciles with Cloudflare's charge. `pnpm --filter @deepseek-ai/dsh-cf-web run parity:check` passes with every seam that changed hands carrying a disposition.

## Risks

Frontier-model rate limits on credits are per account and per model, shared across every tenant and amplified by parallel subagent fan-out; this is the first scaling wall and it is not per-customer. Selling capacity makes trial abuse a direct financial attack, and spend limits are eventually consistent, so trial budgets need headroom for burst overshoot and subagent fan-out may need capping for trial organizations. A credit balance can go negative, with Cloudflare charging the card on file, so a gateway-wide cap is a liability control rather than a nicety.

Booting a plugin tree per Durable Object wake means boot cost scales with active users, which is untested beyond one. Whether DeepSeek V4 on Workers AI matches the harness's tool-calling behavior is an empirical question the snapshot suites must answer before it becomes the default. AI Gateway logs prompts and responses, which for a coding agent is customer source code held by Cloudflare; retention is configurable and the choice belongs in the first security review, not after it.
