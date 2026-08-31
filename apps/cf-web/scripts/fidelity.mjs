// Whether a mounted Cloudflare provider actually implements what it stands in
// for. The composition can only say a substitute is mounted; a provider that
// throws from every method, returns a constant where the Service Definition
// promises a value, or has no test at all is mounted and still not there.
//
// The scan is mechanical and reads the provider's own source: a method whose
// body is one unconditional `throw`, an empty body, or a single `return` of a
// literal is a reduced operation. Each finding must be declared on the
// disposition that names the substitute (composition.mjs), and each declaration
// must still have a finding — so neither an undeclared reduction nor a
// declaration the code has outgrown survives the parity gate.
//
// Test counts are reported, not enforced: `pnpm run test:coverage` is the gate
// that owns them, and it already rejects an untested `packages/*/*/src` file.
import ts from 'typescript'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

// Absent-value literals only. `true` is excluded deliberately: a capability
// getter answering `true` declares that the deployment HAS the capability,
// which is the shape a Service Definition asks for, not work left undone. A
// stub that returns `true` from real work is the accepted blind spot; every
// "nothing here" value is caught.
/** Return expressions treated as a constant stand-in for a real value. */
const CONSTANT_RETURNS = new Set(['[]', '{}', 'undefined', 'null', "''", '""', '``', 'false', '0'])

/**
 * Every `.ts` file under `dir`, recursively.
 * @param {string} dir Directory to walk; missing directories yield nothing.
 * @returns {string[]} Absolute file paths.
 */
function typescriptFiles(dir) {
  if (!existsSync(dir)) return []
  const out = []
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry)
    if (statSync(path).isDirectory()) out.push(...typescriptFiles(path))
    else if (path.endsWith('.ts') && !path.endsWith('.d.ts')) out.push(path)
  }
  return out
}

/**
 * Reduced operations and test-suite size of one provider package.
 * @param {string} dir The package directory.
 * @returns {{ tests: number, sourceLines: number, findings: { file: string, member: string, kind: 'throws' | 'empty' | 'constant', detail: string }[] }}
 *   `findings` is sorted by member name; `kind` is what the method body does instead of the work.
 */
export function scanProvider(dir) {
  const findings = []
  let sourceLines = 0
  for (const file of typescriptFiles(join(dir, 'src'))) {
    const text = readFileSync(file, 'utf8')
    sourceLines += text.split('\n').length
    const source = ts.createSourceFile(file, text, ts.ScriptTarget.ESNext, true)
    const visit = (node) => {
      if ((ts.isMethodDeclaration(node) || ts.isGetAccessor(node)) && node.body !== undefined) {
        const member = node.name.getText(source)
        const statements = node.body.statements
        if (statements.length === 0) findings.push({ file, member, kind: 'empty', detail: 'empty body' })
        else if (statements.length === 1) {
          const only = statements[0]
          if (ts.isThrowStatement(only)) {
            findings.push({ file, member, kind: 'throws', detail: only.expression.getText(source).replace(/\s+/g, ' ').slice(0, 120) })
          } else if (ts.isReturnStatement(only) && only.expression !== undefined) {
            const expression = only.expression.getText(source).trim()
            if (CONSTANT_RETURNS.has(expression)) findings.push({ file, member, kind: 'constant', detail: `returns ${expression}` })
          }
        }
      }
      ts.forEachChild(node, visit)
    }
    ts.forEachChild(source, visit)
  }
  const testDir = join(dir, 'tests')
  const tests = existsSync(testDir) ? readdirSync(testDir).filter(name => name.endsWith('.spec.ts') || name.endsWith('.spec.tsx')).length : 0
  return { tests, sourceLines, findings: findings.sort((a, b) => a.member.localeCompare(b.member)) }
}

/**
 * Cross-check one provider's scan against what its disposition declares.
 * @param {string} name Package name of the substitute, for the problem text.
 * @param {{ findings: { member: string, kind: string, detail: string }[] }} scan Result of `scanProvider`.
 * @param {{ member: string, cost: string }[]} declared The disposition's `reduced` list.
 * @returns {string[]} One problem line per undeclared finding or stale declaration; empty when they agree.
 */
export function reconcile(name, scan, declared) {
  const problems = []
  const declaredMembers = new Set(declared.map(entry => entry.member))
  for (const finding of scan.findings) {
    if (!declaredMembers.has(finding.member)) {
      problems.push(`\`${name}\` reduces \`${finding.member}\` (${finding.detail}) and its disposition does not declare it; add it to \`reduced\` with what the deployment loses, or implement the operation`)
    }
  }
  const found = new Set(scan.findings.map(finding => finding.member))
  for (const entry of declared) {
    if (!found.has(entry.member)) {
      problems.push(`\`${name}\` declares \`${entry.member}\` reduced, but its source no longer reduces it; drop the declaration`)
    }
  }
  return problems
}
