/**
 * The Better Auth instance this deployment serves.
 *
 * Built per request rather than per isolate: `env.HYPERDRIVE.connectionString`
 * and every Secrets Store value are only readable once a request is in flight.
 * Hyperdrive owns the underlying connection pool, so building a client here
 * costs no handshake.
 * @module
 */

import { betterAuth, type BetterAuthOptions } from 'better-auth'
import { jwt } from 'better-auth/plugins/jwt'
import { organization } from 'better-auth/plugins/organization'
import { Pool } from 'pg'

/** Everything the auth service is parameterized by, resolved from bindings before it is built. */
export interface AuthDeployment {
  /** Postgres connection string; Hyperdrive's in the Worker, Neon's directly for migration. */
  readonly connectionString: string
  /** Better Auth signing secret, from the account Secrets Store. */
  readonly secret: string
  /** Public origin this service is reached at; Google redirects back to it. */
  readonly baseUrl: string
  /** Origins allowed to start a sign-in flow against this service. */
  readonly trustedOrigins: readonly string[]
  /** Google OAuth client, from the account Secrets Store. */
  readonly google: { readonly clientId: string; readonly clientSecret: string }
}

/**
 * What the Worker needs from the built service.
 *
 * Narrower than Better Auth's own instance type on purpose: the inferred type
 * reaches into the zod internals of every plugin's route schemas, which is not
 * portable across programs, and the Worker calls exactly one method.
 */
export interface AuthService {
  /**
   * Serve one request against Better Auth's own routes.
   * @param request - the incoming request.
   * @returns the auth service's response.
   */
  handler(request: Request): Promise<Response>
}

/**
 * Late-bound holder for the instance's own organization API.
 *
 * The signup hook needs the instance that the hook is an option of, so the
 * holder is filled immediately after construction and read only from
 * request-time hooks, which cannot run earlier. The call is declared inline
 * because TypeScript cannot infer a type that refers to itself; only
 * `createOrganization` is asserted, and only the fields used here. Schema
 * generation passes an empty holder because migration runs no hooks.
 */
interface OrganizationCreation {
  createOrganization(input: {
    body: {
      name: string
      slug: string
      userId: string
      keepCurrentActiveOrganization: boolean
    }
  }): Promise<unknown>
}

export interface OrganizationCreationHolder {
  /** The instance's organization API, bound immediately after construction. */
  current?: OrganizationCreation
}

/** Slug for the organization every user gets at signup, unique per user id. */
function personalSlug(userId: string): string {
  return `personal-${userId}`.toLowerCase()
}

/**
 * Find the organization a user belongs to, for the session being created.
 *
 * Read as SQL rather than through the organization plugin's API: that API
 * derives its user from the session, and this runs before the session exists.
 * The `member` table it reads is created by this app's own committed
 * migration, so the coupling is to a schema this deployment versions.
 * @param pool - the request's connection pool.
 * @param userId - the user whose session is being created.
 * @returns the organization id, or undefined when the user has no membership yet.
 */
async function membershipOrganization(pool: Pool, userId: string): Promise<string | undefined> {
  const result = await pool.query<{ organizationId: string }>(
    'select "organizationId" from "member" where "userId" = $1 order by "createdAt" asc limit 1',
    [userId],
  )
  return result.rows.at(0)?.organizationId
}

/**
 * The complete Better Auth configuration for this deployment.
 *
 * Exported so schema generation and the running Worker read one definition:
 * a migration compiled from different options than the service runs is a
 * schema that drifts silently.
 *
 * Two plugins and nothing else. `organization` is here because the harness
 * addresses its Durable Objects by organization and user, so a user with no
 * organization has no object to reach; `jwt` is here because the harness edge
 * verifies against JWKS rather than calling this service per request.
 * @param deployment - resolved configuration for this process or request.
 * @param organizations - holder filled with the instance's own API after construction.
 * @returns the options `betterAuth` is built from.
 */
export function authOptions(
  deployment: AuthDeployment,
  organizations: OrganizationCreationHolder,
): BetterAuthOptions {
  const pool = new Pool({ connectionString: deployment.connectionString })

  return {
    database: pool,
    secret: deployment.secret,
    baseURL: deployment.baseUrl,
    trustedOrigins: [...deployment.trustedOrigins],

    // No mailer in this deployment, so no flow may depend on one: sign-up
    // completes without a verification round trip, and there is no reset path.
    emailAndPassword: {
      enabled: true,
      requireEmailVerification: false,
    },
    emailVerification: {
      sendOnSignUp: false,
    },

    socialProviders: {
      google: {
        clientId: deployment.google.clientId,
        clientSecret: deployment.google.clientSecret,
      },
    },

    // One human is one user id. Someone who signs up by password and later
    // presses Continue with Google would otherwise receive a second user id, a
    // second personal organization, and a Durable Object holding none of their
    // sessions; merging afterwards moves object contents, not database rows.
    account: {
      accountLinking: {
        enabled: true,
        trustedProviders: ['google'],
      },
    },

    databaseHooks: {
      user: {
        create: {
          after: async (user): Promise<void> => {
            const api = organizations.current
            if (api === undefined) {
              throw new Error('dsh-cf-auth: signup hook ran before the auth instance was bound')
            }
            // Every user owns an organization from their first session, because
            // the Durable Object name carries an organization id and there is
            // no rename. Created with an explicit `userId`: at this point in
            // signup the user has no session to act through.
            await api.createOrganization({
              body: {
                name: user.name.length > 0 ? user.name : user.email,
                slug: personalSlug(user.id),
                userId: user.id,
                keepCurrentActiveOrganization: false,
              },
            })
          },
        },
      },
      session: {
        create: {
          before: async (session): Promise<{ data: typeof session } | undefined> => {
            // The JWT's organization claim reads from the session, so the
            // active organization must be resolved before the session exists.
            const organizationId = await membershipOrganization(pool, session.userId)
            if (organizationId === undefined) return undefined
            return { data: { ...session, activeOrganizationId: organizationId } }
          },
        },
      },
    },

    plugins: [
      organization(),
      jwt({
        jwt: {
          // The harness edge builds its Durable Object name from these two
          // claims alone, so both must be present and both must be the
          // identity service's opaque ids.
          //
          // The organization is resolved here rather than read from the
          // session, because signup creates the session before the personal
          // organization exists: the session hook below sees no membership yet
          // and leaves `activeOrganizationId` null, which would issue a first
          // token the edge cannot address an object with. A selected active
          // organization still wins once there is one to select.
          definePayload: async ({ user, session }) => {
            const active: unknown = session.activeOrganizationId
            const org = typeof active === 'string' && active.length > 0
              ? active
              : await membershipOrganization(pool, user.id)
            if (org === undefined) {
              // Refused here rather than issued null: a token naming no
              // organization is one the harness edge rejects as malformed,
              // which reports the wrong fault at the wrong service.
              throw new Error(`dsh-cf-auth: user ${user.id} belongs to no organization; cannot issue a token`)
            }
            return { sub: user.id, org }
          },
        },
      }),
    ],
  }
}

/**
 * Build the auth service for one request.
 * @param deployment - resolved bindings for this request.
 * @returns the service, narrowed to what the Worker calls.
 */
export function createAuth(deployment: AuthDeployment): AuthService {
  const organizations: OrganizationCreationHolder = {}
  const auth = betterAuth(authOptions(deployment, organizations))
  // Widening the options to `BetterAuthOptions`, so schema generation and the
  // Worker share one definition, erases the plugins' contribution to the
  // inferred `auth.api`. The organization plugin still installs
  // `createOrganization` at runtime, with the fields asserted on the holder.
  const api: unknown = auth.api
  organizations.current = api as OrganizationCreation
  return auth
}
