/**
 * Edge verification of the identity service's JWT.
 *
 * This runs in the Worker, before a Durable Object is addressed, which is what
 * makes isolation structural: an object is reached only under the name built
 * from an already-verified principal, so it cannot serve the wrong tenant
 * because it was never addressed for them. Nothing here talks to the identity
 * service on the request path — signatures are checked against a JWKS cached
 * per isolate, so a sleeping identity deployment costs a slow sign-in and never
 * a slow session.
 * @module @deepseek-ai/dsh-principal-jwt/verify
 */

import { createRemoteJWKSet, jwtVerify } from 'jose'
import z from '@deepseek-ai/schemastery'
import { OrganizationId, UserId, type Principal } from '@deepseek-ai/dsh-principal'

/** How the edge is parameterized by the identity service it verifies against. */
export interface VerifierConfig {
  /** JWKS endpoint of the identity service; Better Auth serves it at `/api/auth/jwks`. */
  jwksUrl: string
  /** Issuer every accepted token must name, which is the identity service's own base URL. */
  issuer: string
  /** Audience every accepted token must name; omitted when the deployment does not scope its tokens. */
  audience?: string
  /** Shortest interval between two JWKS fetches, in seconds: the floor an unknown `kid` cannot refresh past. */
  refreshFloorSeconds: number
  /** How long a fetched JWKS is reused before the next unknown `kid` refetches it, in seconds. */
  cacheMaxAgeSeconds: number
  /** Clock skew allowed on `exp` and `nbf`, in seconds. */
  clockToleranceSeconds: number
}

/**
 * Validated configuration.
 *
 * The identity service is a deployment choice, so its URL and issuer are
 * required with no default: a Worker that has not named the service it trusts
 * must fail at startup rather than verify against something it guessed. The
 * refresh floor is what keeps an attacker with a stream of unknown `kid`
 * values from turning every request into a fetch of the identity service.
 */
export const VerifierConfig: z<VerifierConfig> = z.object({
  jwksUrl: z.string().required(),
  issuer: z.string().required(),
  audience: z.string(),
  refreshFloorSeconds: z.natural().min(1).default(30),
  cacheMaxAgeSeconds: z.natural().min(1).default(600),
  clockToleranceSeconds: z.natural().default(5),
})

/** One token the edge accepted. */
export interface VerifiedToken {
  /** The principal the token was issued for. */
  readonly principal: Principal
  /** Unix seconds after which the token is refused, which is also how long a session built on it may last. */
  readonly expiresAt: number
}

/** Why one token was refused. Carried so a caller can log the fault without deciding what to tell the browser. */
export class PrincipalTokenError extends Error {
  override name = 'PrincipalTokenError'
}

const SECOND_MILLISECONDS = 1000

/**
 * Read one claim as an identity-service identifier.
 *
 * A token is wire input, so both claims are checked here rather than trusted
 * from the static type: they become branded ids that reach the permanent
 * Durable Object name, where a value holding `:` would make the name ambiguous.
 * @param claims - the verified payload.
 * @param name - which claim to read.
 * @returns the claim's value.
 */
function identifier(claims: Record<string, unknown>, name: string): string {
  const value = claims[name]
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new PrincipalTokenError(`principal-jwt: token claim ${JSON.stringify(name)} is not an identity-service identifier`)
  }
  return value
}

/**
 * Verifies identity-service tokens against one JWKS, cached for this isolate.
 *
 * One instance per isolate is the intended lifetime: the cache lives in the
 * key set it holds, so a verifier rebuilt per request refetches the JWKS every
 * time and the refresh floor protects nothing.
 */
export class PrincipalTokenVerifier {
  private readonly keys: ReturnType<typeof createRemoteJWKSet>

  /** @param config - validated {@link VerifierConfig}. */
  constructor(private readonly config: VerifierConfig) {
    this.keys = createRemoteJWKSet(new URL(config.jwksUrl), {
      cooldownDuration: config.refreshFloorSeconds * SECOND_MILLISECONDS,
      cacheMaxAge: config.cacheMaxAgeSeconds * SECOND_MILLISECONDS,
    })
  }

  /**
   * Verify one token and read the principal out of it.
   * @param token - the compact JWS the request carried.
   * @returns the principal the token was issued for, and when it stops being accepted.
   * @throws {PrincipalTokenError} when the token is malformed, unsigned,
   * signed by a key this JWKS does not hold, expired, endless, issued by
   * another service, or missing either claim the object name is built from.
   */
  async verify(token: string): Promise<VerifiedToken> {
    let claims: Record<string, unknown>
    try {
      const verified = await jwtVerify(token, this.keys, {
        issuer: this.config.issuer,
        ...(this.config.audience === undefined ? {} : { audience: this.config.audience }),
        clockTolerance: this.config.clockToleranceSeconds,
        // A token with no expiry would let a session outlive every revocation
        // the identity service can make, because the edge asks it nothing.
        requiredClaims: ['exp'],
      })
      claims = verified.payload
    } catch (error) {
      // Stringified rather than narrowed: jose reports every refusal the same
      // way, and the caller must not tell them apart in what it answers a
      // browser with, only in what it logs.
      throw new PrincipalTokenError(`principal-jwt: token rejected: ${String(error)}`, { cause: error })
    }
    return {
      principal: {
        org: OrganizationId(identifier(claims, 'org')),
        subject: { kind: 'user', user: UserId(identifier(claims, 'sub')) },
      },
      // `requiredClaims` admitted the token, so jose has already refused one
      // whose `exp` is absent or not a number.
      expiresAt: claims['exp'] as number,
    }
  }
}
