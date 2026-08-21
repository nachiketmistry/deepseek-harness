/**
 * Passthrough provider for the process-confinement capability seam. The
 * surrounding container (the Cloudflare Sandbox SDK container, a microVM, or
 * any other whole-world isolation) is the isolation boundary, so `confine`
 * returns the caller's argv unchanged and reports `partial` enforcement: the
 * per-call file-effect policy (`read-only` versus `workspace-write`, the
 * workspace root) is NOT enforced inside the container. Consumers that require
 * an absolute per-call boundary must not treat this provider as `full`.
 * @module @deepseek-ai/dsh-sandbox-passthrough
 */

import { SandboxProvider } from '@deepseek-ai/dsh-sandbox'
import type { ConfinedArgv, SandboxPolicy } from '@deepseek-ai/dsh-sandbox'

/**
 * The `sandbox` service for container-isolated deployments. Enforced: nothing
 * beyond the container the process already runs in. Not enforced: the policy
 * mode, the workspace root, and the session identity; a `read-only` policy
 * still permits writes inside the container. No denial signatures or runner
 * failure rules exist because no runner wraps the command and no file effect
 * is ever denied by this provider.
 */
export class PassthroughSandboxProvider extends SandboxProvider {
  /**
   * Return `argv` unchanged under `partial` enforcement.
   * @param argv - the exact argv the caller is about to spawn.
   * @param policy - the per-call policy; accepted for every confined mode and
   *   not enforced, see the class contract.
   * @returns the same argv, `partial` enforcement, and empty evidence lists.
   */
  confine(argv: readonly string[], _policy: SandboxPolicy): ConfinedArgv {
    return {
      argv: [...argv],
      enforcement: 'partial',
      denialSignatures: [],
      runnerFailureRules: [],
    }
  }
}

export default PassthroughSandboxProvider
