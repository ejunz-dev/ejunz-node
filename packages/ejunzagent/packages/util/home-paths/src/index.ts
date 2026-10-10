/**
 * Shared filesystem path helpers for EjunzAgent user data.
 *
 * @module @ejunz/home-paths
 */

import { opendir, realpath } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'

/** Directory name for the default EjunzAgent home under the OS home. */
export const EA_HOME_DIR_NAME = '.ea'

/** Stable user-facing display form for the default EjunzAgent home. */
export const DEFAULT_EA_HOME_DISPLAY = `~/${EA_HOME_DIR_NAME}`

/** Environment variable that overrides the default EjunzAgent home. */
export const EA_HOME_ENV = 'EA_HOME'

/**
 * Give a native filesystem watcher one canonical spelling of a path, even
 * when its final components do not exist yet. The deepest existing ancestor
 * is resolved through {@link realpath}; when a suffix is missing, that
 * ancestor is also proved to be an enumerable directory before the suffix is
 * restored. This prevents Windows from treating a regular-file ancestor as
 * ordinary absence, and prevents short-name aliases from being mixed with
 * long paths emitted by the native watcher backend.
 * @param path - Watch target or root, resolved against the current directory.
 * @returns the target with its existing ancestor canonicalized.
 * @throws when ancestor traversal encounters an error other than absence, or
 * the existing ancestor of a missing suffix is not an enumerable directory.
 */
export async function canonicalizeWatchPath(path: string): Promise<string> {
  let current = resolve(path)
  const missing: string[] = []
  while (true) {
    try {
      const canonical = await realpath(current)
      if (missing.length > 0) {
        // A Windows file-as-parent probe reports ENOENT. Opening the resolved
        // ancestor preserves the cross-platform directory requirement.
        const directory = await opendir(canonical)
        await directory.close()
      }
      return join(canonical, ...missing.reverse())
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      const parent = dirname(current)
      /* v8 ignore next -- a filesystem root exists, so traversal resolves before this guard */
      if (parent === current) throw error
      missing.push(basename(current))
      current = parent
    }
  }
}

/**
 * Resolve the default EjunzAgent home using Node's platform path rules.
 * @returns the absolute default ejunzAgent home path.
 */
export function defaultEaHome(): string {
  return join(homedir(), EA_HOME_DIR_NAME)
}

/**
 * Expand supported tilde prefixes against the operating-system home.
 * @param path - configured path that may begin with `~`, `~/`, or `~\`.
 * @returns the expanded path, or the original value when no supported prefix is present.
 */
export function expandHomePath(path: string): string {
  if (path === '~') return homedir()
  if (path.startsWith('~/') || path.startsWith('~\\')) return join(homedir(), path.slice(2))
  return path
}

/**
 * Resolve the single-root EjunzAgent home.
 *
 * Precedence, highest first: an explicit configured path, `$EA_HOME`, then
 * `~/.ea`. The ejunzAgent keeps all user data under one root. An empty or
 * whitespace-only `$EA_HOME` is treated as unset, so a blank override never
 * resolves the home to the current working directory.
 * @param configured - explicit ejunzAgent-home override, which has highest precedence.
 * @param env - environment mapping used to read `EA_HOME`.
 * @returns the normalized absolute ejunzAgent home path.
 */
export function resolveEaHome(configured?: string, env: Record<string, string | undefined> = process.env): string {
  const fromEnv = env[EA_HOME_ENV]
  const selected = configured ?? (fromEnv !== undefined && fromEnv.trim().length > 0 ? fromEnv : defaultEaHome())
  return resolve(expandHomePath(selected))
}

/**
 * Join path segments onto the resolved EjunzAgent home.
 * @param segments - path segments appended to the EjunzAgent home; an empty list returns the home itself.
 * @returns the normalized absolute joined path.
 */
export function eaHomePath(...segments: string[]): string {
  return join(resolveEaHome(), ...segments)
}

/**
 * Describe a resolved ejunzAgent home symbolically for user-facing display.
 *
 * It never returns an absolute machine path: the default home is labelled
 * `~/.ea`, and any configured home is labelled `$EA_HOME`.
 * @param resolvedHome - the absolute path returned by {@link resolveEaHome}.
 * @returns `~/.ea` for the default home, otherwise `$EA_HOME`.
 */
export function eaHomeDisplay(resolvedHome: string): string {
  return resolvedHome === resolve(defaultEaHome()) ? DEFAULT_EA_HOME_DISPLAY : `$${EA_HOME_ENV}`
}
