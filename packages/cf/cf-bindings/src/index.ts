/**
 * @deepseek-ai/dsh-cf-bindings — the `cf` service: the Cloudflare platform
 * handle a Worker or Durable Object hands the plugin tree before any row
 * mounts. Cloudflare Service Providers (`packages/cf/*`) inject `cf` and read
 * their bindings by the names their `Config` carries, so a composition decides
 * which bucket, secret, or container binding each provider uses. The types are
 * the structural subset of the Workers runtime the providers call; the host
 * passes the real runtime objects.
 * @module @deepseek-ai/dsh-cf-bindings
 */

import { Context, Service } from '@deepseek-ai/cordis'

declare module '@deepseek-ai/cordis' {
  interface Context {
    cf: CfBindings
  }
}

/** One SQL result cursor. */
export interface CfSqlCursor<T> {
  /** Every remaining row. */
  toArray(): T[]
  /** Exactly one row; throws when the result has zero or several. */
  one(): T
}

/** The Durable Object SQLite API the providers use. */
export interface CfSqlStorage {
  /**
   * Run one statement.
   * @param query - SQL with `?` placeholders.
   * @param bindings - placeholder values in order.
   */
  exec<T extends Record<string, unknown> = Record<string, unknown>>(query: string, ...bindings: unknown[]): CfSqlCursor<T>
}

/** Durable Object storage: the SQLite handle plus the key-value API. */
export interface CfDurableStorage {
  readonly sql: CfSqlStorage
  /**
   * Read one key-value entry.
   * @param key - entry key.
   */
  get<T = unknown>(key: string): Promise<T | undefined>
  /**
   * Write one key-value entry.
   * @param key - entry key.
   * @param value - structured-clonable value.
   */
  put(key: string, value: unknown): Promise<void>
  /**
   * Delete one key-value entry.
   * @param key - entry key.
   * @returns whether the key existed.
   */
  delete(key: string): Promise<boolean>
}

/** One stored R2 object body. */
export interface CfR2Object {
  readonly key: string
  readonly size: number
  arrayBuffer(): Promise<ArrayBuffer>
  text(): Promise<string>
}

/** One R2 listing page. */
export interface CfR2Listing {
  objects: { key: string; size: number }[]
  truncated: boolean
  cursor?: string
}

/** The R2 bucket API the providers use. */
export interface CfR2Bucket {
  /**
   * Write one object.
   * @param key - object key.
   * @param value - body.
   * @param options - HTTP metadata and custom metadata.
   */
  put(
    key: string,
    value: ArrayBuffer | ArrayBufferView | string,
    options?: { httpMetadata?: { contentType?: string }; customMetadata?: Record<string, string> },
  ): Promise<unknown>
  /**
   * Read one object.
   * @param key - object key.
   * @returns the object, or `null` when absent.
   */
  get(key: string): Promise<CfR2Object | null>
  /**
   * Delete one or more objects.
   * @param keys - object key or keys.
   */
  delete(keys: string | string[]): Promise<void>
  /**
   * List objects.
   * @param options - prefix and pagination.
   */
  list(options?: { prefix?: string; cursor?: string; limit?: number }): Promise<CfR2Listing>
}

/**
 * The server side of one Durable Object WebSocket under the hibernation API:
 * the standard socket surface plus the attachment that survives hibernation.
 */
export interface CfServerSocket {
  readonly readyState: number
  send(data: string | ArrayBuffer | ArrayBufferView): void
  close(code?: number, reason?: string): void
  /**
   * Persist a structured-clonable value with the socket across hibernation.
   * @param value - at most 2 KiB serialized.
   */
  serializeAttachment(value: unknown): void
  /** Read the value stored by {@link serializeAttachment}, or `null`. */
  deserializeAttachment(): unknown
}

/** The Durable Object WebSocket hibernation API. */
export interface CfSocketHost {
  /**
   * Accept a server socket under the hibernation API; events arrive through
   * the object's `webSocketMessage`/`webSocketClose`/`webSocketError` hooks.
   * @param socket - the server half of a `WebSocketPair`.
   * @param tags - optional tags for {@link getWebSockets}.
   */
  acceptWebSocket(socket: CfServerSocket, tags?: string[]): void
  /**
   * Every accepted socket still open, including those accepted before a
   * hibernation this wake recovered from.
   * @param tag - optional tag filter.
   */
  getWebSockets(tag?: string): CfServerSocket[]
}

/** The platform handle the host constructs once per object wake. */
export interface CfPlatform {
  /** The Worker environment: bindings and secrets by name. */
  readonly env: Readonly<Record<string, unknown>>
  /** The hosting Durable Object's storage. */
  readonly storage: CfDurableStorage
  /** The hosting Durable Object's WebSocket hibernation API. */
  readonly sockets: CfSocketHost
  /**
   * Keep the object alive until a background promise settles.
   * @param promise - work that outlives the current request.
   */
  waitUntil(promise: Promise<unknown>): void
}

/**
 * The `cf` service. Constructed by the host with the live platform handle;
 * never configured from a row.
 */
export class CfBindings extends Service {
  constructor(ctx: Context, readonly platform: CfPlatform) {
    super(ctx, 'cf')
  }

  /** The hosting Durable Object's storage. */
  get storage(): CfDurableStorage {
    return this.platform.storage
  }

  /** The hosting Durable Object's WebSocket hibernation API. */
  get sockets(): CfSocketHost {
    return this.platform.sockets
  }

  /**
   * Read one binding by name.
   * @param name - the binding name from the Worker configuration.
   * @returns the binding value; the caller narrows it to the binding type it configured.
   * @throws when the environment has no such binding: a provider configured
   * for a binding the deployment lacks is a misconfiguration.
   */
  binding(name: string): unknown {
    const value = this.platform.env[name]
    if (value === undefined) throw new Error(`cf: binding "${name}" is not present in the Worker environment`)
    return value
  }

  /**
   * Read one secret or plain-text variable by name.
   * @param name - the variable name.
   * @returns the value, or `undefined` when unset.
   */
  secret(name: string): string | undefined {
    const value = this.platform.env[name]
    return typeof value === 'string' ? value : undefined
  }

  /**
   * Keep the object alive until a background promise settles.
   * @param promise - work that outlives the current request.
   */
  waitUntil(promise: Promise<unknown>): void {
    this.platform.waitUntil(promise)
  }
}

export default CfBindings
