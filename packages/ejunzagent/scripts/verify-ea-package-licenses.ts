/**
 * Enforce the AGPL-3.0-only license declaration for repository-owned EA npm packages.
 * @module scripts/verify-ea-package-licenses
 */

import { globSync, readFileSync } from 'node:fs'
import { resolve, sep } from 'node:path'

const ROOT = resolve(import.meta.dirname, '..')
const EA_PACKAGE_NAME = /^@ejunz\/ea(?:-|$)/
const EA_PACKAGE_LICENSE = 'AGPL-3.0-only'

/** Result of checking every EA package reachable through the root workspace list. */
export interface EaPackageLicenseReport {
  /** Number of EA package manifests checked. */
  packageCount: number
  /** Repository-relative diagnostics for non-AGPL declarations. */
  failures: string[]
}

function readManifest(root: string, file: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(readFileSync(resolve(root, file), 'utf8'))
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`verify-ea-package-licenses: ${file} must contain a JSON object.`)
  }
  return parsed as Record<string, unknown>
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry: unknown) => typeof entry === 'string')
}

function workspaceManifestPaths(root: string): string[] {
  const rootManifest = readManifest(root, 'package.json')
  const workspaces = rootManifest.workspaces
  if (!isStringArray(workspaces)) {
    throw new Error('verify-ea-package-licenses: package.json workspaces must be a string array.')
  }

  const files = new Set(['package.json'])
  for (const pattern of workspaces) {
    for (const file of globSync(`${pattern}/package.json`, { cwd: root })) {
      files.add(file)
    }
  }
  return [...files].sort()
}

function printable(value: unknown): string {
  return value === undefined ? 'undefined' : JSON.stringify(value)
}

/**
 * Check every EA npm package declared by the repository workspace.
 * @param root - absolute repository root containing the workspace package.json.
 * @returns the checked package count and every non-AGPL declaration.
 */
export function inspectEaPackageLicenses(root: string): EaPackageLicenseReport {
  let packageCount = 0
  const failures: string[] = []

  for (const file of workspaceManifestPaths(root)) {
    const manifest = readManifest(root, file)
    const name = manifest.name
    if (typeof name !== 'string' || !EA_PACKAGE_NAME.test(name)) continue

    packageCount++
    if (manifest.license !== EA_PACKAGE_LICENSE) {
      const normalizedFile = file.split(sep).join('/')
      failures.push(
        `${normalizedFile}: ${name} must declare "license": ${JSON.stringify(EA_PACKAGE_LICENSE)}; found ${printable(manifest.license)}.`,
      )
    }
  }

  return { packageCount, failures }
}

if (process.argv[1] && import.meta.filename === resolve(process.argv[1])) {
  const report = inspectEaPackageLicenses(ROOT)
  if (report.failures.length > 0) {
    process.stderr.write('verify-ea-package-licenses: non-AGPL EA package declarations found:\n')
    for (const failure of report.failures) process.stderr.write(`  ${failure}\n`)
    process.exitCode = 1
  } else {
    process.stdout.write(
      `verify-ea-package-licenses: ${String(report.packageCount)} EA package(s) checked; all declare ${EA_PACKAGE_LICENSE}.\n`,
    )
  }
}
