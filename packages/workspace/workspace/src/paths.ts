/**
 * Path canonicalization for workspace identity.
 * @module @deepseek-ai/dsh-workspace/src/paths
 */

import type { FileSystem } from '@deepseek-ai/dsh-fs'

/**
 * Canonicalize a directory path through the composed filesystem: trailing
 * slashes, `..` segments, and symlinks are all resolved in the filesystem's
 * own execution world (the host disk, or a remote container). This is the
 * ONE uniqueness canon of the package — workspace paths are stored
 * canonicalized, uniqueness is string equality of canonicalized paths (a
 * symlink to an existing workspace's directory collides), and attach-time
 * session `cwd` checks go through the same canon. A path that does not
 * exist or is not a directory rejects — this is `create`'s reject path (a
 * workspace must point at an existing directory).
 * @param fs - the composed filesystem.
 * @param path - The path to canonicalize.
 * @returns the canonical absolute path in the filesystem's execution world.
 */
export async function realpathDirectory(fs: FileSystem, path: string): Promise<string> {
  const target = await fs.resolve(path)
  const info = await fs.stat(target)
  if (info === undefined) {
    // Carries `code`, not just the message: callers distinguish a missing path
    // from a non-directory, and the node:fs errno this replaced carried one.
    throw Object.assign(
      new Error(`ENOENT: no such directory, '${path}'`),
      { code: 'ENOENT' },
    )
  }
  if (info.type !== 'directory') {
    throw Object.assign(
      new Error(`cannot use '${fs.processPath(target)}': path is not a directory`),
      { code: 'ENOTDIR' },
    )
  }
  return fs.processPath(target)
}
