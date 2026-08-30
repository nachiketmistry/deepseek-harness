# @deepseek-ai/dsh-cf-auth

English | [中文](README.zh.md)

The dsh identity service: Better Auth on a Cloudflare Worker, backed by Neon Postgres through Hyperdrive. It answers who a caller is and issues the JWTs that [dsh-cf-web](../cf-web/README.md) verifies at its edge. It is a separate deployment on purpose, so an auth rollout and a harness rollout are never the same event, and so a cold auth deploy costs a slow sign-in rather than a slow session.

The design and the decisions that cannot be revisited are in the [principal seam Agent Note](../../.agents/notes/proposed/architecture/2026-08-29-principal-seam-and-per-principal-addressing.md).

## What it runs

Two Better Auth plugins and nothing else. `organization` is present because the harness addresses its Durable Objects by organization and user, so a user with no organization has no object to reach. `jwt` is present because the harness verifies against JWKS instead of calling this service on every request.

Sign-in is Google for people, and email plus password so tests can create accounts over the server API without a browser. Email verification is off and there is no password-reset flow, which is what keeps a mailer and its SPF, DKIM, and DMARC records out of this deployment; both sign-in methods work without one. Account linking is on with Google trusted for verified emails, so one human keeps one user id whichever button they pressed.

Every user gets a personal organization at signup, created by a `user.create.after` hook with an explicit `userId` because the user has no session to act through yet.

## The token the edge reads

The JWT carries exactly two claims the harness uses: `sub` is the user id and `org` is the organization id, both the identity service's opaque ids. The harness builds `dsh:1:<org>:<sub>` from them and addresses one Durable Object, so a token missing either claim is one the edge cannot act on.

`org` is resolved when the token is signed, not read from the session's `activeOrganizationId`. Signup creates the session about a second before the personal organization exists, so the session-creation hook finds no membership and leaves that column null; a token issued from it would name no organization. A selected active organization still wins once a user has one to select. A user who somehow belongs to no organization is refused a token here rather than handed one the edge would reject, so the fault is reported by the service that caused it.

## Schema

`migrations/0001-init.sql` is generated from this app's own `authOptions`, so the schema and the running service cannot drift, and it is committed and reviewed before it is applied rather than pushed in place by a CLI.

```sh
DATABASE_URL="<neon direct url>" pnpm run schema    # regenerate from authOptions
DATABASE_URL="<neon direct url>" pnpm run migrate   # apply the reviewed file
```

`DATABASE_URL` is Neon's **direct** connection string for both. Generation and migration run from Node and must not go through Hyperdrive, which exists to serve the Worker.

## Local development

`pnpm run dev` serves the Worker on workerd at `http://localhost:8788`, and `pnpm run seed` creates the fixed accounts `alice@dev.invalid` and `bob@dev.invalid`, printing each one's `org`, `sub`, and a live token. Seeding is idempotent: an account that already exists is signed in rather than recreated, so the principals stay stable across restarts and can be used as fixtures. Both scripts read `.dev.vars`, which is gitignored; copy `.dev.vars.example` and fill it in.

Point `DSH_CF_AUTH_DEV_DATABASE_URL` at a throwaway Neon branch, never at the deployment's database, for the reason the Bindings section gives: signing under a local secret leaves `jwks` rows the deployment cannot decrypt.

Two things `wrangler dev` cannot work out for itself, both handled by `pnpm run dev`. A Secrets Store binding resolves against a local store that starts empty and that `.dev.vars` does not populate, so each value is mirrored into it before the server starts. Hyperdrive has no local pool, so the database connection string is passed as `CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE`, which wrangler reads from its own environment rather than from a binding.

The Google client values only have to be present, because the Worker reads all three secrets before serving any route; the Google flow itself needs a registered redirect URI and is not exercised locally. Seeding sends an `Origin` header, which browsers always send and Node's `fetch` never does, so it is checked against `trustedOrigins` exactly as a real client is.

## Bindings

`HYPERDRIVE` points at Neon's direct endpoint, not its pooler: Hyperdrive maintains its own regional pool, and stacking it on Neon's PgBouncer pools a pool. The Postgres driver needs `nodejs_compat`, because Hyperdrive speaks TCP through `node:net`.

Signing material and the Google client live in the account Secrets Store rather than as per-Worker secrets, so an auth redeploy never re-mints them and a second service can read the same values. The JWKS private keys live in Postgres, which is what makes this service's runtime host a movable decision: if the SSO plugin's SAML half ever forces a move to a Container, nothing is re-minted and no live session is invalidated.

Those stored private keys are **encrypted with `BETTER_AUTH_SECRET`**, so the database and the secret are one unit. Moving hosts is free only when the secret moves too, rotating the secret abandons every existing key, and a database whose `jwks` rows were signed under a different secret fails every token request with `Failed to decrypt private key`. A database that has ever been pointed at a test secret must have its `jwks` rows cleared before the real deployment signs anything.

## Known Limitations and Deferred Work

- **No mailer** — email verification, password reset, and organization invitations all need one and are absent. The `invitation` table exists because the organization plugin creates it; nothing writes to it.
- **No roles enforced** — the organization plugin ships default roles and every personal-organization member is `owner`. Nothing reads the role yet.
- **Teams are deferred** — no teams tables are created. If they are ever enabled, nothing may key storage by team: a user who changes team must not lose their sessions.
- **One organization per user in practice** — a user belongs to exactly one personal organization, and there is no flow to create or join another. The `org` claim is therefore stable per user today, which the harness relies on.
- **The e2e suite is not typechecked** — `tsconfig.json` is the workerd program and covers `src` only, while `tests/principal-token.e2e.ts` is Node and reaches workspace packages the Worker program deliberately cannot see. It is verified by running it, not by `pnpm run typecheck`.
- **No account-deletion path** — deleting a user in Postgres does not inform the harness, whose Durable Object holds that user's sessions under a name derived from ids that no longer exist.
