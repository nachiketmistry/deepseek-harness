/**
 * Durable Object SQLite implementation of the coordinator's physical backend
 * hooks. One sessions table holds the header JSON and a per-row revision
 * counter; one events table holds one JSON event per row keyed by
 * `(session, seq)`. Every mutation runs as one synchronous statement sequence:
 * Durable Object SQLite commits all writes issued before the next `await`
 * atomically, which gives the materialize-plus-first-batch atomicity the
 * coordinator requires without an explicit transaction API.
 * @module @deepseek-ai/dsh-session-persistence-do/src/store
 */

import type { CfSqlStorage } from '@deepseek-ai/dsh-cf-bindings'
import { decodeStorageRecord } from '@deepseek-ai/dsh-session'
import type { SessionEvent, SessionHeader, SessionId } from '@deepseek-ai/dsh-session'
import {
  SessionPersistenceRevision,
  type PersistenceBackend,
  type SessionPersistenceSnapshot,
  type StoredPrefix,
  type StoredSuffix,
} from '@deepseek-ai/dsh-session-persistence'
import { decodeHeader, encodeHeader } from './header.ts'

/** Allowed table prefix: a bare SQL identifier segment that needs no quoting. */
export const TABLE_PREFIX_RE = /^[a-z][a-z0-9_]*$/

interface SessionRow extends Record<string, unknown> {
  id: string
  header: string
  incarnation: string
  revision: number
}

interface EventRow extends Record<string, unknown> {
  seq: number
  event: string
}

/** A scan of physical event rows into the valid contiguous prefix. */
interface RowScan {
  preserved: SessionEvent[]
  /** Physical seq of the first row that breaks the prefix, when one does. */
  tornFrom?: number
}

/**
 * Decode rows in physical order into the contiguous logical prefix starting at
 * `base`. The first unparsable row or seq gap ends the prefix; its physical
 * seq is the torn marker the repair deletes from.
 */
function scanRows(rows: readonly EventRow[], base: number): RowScan {
  const preserved: SessionEvent[] = []
  let expected = base
  for (const row of rows) {
    let decoded: SessionEvent[]
    try {
      decoded = decodeStorageRecord(JSON.parse(row.event))
    } catch {
      // An unparsable row is a torn tail, not a read failure: the rows before
      // it stay valid and the repair truncates from here.
      return { preserved, tornFrom: row.seq }
    }
    const event = decoded[0]
    if (decoded.length !== 1 || event === undefined || row.seq !== expected || event.seq !== expected) {
      return { preserved, tornFrom: row.seq }
    }
    preserved.push(event)
    expected += 1
  }
  return { preserved }
}

/** The Durable Object SQLite backend behind the `sessionPersistence` coordinator. */
export class DoSessionStore implements PersistenceBackend<number> {
  readonly name = 'session-persistence-do'

  private readonly storeTable: string
  private readonly sessionsTable: string
  private readonly eventsTable: string
  private readonly storeIdentity: string

  /**
   * Create the tables when absent and read the store identity.
   * @param sql - the hosting Durable Object's SQLite handle.
   * @param tablePrefix - identifier prefix for the three owned tables.
   */
  constructor(private readonly sql: CfSqlStorage, tablePrefix: string) {
    if (!TABLE_PREFIX_RE.test(tablePrefix)) {
      throw new Error(`session-persistence-do: tablePrefix "${tablePrefix}" must match ${String(TABLE_PREFIX_RE)}`)
    }
    this.storeTable = `${tablePrefix}_store`
    this.sessionsTable = `${tablePrefix}_sessions`
    this.eventsTable = `${tablePrefix}_events`
    sql.exec(`CREATE TABLE IF NOT EXISTS ${this.storeTable} (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      store_id TEXT NOT NULL
    )`)
    sql.exec(`CREATE TABLE IF NOT EXISTS ${this.sessionsTable} (
      id TEXT PRIMARY KEY,
      header TEXT NOT NULL,
      incarnation TEXT NOT NULL,
      revision INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )`)
    sql.exec(`CREATE TABLE IF NOT EXISTS ${this.eventsTable} (
      session TEXT NOT NULL,
      seq INTEGER NOT NULL,
      event TEXT NOT NULL,
      PRIMARY KEY (session, seq)
    )`)
    sql.exec(`INSERT OR IGNORE INTO ${this.storeTable} (singleton, store_id) VALUES (1, ?)`, crypto.randomUUID())
    const { store_id } = sql.exec<{ store_id: string }>(`SELECT store_id FROM ${this.storeTable} WHERE singleton = 1`).one()
    this.storeIdentity = `do:store:${store_id}`
  }

  loadStored(id: SessionId, signal?: AbortSignal): Promise<StoredPrefix<number> | undefined> {
    signal?.throwIfAborted()
    const row = this.rowFor(id)
    if (row === undefined) return Promise.resolve(undefined)
    const scanned = scanRows(this.eventRowsFrom(id, 0), 0)
    return Promise.resolve({
      meta: decodeHeader(row.header, row.id),
      events: scanned.preserved,
      revision: this.revision(row),
      ...scanned.tornFrom === undefined ? {} : { tornMarker: scanned.tornFrom },
    })
  }

  readStoredRevision(id: SessionId, signal?: AbortSignal): Promise<SessionPersistenceRevision | undefined> {
    signal?.throwIfAborted()
    const row = this.rowFor(id)
    return Promise.resolve(row === undefined ? undefined : this.revision(row))
  }

  /** Seek-capable suffix read: only rows with `seq >= fromSeq` are decoded. */
  loadStoredFrom(id: SessionId, fromSeq: number, signal?: AbortSignal): Promise<StoredSuffix | undefined> {
    signal?.throwIfAborted()
    const row = this.rowFor(id)
    if (row === undefined) return Promise.resolve(undefined)
    const { preserved } = scanRows(this.eventRowsFrom(id, fromSeq), fromSeq)
    return Promise.resolve({ meta: decodeHeader(row.header, row.id), events: preserved })
  }

  appendBatch(meta: SessionHeader, events: readonly SessionEvent[], isMaterialized: boolean): Promise<void> {
    if (events.length === 0) return Promise.resolve()
    const expected = this.nextSeq(meta.id)
    const first = events[0] as SessionEvent
    if (first.seq !== expected) {
      throw new Error(`session ${meta.id} append starts at seq ${first.seq}, stored next seq is ${expected}`)
    }
    const now = Date.now()
    if (!isMaterialized) {
      this.sql.exec(
        `INSERT INTO ${this.sessionsTable} (id, header, incarnation, revision, created_at, updated_at) VALUES (?, ?, ?, 0, ?, ?)`,
        meta.id,
        encodeHeader(meta),
        crypto.randomUUID(),
        meta.createdAt,
        now,
      )
    }
    for (const event of events) this.insertEvent(meta.id, event)
    this.bumpRevision(meta.id, now)
    return Promise.resolve()
  }

  commitRepair(meta: SessionHeader, tornMarker: number | undefined, closers: readonly SessionEvent[]): Promise<void> {
    if (tornMarker === undefined && closers.length === 0) return Promise.resolve()
    if (this.rowFor(meta.id) === undefined) throw new Error(`session ${meta.id} metadata row is missing`)
    const current = scanRows(this.eventRowsFrom(meta.id, 0), 0)
    if (tornMarker !== undefined) {
      if (current.tornFrom !== tornMarker) {
        throw new Error(`session ${meta.id} repair is stale: physical tail no longer starts at seq ${tornMarker}`)
      }
      this.sql.exec(`DELETE FROM ${this.eventsTable} WHERE session = ? AND seq >= ?`, meta.id, tornMarker)
    } else if (current.tornFrom !== undefined) {
      throw new Error(`session ${meta.id} repair omitted current torn tail at seq ${current.tornFrom}`)
    }
    if (closers.length > 0) {
      const expected = current.preserved.length
      const first = closers[0] as SessionEvent
      if (first.seq !== expected) {
        throw new Error(`session ${meta.id} repair is stale: closer starts at seq ${first.seq}, stored next seq is ${expected}`)
      }
      for (const closer of closers) this.insertEvent(meta.id, closer)
    }
    this.bumpRevision(meta.id, Date.now())
    return Promise.resolve()
  }

  list(signal?: AbortSignal): Promise<SessionHeader[]> {
    signal?.throwIfAborted()
    return Promise.resolve(this.sessionRows().map(row => decodeHeader(row.header, row.id)))
  }

  /**
   * List every session with its revision token.
   * @param signal - optional cancellation.
   * @returns one header and revision per stored session.
   */
  listSnapshots(signal?: AbortSignal): Promise<SessionPersistenceSnapshot[]> {
    signal?.throwIfAborted()
    return Promise.resolve(this.sessionRows().map(row => ({
      header: decodeHeader(row.header, row.id),
      revision: this.revision(row),
    })))
  }

  private rowFor(id: SessionId): SessionRow | undefined {
    return this.sql.exec<SessionRow>(
      `SELECT id, header, incarnation, revision FROM ${this.sessionsTable} WHERE id = ?`,
      id,
    ).toArray()[0]
  }

  private sessionRows(): SessionRow[] {
    return this.sql.exec<SessionRow>(
      `SELECT id, header, incarnation, revision FROM ${this.sessionsTable} ORDER BY created_at, id`,
    ).toArray()
  }

  private eventRowsFrom(id: SessionId, fromSeq: number): EventRow[] {
    return this.sql.exec<EventRow>(
      `SELECT seq, event FROM ${this.eventsTable} WHERE session = ? AND seq >= ? ORDER BY seq`,
      id,
      fromSeq,
    ).toArray()
  }

  /** The seq the next append must start at: one past the last stored row. */
  private nextSeq(id: SessionId): number {
    const { last } = this.sql.exec<{ last: number | null }>(
      `SELECT MAX(seq) AS last FROM ${this.eventsTable} WHERE session = ?`,
      id,
    ).one()
    return last === null ? 0 : last + 1
  }

  private insertEvent(id: SessionId, event: SessionEvent): void {
    this.sql.exec(
      `INSERT INTO ${this.eventsTable} (session, seq, event) VALUES (?, ?, ?)`,
      id,
      event.seq,
      JSON.stringify(event),
    )
  }

  private bumpRevision(id: SessionId, now: number): void {
    this.sql.exec(
      `UPDATE ${this.sessionsTable} SET revision = revision + 1, updated_at = ? WHERE id = ?`,
      now,
      id,
    )
  }

  private revision(row: SessionRow): SessionPersistenceRevision {
    return SessionPersistenceRevision(`${this.storeIdentity}:incarnation:${row.incarnation}:revision:${String(row.revision)}`)
  }
}
