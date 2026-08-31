/**
 * Gate 0 runtime half: evaluate every CF-target package row in isolation under
 * workerd (nodejs_compat) and table which top-level module evaluations throw.
 * A failure here is a module-load fact, not a mount fact; it names the
 * packages whose Node surface must move behind a seam before the CF
 * composition can import them.
 */
import { expect, it } from 'vitest'

it('evaluates every CF-target package module under workerd', async () => {
  const { probes } = await import('../../dist/probe/index.js')
  const failures: string[] = []
  const passed: string[] = []
  for (const [name, load] of Object.entries(probes)) {
    try {
      await load()
      passed.push(name)
    } catch (error) {
      failures.push(`${name}: ${error instanceof Error ? error.message.split('\n')[0] : String(error)}`)
    }
  }
  console.log(`gate0-eval: ${passed.length} evaluated, ${failures.length} failed\n${failures.join('\n')}`)
  expect(failures).toEqual([])
})
