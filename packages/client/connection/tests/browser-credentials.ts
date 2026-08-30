import type { Context } from '@deepseek-ai/cordis'
import type { CredentialProvider, CredentialRecord, CredentialRef, ResolvedCredential } from '@deepseek-ai/dsh-credentials'

/** Mutable credential-record double for Connection authentication tests. */
export class RecordCredentials {
  record: CredentialRecord | undefined
  discardWrites = false
  reads = 0
  modifies = 0
  /** Reference values this store resolves, for the configured launch token. */
  readonly refs = new Map<string, string>()

  resolve(ref: CredentialRef): Promise<ResolvedCredential | undefined> {
    const value = this.refs.get(ref)
    return Promise.resolve(value === undefined ? undefined : { value, source: 'test' })
  }

  readRecord(): Promise<CredentialRecord | undefined> {
    this.reads += 1
    return Promise.resolve(this.record)
  }

  async modifyRecord(
    _key: unknown,
    mutate: (current: CredentialRecord | undefined) => Promise<CredentialRecord | undefined>,
  ): Promise<CredentialRecord | undefined> {
    this.modifies += 1
    const next = await mutate(this.record)
    if (this.discardWrites) return undefined
    if (next !== undefined) this.record = next
    return this.record
  }

  deleteRecord(): Promise<void> {
    this.record = undefined
    return Promise.resolve()
  }
}

/**
 * Provide the record operations Connection needs during authentication setup.
 * @param ctx - context the provider is installed on.
 * @returns the installed store, for a test that seeds a reference value.
 */
export function provideBrowserCredentials(ctx: Context): RecordCredentials {
  const store = new RecordCredentials()
  ctx.provide('credentials', store as unknown as CredentialProvider)
  return store
}
