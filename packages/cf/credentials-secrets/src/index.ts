/**
 * Durable-Object-backed credentials provider layered over Worker secrets:
 *
 * ```text
 * Durable Object SQLite table      (provider-managed, writable, wins)
 * > Worker secret of the same name (read-only fallback)
 * ```
 *
 * The stored layer wins because it is the only layer a running deployment can
 * edit: a key written from the Models page must take effect immediately even
 * when an older key was deployed as a Worker secret. The secret layer is a
 * deployment-time default, never a shadow, so `set` and `unset` always
 * succeed; `describe` reports a secret-backed reference as configured and
 * writable, the same facts the local provider gives a `.env` fallback.
 *
 * Both key spaces of the seam live in one table keyed by `(space, key)`:
 * reference values are stored verbatim, records as JSON. Durable Object
 * SQLite is synchronous and single-threaded per object, so each write is
 * exclusive without a lock; `modifyRecord` stays serialized through one
 * operation chain because `mutate` is async.
 * @module @deepseek-ai/dsh-credentials-secrets
 */

import { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-cf-bindings'
import type { CfSqlStorage } from '@deepseek-ai/dsh-cf-bindings'
import {
  CredentialProvider,
  credentialRef,
  parseCredentialKey,
} from '@deepseek-ai/dsh-credentials'
import type {
  ApiKeyRecord,
  CredentialInfo,
  CredentialKey,
  CredentialRecord,
  CredentialRecordEntry,
  CredentialRecordInfo,
  CredentialRef,
  ResolvedCredential,
} from '@deepseek-ai/dsh-credentials'

/** Configuration for the Durable Object credentials provider. */
export interface Config {
  /** SQLite table name prefix; the provider owns `<prefix>_records`. */
  tablePrefix: string
}

/** Validated configuration. */
export const Config: z<Config> = z.object({
  tablePrefix: z.string().default('credential'),
})

/** Source layer ids this provider reports. */
export const SOURCE_STORE = 'store'
/** Source layer id for a value supplied by a Worker secret. */
export const SOURCE_SECRET = 'secret'

/** The two key spaces of the seam, as the table's discriminant column. */
type Space = 'ref' | 'record'

const TABLE_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/

/**
 * Refuse an api-key record the read path could not admit: an empty key, an
 * env name outside the reference grammar, or an empty env value.
 * @param key - the record's credential key, for the failure message.
 * @param record - the api-key record a mutation returned.
 */
function assertStorableApiKey(key: CredentialKey, record: ApiKeyRecord): void {
  if (record.key !== undefined && record.key.length === 0) {
    throw new TypeError(`credentials-secrets: record "${key}" has an empty key; omit the field instead`)
  }
  for (const [name, value] of Object.entries(record.env ?? {})) {
    credentialRef(name)
    if (value.length === 0) {
      throw new TypeError(`credentials-secrets: record "${key}" env "${name}" must be a non-empty string`)
    }
  }
}

/**
 * Admit one value as JSON before it is stored: finite numbers, acyclic plain
 * objects and arrays, and nothing with a foreign prototype.
 * @param where - what is being checked, for the failure message.
 * @param value - the candidate value.
 * @param seen - objects on the current path, for cycle detection.
 */
function assertJsonValue(where: string, value: unknown, seen: Set<object>): void {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return
  if (typeof value === 'number') {
    if (Number.isFinite(value)) return
    throw new TypeError(`credentials-secrets: ${where} holds a non-finite number`)
  }
  if (typeof value === 'object') {
    if (seen.has(value)) throw new TypeError(`credentials-secrets: ${where} is cyclic`)
    if (Object.getPrototypeOf(value) === Object.prototype || Array.isArray(value)) {
      seen.add(value)
      for (const nested of Object.values(value)) assertJsonValue(where, nested, seen)
      seen.delete(value)
      return
    }
  }
  throw new TypeError(`credentials-secrets: ${where} is not a JSON value`)
}

/**
 * Parse one stored record row back into the seam's union, refusing anything
 * the write path would not have admitted.
 * @param key - the row's key, for the failure message.
 * @param text - the stored JSON text.
 * @returns the record.
 */
function parseRecord(key: string, text: string): CredentialRecord {
  const value: unknown = JSON.parse(text)
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError(`credentials-secrets: record "${key}" is not a mapping`)
  }
  const fields = value as Record<string, unknown>
  const kind = fields['kind']
  if (kind === 'api-key') {
    const record: ApiKeyRecord = {
      kind: 'api-key',
      ...(typeof fields['key'] === 'string' ? { key: fields['key'] } : {}),
      ...(typeof fields['env'] === 'object' && fields['env'] !== null ? { env: fields['env'] as Record<string, string> } : {}),
    }
    return record
  }
  if (kind === 'grant') return { kind: 'grant', payload: fields['payload'] }
  throw new TypeError(`credentials-secrets: record "${key}" has unknown kind ${JSON.stringify(kind)}`)
}

/** Credentials provider over Durable Object SQLite with Worker secrets as the read-only fallback layer. */
export class SecretsCredentialProvider extends CredentialProvider {
  static inject = ['cf']
  static Config: z<Config> = Config

  private readonly sql: CfSqlStorage
  private readonly table: string
  /** Single exclusive operation chain for record read-modify-write. */
  private operations: Promise<void> = Promise.resolve()

  constructor(ctx: Context, readonly config: Config) {
    super(ctx)
    if (!TABLE_PATTERN.test(config.tablePrefix)) {
      throw new Error(`credentials-secrets: tablePrefix "${config.tablePrefix}" must match ${String(TABLE_PATTERN)}`)
    }
    this.table = `${config.tablePrefix}_records`
    this.sql = ctx.cf.storage.sql
    this.sql.exec(`CREATE TABLE IF NOT EXISTS ${this.table} (space TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY (space, key))`)
  }

  /** The stored value for one key in one space, or `undefined` when absent. */
  private read(space: Space, key: string): string | undefined {
    const rows = this.sql.exec<{ value: string }>(`SELECT value FROM ${this.table} WHERE space = ? AND key = ?`, space, key).toArray()
    return rows[0]?.value
  }

  private write(space: Space, key: string, value: string): void {
    this.sql.exec(`INSERT INTO ${this.table} (space, key, value) VALUES (?, ?, ?) ON CONFLICT (space, key) DO UPDATE SET value = excluded.value`, space, key, value)
  }

  private remove(space: Space, key: string): void {
    this.sql.exec(`DELETE FROM ${this.table} WHERE space = ? AND key = ?`, space, key)
  }

  /** The stored reference value, or `undefined` when absent or empty. */
  private stored(ref: CredentialRef): string | undefined {
    const value = this.read('ref', ref)
    return value !== undefined && value.length > 0 ? value : undefined
  }

  /** The Worker secret for a reference, or `undefined` when unset or empty. */
  private secret(ref: CredentialRef): string | undefined {
    const value = this.ctx.cf.secret(ref)
    return value !== undefined && value.length > 0 ? value : undefined
  }

  override resolve(ref: CredentialRef): Promise<ResolvedCredential | undefined> {
    const stored = this.stored(ref)
    if (stored !== undefined) return Promise.resolve({ value: stored, source: SOURCE_STORE })
    const secret = this.secret(ref)
    if (secret !== undefined) return Promise.resolve({ value: secret, source: SOURCE_SECRET })
    return Promise.resolve(undefined)
  }

  override describe(ref: CredentialRef): Promise<CredentialInfo> {
    // Nothing ranks above the store, so every reference is writable: storing
    // a key replaces a deployed secret as the effective value.
    if (this.stored(ref) !== undefined) return Promise.resolve({ configured: true, source: SOURCE_STORE, writable: true })
    if (this.secret(ref) !== undefined) return Promise.resolve({ configured: true, source: SOURCE_SECRET, writable: true })
    return Promise.resolve({ configured: false, writable: true })
  }

  override set(ref: CredentialRef, value: string): Promise<void> {
    if (value.length === 0) {
      return Promise.reject(new Error(`credentials-secrets: an empty value cannot be stored for "${ref}"; use unset`))
    }
    this.write('ref', ref, value)
    this.notifyUpdated(ref)
    return Promise.resolve()
  }

  override unset(ref: CredentialRef): Promise<void> {
    if (this.read('ref', ref) === undefined) return Promise.resolve()
    this.remove('ref', ref)
    this.notifyUpdated(ref)
    return Promise.resolve()
  }

  override readRecord(key: CredentialKey): Promise<CredentialRecord | undefined> {
    const text = this.read('record', key)
    return Promise.resolve(text === undefined ? undefined : parseRecord(key, text))
  }

  override describeRecord(key: CredentialKey): Promise<CredentialRecordInfo> {
    const text = this.read('record', key)
    if (text === undefined) return Promise.resolve({ configured: false, writable: true })
    return Promise.resolve({ configured: true, kind: parseRecord(key, text).kind, writable: true })
  }

  override listRecords(): Promise<readonly CredentialRecordEntry[]> {
    const rows = this.sql.exec<{ key: string; value: string }>(`SELECT key, value FROM ${this.table} WHERE space = ? ORDER BY key`, 'record').toArray()
    return Promise.resolve(rows.map(row => ({
      key: parseCredentialKey(row.key),
      kind: parseRecord(row.key, row.value).kind,
    })))
  }

  override modifyRecord(
    key: CredentialKey,
    mutate: (current: CredentialRecord | undefined) => Promise<CredentialRecord | undefined>,
  ): Promise<CredentialRecord | undefined> {
    return this.enqueue(async () => {
      const current = await this.readRecord(key)
      const next = await mutate(current)
      if (next === undefined) return current
      if (next.kind === 'grant') assertJsonValue(`record "${key}" payload`, next.payload, new Set())
      else assertStorableApiKey(key, next)
      this.write('record', key, JSON.stringify(next))
      this.notifyRecordUpdated(key)
      return next
    })
  }

  override deleteRecord(key: CredentialKey): Promise<void> {
    return this.enqueue(() => {
      if (this.read('record', key) === undefined) return Promise.resolve()
      this.remove('record', key)
      this.notifyRecordUpdated(key)
      return Promise.resolve()
    })
  }

  /** Queue one exclusive record operation behind every earlier one. */
  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const task = this.operations.then(operation)
    this.operations = task.then(() => undefined, () => undefined)
    return task
  }
}

export default SecretsCredentialProvider
