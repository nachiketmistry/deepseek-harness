# Agent Note: Deployment-supplied launch token

Status: implemented

English | [中文](2026-08-29-deployment-supplied-launch-token.zh.md)

## Problem

Browser authentication reaches every surface, but its bootstrap credential was built for one of them. [Browser launch-token authentication](2026-08-24-browser-token-authentication.md) generates a random launch token per Host process and hands it to the operator through the surface that started that process: `dsh web` prints the URL to the terminal the operator is watching. The Cloudflare deployment has neither half. A Worker has no terminal, and the platform starts and evicts the Host Durable Object on its own schedule, so the token a boot generates is replaced before an operator can act on it.

The deployed GUI made that visible: `web-cf` wrote the launch URL to the log stream once per boot, and the operator read it there. Against the live deployment, a token read from a cold boot was refused four minutes later, because the object had already restarted and generated another. The index answered 401 to every request, the API answered 401 to every call, and no sequence of reading the log and opening the URL converged, because each read raced the next restart. Publishing the credential to a persisted log stream was also the wrong place for it: Workers Logs are readable by every account principal with log access, not only by whoever performed the deploy.

## Decision

A deployment that cannot hand the operator a freshly generated token supplies its own. `client-connection` takes a `launchTokenRef` config field naming a credential reference; when set, Connection resolves it through `ctx.credentials` during activation and `BrowserAuth` uses that value as the launch token instead of generating one. When unset, the launch token is generated per process exactly as before, which is what the loopback CLI needs and what every existing Node surface keeps.

The reference is a configuration input, so it fails at load: a value outside the credential-reference grammar and a reference the provider resolves to nothing both throw during plugin activation. A deployment that named its bootstrap credential and cannot read it has no other way to admit its operator, so refusing to boot states that plainly rather than serving a GUI nobody can enter. A supplied token shorter than 32 characters is refused for the same reason the generated one is 32 random bytes: it is the whole bootstrap credential of a network-reachable deployment, and its length is not a deployment-varying tunable.

The Cloudflare composition sets `launchTokenRef: DSH_LAUNCH_TOKEN` (`apps/cf-web/scripts/compose.mjs`, renamable at build time through `DSH_CF_LAUNCH_TOKEN_REF`). `dsh-credentials-secrets` resolves a reference from the Durable Object store first and the Worker secret of the same name second, so `wrangler secret put DSH_LAUNCH_TOKEN` is the whole operator step, and the Models page can rotate the value later without a redeploy. `web-cf` no longer logs a launch URL: the token now outlives the isolate, and a credential the operator already holds does not belong in a persisted log stream.

The session cookie carries `Secure` when the index request that minted it arrived over HTTPS, read from the request URL's scheme rather than from any forwarding header. A Fetch carrier supplies an absolute `https:` URL; `node:http` supplies a path, which resolves against the sentinel `http:` base and keeps the shipped loopback server's cookie unchanged.

## Verification

Unit coverage pins that a supplied token is the one `authenticatedUrl` publishes, that it still exchanges after a restart with a new process owner, that a 31-character token is refused, and that `Secure` follows the index request's scheme in both directions. Plugin-level coverage boots Connection with `launchTokenRef` against a credential store that resolves it, and pins both load failures: an unresolvable reference and a value outside the reference grammar.

## Alternatives considered

**Persist the generated token beside the cookie signing secret.** This makes the token survive restarts but leaves the log stream as the only place to read it, so the operator still learns their credential from persisted logs and a first deploy still races the first eviction. The [launch-token note](2026-08-24-browser-token-authentication.md) declined a durable token for the loopback CLI because it would become a second long-lived credential there; that reasoning holds for the surface it was written about, and the deployment answers it by having the operator own the credential rather than the process minting one.

**Put Cloudflare Access in front of the deployment.** Zero Trust Access is the platform-native operator authentication and remains the better answer for a shared deployment. It requires a JWT-verifying seam in Connection and an Access-configured zone, neither of which exists, and it does not remove the need for a bootstrap credential on a `workers.dev` deployment. It stays open rather than rejected.

**Read the token from a `cf` binding inside `web-cf`.** The glue package would then own an authentication input that Connection enforces, splitting one decision across two packages. Connection already injects `credentials` for the cookie signing secret, so the reference resolves where the token is used.

## Consequences

A Cloudflare deployment now has one durable bootstrap credential the operator sets, and login is a single URL open whose cookie survives restarts and redeploys. The credential is long-lived: rotating it means changing the secret, and existing cookies keep working until they expire, because the cookie is signed by the separate durable secret. Deleting the `client-connection/browser-session` grant record and restarting remains the global session revocation.

A deployment upgrading to this build without setting the secret fails its boot with the reference named in the message. That is the intended failure: the previous behavior was a deployment that answered every request with 401.
