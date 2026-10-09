import { existsSync } from 'node:fs'
import { readdir, readFile } from 'node:fs/promises'
import { dirname, join, relative, resolve, sep } from 'node:path'

const root = resolve(import.meta.dirname, '..')

async function vendoredPackages(): Promise<Map<string, string>> {
  const packages = new Map<string, string>()
  for (const entry of await readdir(join(root, 'vendor'), { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    try {
      const manifest = JSON.parse(await readFile(join(root, 'vendor', entry.name, 'package.json'), 'utf8')) as { name?: string }
      if (manifest.name !== undefined) packages.set(manifest.name, `vendor/${entry.name}`)
    } catch {
      continue
    }
  }
  return packages
}

const packages = await vendoredPackages()
if (packages.size === 0) throw new Error('verify-vendored-links: no vendored package manifests found under vendor/')

let lockRoot = root
while (!existsSync(join(lockRoot, 'yarn.lock'))) {
  const parent = dirname(lockRoot)
  if (parent === lockRoot) throw new Error(`verify-vendored-links: no yarn.lock found from ${root} upwards`)
  lockRoot = parent
}
const lockfile = await readFile(join(lockRoot, 'yarn.lock'), 'utf8')
const violations: string[] = []

for (const [name, workspacePath] of packages) {
  const lockWorkspacePath = relative(lockRoot, join(root, workspacePath)).split(sep).join('/')
  if (!lockfile.includes(`${name}@workspace:${lockWorkspacePath}`)) {
    violations.push(`${name} is not resolved from ${lockWorkspacePath}`)
  }
  if (lockfile.includes(`${name}@npm:`)) {
    violations.push(`${name} has a registry resolution in yarn.lock`)
  }
}

if (violations.length > 0) {
  console.error(`verify-vendored-links: ${String(violations.length)} invalid Yarn workspace resolution(s):`)
  for (const violation of violations) console.error(`  - ${violation}`)
  process.exit(1)
}

console.log(`verify-vendored-links: all ${String(packages.size)} vendored package names resolve to Yarn workspace links.`)
