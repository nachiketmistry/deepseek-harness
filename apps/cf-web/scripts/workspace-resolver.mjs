// esbuild plugin: resolve `@deepseek-ai/*` workspace packages to their built
// `lib/` through each package's `exports` map, exactly as a published consumer
// would. Workspace source is never bundled: the artifact plane is what deploys.
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Repository root (this file lives at apps/cf-web/scripts/). */
export const ROOT = resolve(fileURLToPath(new URL('../../..', import.meta.url)))

/** Node builtins importable without the `node:` prefix (bare form, as third-party CJS uses them). */
const BARE_BUILTINS = new Set([
  'assert', 'async_hooks', 'buffer', 'child_process', 'constants', 'crypto', 'diagnostics_channel', 'dns', 'events',
  'fs', 'fs/promises', 'http', 'http2', 'https', 'inspector', 'module', 'net', 'os', 'path', 'perf_hooks', 'process',
  'querystring', 'readline', 'sqlite', 'stream', 'stream/promises', 'stream/web', 'string_decoder', 'timers',
  'timers/promises', 'tls', 'tty', 'url', 'util', 'util/types', 'v8', 'vm', 'worker_threads', 'zlib',
])

export function readPackage(dir) {
  return JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
}

/**
 * Index every workspace package by name.
 * @returns {Map<string, string>} package name -> absolute package directory.
 */
export function workspacePackages() {
  const packages = new Map()
  const add = (dir) => {
    if (!existsSync(join(dir, 'package.json'))) return
    const pkg = readPackage(dir)
    if (typeof pkg.name === 'string') packages.set(pkg.name, dir)
  }
  for (const group of readdirSync(join(ROOT, 'packages'), { withFileTypes: true })) {
    if (!group.isDirectory()) continue
    for (const leaf of readdirSync(join(ROOT, 'packages', group.name), { withFileTypes: true })) {
      if (leaf.isDirectory()) add(join(ROOT, 'packages', group.name, leaf.name))
    }
  }
  for (const leaf of readdirSync(join(ROOT, 'vendor'), { withFileTypes: true })) {
    if (leaf.isDirectory()) add(join(ROOT, 'vendor', leaf.name))
  }
  for (const app of readdirSync(join(ROOT, 'apps'), { withFileTypes: true })) {
    if (app.isDirectory()) add(join(ROOT, 'apps', app.name))
  }
  return packages
}

/**
 * Resolve one subpath of a package through its `exports` map.
 * @param {string} dir - package directory.
 * @param {string} subpath - subpath without the leading `./` (`''` for the root).
 * @returns {string | undefined} absolute target path, or undefined when not exported.
 */
export function exportTarget(dir, subpath) {
  const pkg = readPackage(dir)
  const key = subpath === '' ? '.' : `./${subpath}`
  const exportsMap = pkg.exports ?? {}
  let entry = exportsMap[key]
  if (entry === undefined) {
    const wildcard = Object.keys(exportsMap).find(k => k.endsWith('/*') && key.startsWith(k.slice(0, -1)))
    if (wildcard !== undefined) entry = exportsMap[wildcard].replace('*', key.slice(wildcard.length - 1))
  }
  if (entry === undefined) {
    if (subpath === '') return join(dir, pkg.main ?? 'lib/index.js')
    if (subpath === 'package.json') return join(dir, 'package.json')
    return undefined
  }
  const pick = (value) => {
    if (typeof value === 'string') return value
    return pick(value.workerd ?? value.import ?? value.default ?? value.require)
  }
  return join(dir, pick(entry))
}

/**
 * @param {object} [options]
 * @param {(specifier: string, importer: string) => void} [options.onBuiltin] - observer for every Node builtin import.
 * @returns {import('esbuild').Plugin}
 */
export function workspaceResolver(options = {}) {
  const packages = workspacePackages()
  const builtin = (specifier, importer) => {
    options.onBuiltin?.(specifier, importer)
    return { path: specifier, external: true }
  }
  return {
    name: 'dsh-workspace-resolver',
    setup(build) {
      build.onResolve({ filter: /^@deepseek-ai\// }, (args) => {
        const match = /^(@deepseek-ai\/[^/]+)(?:\/(.*))?$/.exec(args.path)
        const dir = packages.get(match[1])
        if (dir === undefined) return undefined
        const target = exportTarget(dir, match[2] ?? '')
        if (target === undefined || !existsSync(target)) {
          return { errors: [{ text: `no built export for ${args.path} (expected ${target ?? 'an exports entry'}); run pnpm run build` }] }
        }
        return { path: target }
      })
      build.onResolve({ filter: /^(node:|cloudflare:)/ }, args => builtin(args.path, args.importer))
      build.onResolve({ filter: /^[^./]/ }, (args) => {
        if (!BARE_BUILTINS.has(args.path)) return undefined
        return builtin(`node:${args.path}`, args.importer)
      })
    },
  }
}

/** Shorten an absolute path for reports. */
export function relativeToRoot(path) {
  return path.replace(`${ROOT}/`, '').replace(/^.*\/node_modules\/(\.pnpm\/[^/]+\/node_modules\/)?/, 'node_modules/')
}
