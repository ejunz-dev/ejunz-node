import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'

interface PackageManifest {
  name?: string
  main?: string
  bin?: string | Record<string, string>
  exports?: Record<string, string | { default?: string; types?: string } | null>
  dependencies?: Record<string, string>
  optionalDependencies?: Record<string, string>
  peerDependencies?: Record<string, string>
}

const root = process.cwd()
const directories = new Map<string, string>()

function collectPackages(directory: string, depth: number): void {
  if (depth === 0 || !existsSync(directory)) return
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name === 'node_modules' || entry.name === 'lib') continue
    const child = join(directory, entry.name)
    const manifestPath = join(child, 'package.json')
    if (existsSync(manifestPath)) {
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as PackageManifest
      if (typeof manifest.name === 'string') directories.set(manifest.name, child)
    } else {
      collectPackages(child, depth - 1)
    }
  }
}

for (const [base, depth] of [['packages', 3], ['apps', 2], ['vendor', 2], ['native', 4]] as const) {
  collectPackages(join(root, base), depth)
}

function runtimeTargets(manifest: PackageManifest): string[] {
  const targets = new Set<string>()
  const add = (value: unknown): void => {
    if (typeof value === 'string' && value.startsWith('./lib/') && !value.includes('*')) targets.add(value.slice(2))
  }
  add(manifest.main)
  if (typeof manifest.bin === 'string') add(manifest.bin)
  else if (manifest.bin !== undefined) Object.values(manifest.bin).forEach(add)
  for (const value of Object.values(manifest.exports ?? {})) {
    if (typeof value === 'string') add(value)
    else if (value !== null && value !== undefined) add(value.default)
  }
  return [...targets]
}

function copyRuntimeTree(source: string, destination: string): number {
  if (!existsSync(source)) return 0
  let copied = 0
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    const from = join(source, entry.name)
    const to = join(destination, entry.name)
    if (entry.isDirectory()) {
      copied += copyRuntimeTree(from, to)
      continue
    }
    if (!entry.isFile() || !entry.name.endsWith('.js') || existsSync(to)) continue
    mkdirSync(dirname(to), { recursive: true })
    copyFileSync(from, to)
    copied += 1
  }
  return copied
}

const cliManifest = JSON.parse(readFileSync(join(root, 'apps/cli/package.json'), 'utf8')) as PackageManifest
const queue = [
  ...Object.keys(cliManifest.dependencies ?? {}),
  ...Object.keys(cliManifest.optionalDependencies ?? {}),
  ...Object.keys(cliManifest.peerDependencies ?? {}),
]
const visited = new Set<string>()
let copied = 0

while (queue.length > 0) {
  const name = queue.pop()
  if (name === undefined || visited.has(name)) continue
  visited.add(name)
  const directory = directories.get(name)
  if (directory === undefined) continue
  const manifest = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8')) as PackageManifest
  const targets = runtimeTargets(manifest)
  const missing = targets.filter(target => !existsSync(join(directory, target)))
  if (missing.length > 0) {
    copied += copyRuntimeTree(join(directory, 'lib/types'), join(directory, 'lib'))
    const stillMissing = missing.filter(target => !existsSync(join(directory, target)))
    if (stillMissing.length > 0) {
      throw new Error(`${name}: no TypeScript runtime output for ${stillMissing.join(', ')}`)
    }
  }
  queue.push(
    ...Object.keys(manifest.dependencies ?? {}),
    ...Object.keys(manifest.optionalDependencies ?? {}),
    ...Object.keys(manifest.peerDependencies ?? {}),
  )
}

console.log(`desktop runtime: checked ${String(visited.size)} workspace dependencies; materialized ${String(copied)} JavaScript entry/helper files`)
