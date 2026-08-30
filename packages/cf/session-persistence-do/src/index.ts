/**
 * @deepseek-ai/dsh-session-persistence-do — `sessionPersistence` provider
 * backed by the hosting Durable Object's SQLite. The logical session contract
 * (lazy materialization, contiguous seq, crash repair, revision tokens) is the
 * shared coordinator's; this package supplies the row storage behind it.
 * @module @deepseek-ai/dsh-session-persistence-do
 */

import { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-cf-bindings'
import type { SessionEvent, SessionHeader, SessionId, SessionPreparation } from '@deepseek-ai/dsh-session'
import {
  DEFAULT_PREPARED_SESSION_CACHE_SIZE,
  DEFAULT_WRITE_BATCH_MAX_DELAY_MS,
  MAX_WRITE_BATCH_DELAY_MS,
  PersistenceCoordinator,
  SessionPersistence,
  type BorrowedSessionSource,
  type SessionInspection,
  type SessionLocation,
  type SessionPersistenceSnapshot,
} from '@deepseek-ai/dsh-session-persistence'
import { DoSessionStore } from './store.ts'

export { DoSessionStore, TABLE_PREFIX_RE } from './store.ts'

/** Plugin configuration. */
export interface Config {
  /** Identifier prefix of the owned tables (`<prefix>_store`, `<prefix>_sessions`, `<prefix>_events`). */
  tablePrefix: string
  /** Maximum cold Session preparations retained for history-to-resume reuse. */
  preparedSessionCacheSize: number
  /** Fixed live-event coalescing window; not a backend completion deadline. */
  writeBatchMaxDelayMs: number
}

/** Validated configuration. */
export const Config: z<Config> = z.object({
  tablePrefix: z.string().default('session'),
  preparedSessionCacheSize: z.number().step(1).min(1).default(DEFAULT_PREPARED_SESSION_CACHE_SIZE),
  writeBatchMaxDelayMs: z.number().step(1).min(1).max(MAX_WRITE_BATCH_DELAY_MS).default(DEFAULT_WRITE_BATCH_MAX_DELAY_MS),
})

/** Durable Object SQLite `SessionPersistence` provider. */
export class DoSessionPersistence extends SessionPersistence {
  static inject = ['cf', 'sessions']
  static Config = Config

  /** Rows are not a per-session artifact, so there is nothing verbatim to read. */
  override readonly supportsRawArtifacts = false
  override readonly name = 'session-persistence-do'

  private readonly store: DoSessionStore
  private readonly coordinator: PersistenceCoordinator<number>

  constructor(ctx: Context, public config: Config) {
    super(ctx)
    this.store = new DoSessionStore(ctx.cf.storage.sql, config.tablePrefix)
    this.coordinator = new PersistenceCoordinator(this.ctx, this.store, {
      preparedSessionCacheSize: config.preparedSessionCacheSize,
      writeBatchMaxDelayMs: config.writeBatchMaxDelayMs,
    })
  }

  /** One database holds every session; there is no independent per-session artifact. */
  locate(_meta: SessionHeader): SessionLocation | undefined {
    return undefined
  }

  create(meta: SessionHeader): Promise<void> {
    return this.coordinator.create(meta)
  }

  append(id: SessionId, events: readonly SessionEvent[]): Promise<void> {
    return this.coordinator.append(id, events)
  }

  override prepare(id: SessionId, signal?: AbortSignal): Promise<SessionPreparation> {
    return this.coordinator.prepare(id, signal)
  }

  load(id: SessionId): Promise<SessionInspection> {
    return this.coordinator.load(id)
  }

  borrowSession(id: SessionId, signal?: AbortSignal): Promise<BorrowedSessionSource> {
    return this.coordinator.borrowSession(id, signal)
  }

  inspect(id: SessionId, signal?: AbortSignal): Promise<SessionInspection> {
    return this.coordinator.inspect(id, signal)
  }

  readFrom(id: SessionId, fromSeq: number, signal?: AbortSignal): Promise<{ meta: SessionHeader; events: SessionEvent[] }> {
    return this.coordinator.readFrom(id, fromSeq, signal)
  }

  list(signal?: AbortSignal): Promise<SessionHeader[]> {
    return this.store.list(signal)
  }

  listSnapshots(signal?: AbortSignal): Promise<SessionPersistenceSnapshot[]> {
    return this.store.listSnapshots(signal)
  }
}

export default DoSessionPersistence
