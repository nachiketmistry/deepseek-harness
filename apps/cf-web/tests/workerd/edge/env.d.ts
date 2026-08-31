/**
 * What the edge acceptance run's Worker offers the tests: the bindings
 * `wrangler.edge-test.jsonc` declares plus the tokens
 * `tests/workerd/identity.setup.ts` provides as vars, and the entry's own
 * exports, which `cloudflare:workers` reaches the Worker and its objects
 * through.
 */

import type { IdentityFixture } from '../identity.setup.ts'
import type { EdgeEnv } from '../../../src/edge.ts'

declare global {
  namespace Cloudflare {
    interface Env extends EdgeEnv, IdentityFixture {
      HOST: DurableObjectNamespace
    }
    interface GlobalProps {
      mainModule: typeof import('./entry.ts')
      durableNamespaces: 'HostObject'
    }
  }
}
