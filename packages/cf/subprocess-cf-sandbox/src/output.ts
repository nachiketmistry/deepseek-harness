/** Bounded in-memory tail readers and exit mapping for container-supervised processes. */

import { Buffer } from 'node:buffer'
import type { ProcessExit } from '@deepseek-ai/dsh-cf-sandbox'
import type { SubprocessOutcome, SubprocessOutputRead, SubprocessOutputReader } from '@deepseek-ai/dsh-subprocess'

/**
 * Offset reader for one collect-mode stream. The container keeps the complete
 * log on its side and the SDK exposes no file for it, so a lossy read never
 * advertises a spill path.
 */
export class CfOutputReader implements SubprocessOutputReader {
  private chunks: Buffer[] = []
  private retainedBytes = 0
  private totalBytes = 0

  /**
   * Create a bounded tail reader.
   * @param maxBytes - In-memory cap; overflow drops the head.
   */
  constructor(private readonly maxBytes: number) {}

  /**
   * Append one log event's bytes.
   * @param bytes - Raw stream bytes as delivered by the SDK.
   */
  push(bytes: Uint8Array): void {
    if (bytes.length === 0) return
    const chunk = Buffer.from(bytes)
    this.totalBytes += chunk.length
    this.chunks.push(chunk)
    this.retainedBytes += chunk.length
    while (this.retainedBytes > this.maxBytes) {
      const head = this.chunks[0] as Buffer
      const excess = this.retainedBytes - this.maxBytes
      if (head.length <= excess) {
        this.chunks.shift()
        this.retainedBytes -= head.length
      } else {
        this.chunks[0] = head.subarray(excess)
        this.retainedBytes -= excess
      }
    }
  }

  /** @inheritdoc */
  readFrom(fromByte: number): SubprocessOutputRead {
    const retained = Buffer.concat(this.chunks, this.retainedBytes)
    const firstRetained = this.totalBytes - this.retainedBytes
    const lossy = fromByte < firstRetained
    const start = lossy ? 0 : Math.min(retained.length, Math.max(0, fromByte - firstRetained))
    return { text: retained.subarray(start).toString('utf8'), nextOffset: this.totalBytes, lossy }
  }
}

/** Linux signal numbers the container supervisor reports, by Node signal name. */
const LINUX_SIGNALS: ReadonlyMap<number, NodeJS.Signals> = new Map<number, NodeJS.Signals>([
  [1, 'SIGHUP'],
  [2, 'SIGINT'],
  [3, 'SIGQUIT'],
  [6, 'SIGABRT'],
  [9, 'SIGKILL'],
  [13, 'SIGPIPE'],
  [14, 'SIGALRM'],
  [15, 'SIGTERM'],
])

/** Numeric signals accepted by the SDK's `kill`. */
export const SIGNAL_NUMBERS = { SIGINT: 2, SIGKILL: 9, SIGTERM: 15, SIGHUP: 1, SIGTSTP: 20 } as const

/**
 * Project the SDK's exit facts onto the seam's outcome vocabulary. An
 * unrecognized signal number is reported shell-style as exit code `128 + n`.
 * @param exit - Exit facts of a settled supervised process group.
 * @returns exit code or terminating signal name.
 */
export function outcomeOf(exit: ProcessExit): SubprocessOutcome {
  if (exit.signal === undefined) return { exitCode: exit.code, signal: null }
  const name = LINUX_SIGNALS.get(exit.signal)
  return name === undefined ? { exitCode: 128 + exit.signal, signal: null } : { exitCode: null, signal: name }
}

/**
 * Resolve after one duration.
 * @param ms - Milliseconds to wait.
 * @returns Settles after the timeout.
 */
export function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/**
 * Normalize an unknown rejection into an Error.
 * @param error - Any thrown or rejected value.
 * @returns The value itself when already an Error, else a stringified wrapper.
 */
export function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error))
}

/**
 * Wait for a promise to settle or for a signal to abort, whichever comes first.
 * @param promise - Settlement to observe; its rejection counts as settlement.
 * @param signal - Optional bound for the wait.
 * @returns `true` when the promise settled, `false` when the signal aborted first.
 */
export function settledBefore(promise: Promise<unknown>, signal: AbortSignal | undefined): Promise<boolean> {
  const settled = promise.then(() => true, () => true)
  if (signal === undefined) return settled
  if (signal.aborted) return Promise.resolve(false)
  return new Promise<boolean>((resolve) => {
    const onAbort = (): void => { resolve(false) }
    signal.addEventListener('abort', onAbort, { once: true })
    void settled.then(() => {
      signal.removeEventListener('abort', onAbort)
      resolve(true)
    })
  })
}
