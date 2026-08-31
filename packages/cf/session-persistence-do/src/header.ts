/**
 * JSON encoding of one {@link SessionHeader} as stored in the sessions table.
 * The encoded object carries the same fields as the JSONL provider's header
 * line so a row and a log line describe one session identically.
 * @module @deepseek-ai/dsh-session-persistence-do/src/header
 */

import type { SessionHeader, SessionId } from '@deepseek-ai/dsh-session'
import { SessionFormatUnsupportedError, sessionFormatVersionRefusal } from '@deepseek-ai/dsh-session-persistence'
import { SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'

/** The stored header object; absent optional fields are omitted, never null. */
interface StoredHeader {
  version: number
  id: SessionId
  createdAt: number
  cwd?: string
  parentSession?: SessionId
  seedLength?: number
  origin?: 'subagent'
  delegationDepth: number
  agentPreset?: string
}

/**
 * Encode a header for the `header` column.
 * @param header - the immutable session metadata.
 * @returns the JSON text.
 */
export function encodeHeader(header: SessionHeader): string {
  const stored: StoredHeader = {
    version: header.version,
    id: header.id,
    createdAt: header.createdAt,
    ...header.cwd !== undefined ? { cwd: header.cwd } : {},
    ...header.parentSession !== undefined ? { parentSession: header.parentSession } : {},
    ...header.seedLength !== undefined ? { seedLength: header.seedLength } : {},
    ...header.origin !== undefined ? { origin: header.origin } : {},
    delegationDepth: header.delegationDepth ?? 0,
    ...header.agentPreset !== undefined ? { agentPreset: header.agentPreset } : {},
  }
  return JSON.stringify(stored)
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && !Object.is(value, -0)
}

function isStoredHeader(value: unknown): value is StoredHeader {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Record<string, unknown>
  return typeof record['version'] === 'number'
    && typeof record['id'] === 'string'
    && isNonNegativeInteger(record['createdAt'])
    && isNonNegativeInteger(record['delegationDepth'])
    && (record['cwd'] === undefined || typeof record['cwd'] === 'string')
    && (record['parentSession'] === undefined || typeof record['parentSession'] === 'string')
    && (record['seedLength'] === undefined || isNonNegativeInteger(record['seedLength']))
    && (record['origin'] === undefined || record['origin'] === 'subagent')
    && (record['agentPreset'] === undefined || typeof record['agentPreset'] === 'string')
}

/**
 * Decode a `header` column. A foreign format version refuses with
 * {@link SessionFormatUnsupportedError} before any structural check, so a
 * newer harness's row reads as "upgrade", never as corruption.
 * @param text - the stored JSON text.
 * @param id - the row's session id, for diagnostics.
 * @returns the decoded header.
 */
export function decodeHeader(text: string, id: string): SessionHeader {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    throw new Error(`corrupt session row "${id}": header is not valid JSON`, { cause: error })
  }
  if (typeof parsed === 'object' && parsed !== null) {
    const version = (parsed as { version?: unknown }).version
    if (typeof version === 'number' && version !== SESSION_FORMAT_VERSION) {
      throw new SessionFormatUnsupportedError(sessionFormatVersionRefusal(id, version))
    }
  }
  if (!isStoredHeader(parsed)) {
    throw new Error(`corrupt session row "${id}": header is not a session header`)
  }
  if (parsed.id !== id) {
    throw new Error(`corrupt session row "${id}": header names session "${parsed.id}"`)
  }
  return {
    version: parsed.version,
    id: parsed.id,
    createdAt: parsed.createdAt,
    ...parsed.cwd !== undefined ? { cwd: parsed.cwd } : {},
    ...parsed.parentSession !== undefined ? { parentSession: parsed.parentSession } : {},
    ...parsed.seedLength !== undefined ? { seedLength: parsed.seedLength } : {},
    ...parsed.origin !== undefined ? { origin: parsed.origin } : {},
    delegationDepth: parsed.delegationDepth,
    ...parsed.agentPreset !== undefined ? { agentPreset: parsed.agentPreset } : {},
  }
}
