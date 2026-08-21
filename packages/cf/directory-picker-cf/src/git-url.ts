/**
 * Recognition of git clone URLs typed into the directory browser's
 * "new folder" box, and the checkout directory name a clone produces.
 * @module @deepseek-ai/dsh-directory-picker-cf/src/git-url
 */

/** Remote forms git accepts that can be told apart from a plain directory name. */
const GIT_URL = /^(?:https?:\/\/|ssh:\/\/|git:\/\/|[A-Za-z0-9._-]+@[A-Za-z0-9.-]+:)[^\s]+$/

/**
 * Whether `name` is a git remote URL rather than a directory segment.
 * @param name - the "new folder" box value.
 * @returns true for `https://`, `ssh://`, `git://`, and scp-like `git@host:owner/repo(.git)` forms.
 */
export function isGitUrl(name: string): boolean {
  return GIT_URL.test(name)
}

/**
 * The directory `git clone <url>` creates: the last non-empty path segment with a `.git` suffix removed.
 * @param url - a value {@link isGitUrl} accepted.
 * @returns the checkout basename, or null when the URL carries no usable segment.
 */
export function cloneBasename(url: string): string | null {
  const segments = url.replace(/\/+$/, '').split(/[/:]/)
  const last = segments[segments.length - 1] ?? ''
  const base = last.replace(/\.git$/, '')
  return base === '' || base === '.' || base === '..' ? null : base
}
