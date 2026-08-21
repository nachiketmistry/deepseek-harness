/**
 * @deepseek-ai/dsh-settings-do — `settings` provider whose one YAML document
 * lives under a key in the hosting Durable Object's key-value storage. The
 * document carries every namespace section; each write re-reads the stored
 * text and patches it as a comment-preserving leaf-level diff, as the file
 * provider does. No external editor reaches the row, so there is no watcher.
 * @module @deepseek-ai/dsh-settings-do
 */

import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-cf-bindings'
import { Document, parseDocument } from 'yaml'
import { SettingsProvider, deepEqualJson, type SettingsNamespace } from '@deepseek-ai/dsh-settings'

/** Plugin configuration. */
export interface Config {
  /** Durable Object key-value storage key holding the YAML document text. */
  key: string
}

/** Validated configuration. */
export const Config: z<Config> = z.object({
  key: z.string().default('settings-document'),
})

/** Whether a parsed YAML value is a map for diffing purposes. */
function isMapLike(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Apply the difference between one node's stored and next value as minimal
 * `setIn`/`deleteIn` edits, recursing through maps, so every untouched node
 * keeps its comments, anchors, and formatting. Non-map values replace
 * wholesale when unequal.
 */
function patchNode(document: Document, path: readonly string[], current: unknown, next: unknown): void {
  if (isMapLike(current) && isMapLike(next)) {
    for (const key of Object.keys(current)) {
      if (!(key in next)) document.deleteIn([...path, key])
    }
    for (const [key, value] of Object.entries(next)) {
      patchNode(document, [...path, key], current[key], value)
    }
    return
  }
  if (!deepEqualJson(current, next)) document.setIn([...path], next)
}

/** Durable Object storage settings provider. */
export class DoSettingsProvider extends SettingsProvider {
  static inject = ['cf']
  static Config = Config

  /**
   * Raw text of the last successfully parsed or persisted document;
   * `undefined` while no document is stored.
   */
  private text: string | undefined
  /**
   * Single exclusive operation chain: one document backs every namespace, so
   * writes from different namespace queues serialize here (settled tail).
   */
  private operations: Promise<void> = Promise.resolve()
  /** Set at dispose: in-flight work no-ops its publication. */
  private closed = false

  constructor(ctx: Context, public config: Config) {
    super(ctx)
    if (config.key.length === 0) throw new Error('settings-do: key must not be empty')
  }

  /** The stored document is always writable through {@link SettingsProvider.update}. */
  get writable(): boolean {
    return true
  }

  protected async load(): Promise<Record<string, unknown>> {
    const text = await this.readText()
    if (text === undefined) {
      this.text = undefined
      return {}
    }
    const doc = this.parse(text)
    this.text = text
    return doc
  }

  protected persist(ns: SettingsNamespace, section: Record<string, unknown>): Promise<void> {
    return this.enqueue(() => this.persistSection(ns, section))
  }

  override async* [Service.init](): AsyncGenerator<() => Promise<void> | void, void, void> {
    yield* super[Service.init]()
    yield async () => {
      this.closed = true
      await this.operations
    }
  }

  /** Queue one exclusive document operation behind every earlier one. */
  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const task = this.operations.then(operation)
    this.operations = task.then(() => undefined, () => undefined)
    return task
  }

  private async persistSection(ns: SettingsNamespace, section: Record<string, unknown>): Promise<void> {
    // Read-modify-write against the stored text so a render can never
    // resurrect a document this object has not observed; an unparsable
    // stored document fails the write loud instead of being overwritten.
    await this.reconcileFromStorage()
    const output = this.render(ns, section)
    await this.ctx.cf.storage.put(this.config.key, output)
    this.text = output
  }

  private async readText(): Promise<string | undefined> {
    const value = await this.ctx.cf.storage.get(this.config.key)
    if (value === undefined) return undefined
    if (typeof value !== 'string') {
      throw new TypeError(`settings-do: storage key "${this.config.key}" does not hold document text`)
    }
    return value
  }

  /** Publish any stored text the cache has not observed into the seam. */
  private async reconcileFromStorage(): Promise<void> {
    const text = await this.readText()
    if (text === this.text || this.closed) return
    if (text === undefined) {
      this.text = undefined
      this.publish({})
      return
    }
    const doc = this.parse(text)
    this.text = text
    this.publish(doc)
  }

  /** Parse one document text into raw sections, failing on a non-map root. */
  private parse(text: string): Record<string, unknown> {
    // `prettyErrors` is on only for `linePos`; `error.message` is never used,
    // because the parser quotes the offending source line and a settings
    // document can hold a secret value.
    const document = parseDocument(text, { prettyErrors: true })
    if (document.errors.length > 0) {
      throw new Error(`settings-do: invalid document at key "${this.config.key}": ${
        document.errors.map((error) => {
          const at = error.linePos?.[0]
          return `${error.code}${at === undefined ? '' : ` at line ${String(at.line)}, column ${String(at.col)}`}`
        }).join('; ')}`)
    }
    const root: unknown = document.toJS() ?? {}
    if (!isMapLike(root)) {
      throw new TypeError(`settings-do: document at key "${this.config.key}" must be a map of namespace sections`)
    }
    return root
  }

  /**
   * Render the next YAML text by patching one namespace in the
   * comment-preserving document as a leaf-level diff against the stored one.
   */
  private render(ns: SettingsNamespace, section: Record<string, unknown>): string {
    if (this.text === undefined) {
      return new Document({ [ns]: section }).toString()
    }
    // this.text only ever caches content that parsed successfully, so this
    // re-parse cannot fail, and parse() already rejected any non-map root.
    const document = parseDocument(this.text)
    const root: unknown = document.toJS()
    patchNode(document, [ns], isMapLike(root) ? root[ns] : undefined, section)
    return document.toString()
  }
}

export default DoSettingsProvider
