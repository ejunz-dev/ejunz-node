/**
 * Rescope the vendored Cordis packages into the `@ejunz` scope, and undo
 * that rescope with `--reverse`. Every ejunzAgent package declares `cordis` as a
 * peer dependency, so publication carries this framework layer too; publishing
 * it under the upstream names would squat them on the registry
 * ([rationale](../.agents/notes/implemented/process/2026-08-10-vendor-package-rescope.md),
 * [name mapping](../docs/rescope.md)).
 *
 * The generic pass rewrites ONLY delimited, complete package-name tokens:
 * `'old'` / `"old"` / `` `old` `` / `'old/subpath'`, plus a YAML `name: old`
 * scalar. A match needs a quote (or `name: `) immediately left and the matching
 * quote — optionally after a `/subpath` — immediately right, which excludes
 * `cordis.yml`, the Loader's `cordis:` builtin prefix, `cordis-config-entry`,
 * `@ejunz/tool-cordis`, and `cordiverse/cordis`, and makes the
 * rewrite idempotent because the scoped name's `cordis` is preceded by `/`.
 * Markdown follows the rename inside every fence, and in `docs/` prose too:
 * a tutorial that teaches an unresolvable name is wrong, while prose elsewhere
 * records what was true when it was written.
 *
 * Sites the token rule cannot express (dot-notation access, unquoted object
 * keys, regex literals, the vendored-manifest table) are listed in
 * {@link EXACT_EDITS} with an exact hit count, so an upstream change to one of
 * them fails loudly instead of being silently skipped.
 *
 * Usage: `yarn run rescope-vendor [--apply|--check] [--reverse]`. Without a
 * mode it reports what would change. `--check` asserts the post-state: no
 * residue, every exact edit landed, every postcondition holds, and a second
 * `--apply` would be a no-op.
 */

import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(import.meta.dirname, '..')

/** One vendored package's directory, upstream npm name, and rescoped name. */
interface Rename {
  readonly directory: string
  readonly upstream: string
  readonly scoped: string
}

/** The mapping this codemod applies; `vendor/README.md` carries the same table. */
const RENAMES: readonly Rename[] = [
  { directory: 'cordis', upstream: 'cordis', scoped: '@ejunz/cordis' },
  { directory: 'cosmokit', upstream: 'cosmokit', scoped: '@ejunz/cosmokit' },
  { directory: 'schemastery', upstream: 'schemastery', scoped: '@ejunz/schemastery' },
  { directory: 'loader', upstream: '@cordisjs/plugin-loader', scoped: '@ejunz/cordis-plugin-loader' },
  { directory: 'include', upstream: '@cordisjs/plugin-include', scoped: '@ejunz/cordis-plugin-include' },
  { directory: 'group', upstream: '@cordisjs/plugin-group', scoped: '@ejunz/cordis-plugin-group' },
  { directory: 'timer', upstream: '@cordisjs/plugin-timer', scoped: '@ejunz/cordis-plugin-timer' },
  { directory: 'hmr', upstream: '@cordisjs/plugin-hmr', scoped: '@ejunz/cordis-plugin-hmr' },
  { directory: 'logger-console', upstream: '@cordisjs/plugin-logger-console', scoped: '@ejunz/cordis-plugin-logger-console' },
]

const EXTENSIONS = ['.ts', '.tsx', '.js', '.mjs', '.cjs', '.tpl', '.json', '.yml', '.yaml', '.md'] as const

/** An exact-string edit the token rule cannot express, with its required hit count. */
interface ExactEdit {
  readonly id: string
  readonly file: string
  readonly find: string
  readonly replace: string
  readonly expect: number
}

/**
 * A file where an upstream name also appears as a vendor DIRECTORY name or an
 * upstream runtime identifier: the generic pass is disabled for the listed
 * names and {@link EXACT_EDITS} renames the real package-name occurrences.
 */
interface GenericSkip {
  readonly file: string
  readonly upstream: readonly string[]
}

const GENERIC_SKIPS: readonly GenericSkip[] = [
  // `Symbol.for('schemastery')` and the `vendor:` metadata field are upstream identifiers.
  { file: 'vendor/schemastery/src/index.ts', upstream: ['schemastery'] },
  // `cordis` is the stable preset id here, not a package name.
  // The preset's own composition: its header comment and its system prompt name
  // the preset a model mounts, so the scoped name would send the model after an
  // id no roster reports.
  { file: 'apps/cli/config/agent-presets/cordis/agent.cordis.yml', upstream: ['cordis'] },
  // GROUP_ORDER holds `packages/<group>/` directory names, not package names.
  { file: 'scripts/gen-module-graph.ts', upstream: ['cordis'] },
  { file: 'scripts/gen-doc-graphs.ts', upstream: ['cordis'] },
]

/** A string that must appear exactly `count` times once the rescope has run. */
interface PostCondition {
  readonly file: string
  readonly text: string
  readonly count: number
}

const POSTCONDITIONS: readonly PostCondition[] = [
  { file: 'vendor/cordis/package.json', text: '"name": "@ejunz/cordis"', count: 1 },
  { file: 'vendor/hmr/package.json', text: '"name": "@ejunz/cordis-plugin-hmr"', count: 1 },
  { file: 'scripts/cordis-walk.ts', text: '@ejunz\\/cordis', count: 1 },
  { file: 'scripts/cordis-walk.ts', text: '!== \'@ejunz/cordis\'', count: 1 },
  { file: 'scripts/gen-scoped-events.ts', text: '=== \'@ejunz/cordis\'', count: 1 },
  { file: 'packages/typert/generator/src/analyzer.ts', text: '!== \'@ejunz/cordis\'', count: 2 },
  { file: 'scripts/check-workspace-constraints.ts', text: '?.[\'@ejunz/cordis\']', count: 2 },
  { file: 'packages/boot/app-boot/tsdown.config.ts', text: '[\'@ejunz/cordis-plugin-include\']', count: 1 },
  { file: 'tsconfig.base.json', text: '"@ejunz/cordis-plugin-loader": ["./vendor/loader/src"]', count: 1 },
  // The vendored README owns this required entry; reject its deletion or duplication.
  { file: 'vendor/README.md', text: '17. **`@ejunz` rescope**', count: 1 },
  { file: 'knip.json', text: '@cordisjs', count: 0 },
  // The preset id the shipped composition documents to its own model.
  { file: 'apps/cli/config/agent-presets/cordis/agent.cordis.yml', text: 'The `cordis` agent preset', count: 1 },
  { file: 'apps/cli/config/agent-presets/cordis/agent.cordis.yml', text: 'corrupting the `cordis` preset', count: 1 },
]

/**
 * Every exact edit, in application order. Each `find` is written against the
 * PRE-rename text because these run before the generic pass, so no `find` may
 * quote a neighbouring line the generic pass would rewrite.
 */
const EXACT_EDITS: readonly ExactEdit[] = [
  {
    id: 'cordis-walk-merge-head',
    file: 'scripts/cordis-walk.ts',
    find: 'const MERGE_HEAD = /declare module [\'"](?:cordis|\\.\\/context\\.ts)[\'"]/',
    replace: 'const MERGE_HEAD = /declare module [\'"](?:@ejunz\\/cordis|\\.\\/context\\.ts)[\'"]/',
    expect: 1,
  },
  {
    id: 'constraints-manifest-lookup',
    file: 'scripts/check-workspace-constraints.ts',
    find: `    const peer = manifest.peerDependencies?.cordis
    const dev = manifest.devDependencies?.cordis

    if (!peer) errors.push(\`\${label}: cordis must be a peerDependency\`)
    if (!dev) errors.push(\`\${label}: cordis must also be a devDependency\`)
    if (peer && dev && peer !== dev) {
      errors.push(\`\${label}: cordis peer (\${peer}) and dev (\${dev}) ranges must match\`)`,
    replace: `    const peer = manifest.peerDependencies?.['@ejunz/cordis']
    const dev = manifest.devDependencies?.['@ejunz/cordis']

    if (!peer) errors.push(\`\${label}: @ejunz/cordis must be a peerDependency\`)
    if (!dev) errors.push(\`\${label}: @ejunz/cordis must also be a devDependency\`)
    if (peer && dev && peer !== dev) {
      errors.push(\`\${label}: @ejunz/cordis peer (\${peer}) and dev (\${dev}) ranges must match\`)`,
    expect: 1,
  },
  {
    // The rescoped name is already covered by the `@ejunz/.+` pattern beside it.
    id: 'knip-logger-console',
    file: 'knip.json',
    find: `      "ignoreDependencies": [
        "@cordisjs/plugin-logger-console",
        "@ejunz/.+"
      ]
    },
    "packages/util/home": {`,
    replace: `      "ignoreDependencies": [
        "@ejunz/.+"
      ]
    },
    "packages/util/home": {`,
    expect: 1,
  },
  {
    id: 'knip-bundle-base',
    file: 'knip.json',
    find: `    "packages/bundle/base": {
      "ignoreDependencies": [
        "@ejunz/.+",
        "@cordisjs/.+"
      ]`,
    replace: `    "packages/bundle/base": {
      "ignoreDependencies": [
        "@ejunz/.+"
      ]`,
    expect: 1,
  },
  {
    id: 'publication-set-scope-assertion',
    file: 'scripts/publish-npm-baseline.ts',
    find: '      if (!isVendored && !name.startsWith(\'@ejunz/\')) {',
    replace: `      // Vendored packages are rescoped too (vendor/README.md), so publication
      // never carries an upstream name that would squat it on the registry.
      if (!name.startsWith('@ejunz/')) {`,
    expect: 1,
  },
  {
    id: 'vendor-readme-preamble',
    file: 'vendor/README.md',
    find: 'All vendored packages keep their **original npm names** and are marked `private: true` — they are never published from this repo. `package.json#workspaces` makes matching upstream semver ranges resolve these pinned workspaces, including imports from built `lib/`; disabling it substitutes npm copies behind the same names.',
    replace: 'All vendored packages are **renamed into the `@ejunz` scope** (`cordis` → `@ejunz/cordis`, `@cordisjs/plugin-<x>` → `@ejunz/cordis-plugin-<x>`): every ejunzAgent package declares `cordis` as a peer dependency, so publishing the ejunzAgent publishes this framework layer too, and a publication under the upstream names would squat them on the registry. Directory names and upstream version numbers are deliberately unchanged, so the manifest below still reads as an upstream snapshot. `package.json#workspaces` makes those preserved semver ranges resolve these pinned workspaces, including imports from built `lib/`.',
    expect: 1,
  },
  {
    id: 'vendor-readme-schemastery-note',
    file: 'vendor/README.md',
    find: 'whose lazy `require(\'cosmokit\')` can race',
    replace: 'whose lazy `require(\'@ejunz/cosmokit\')` can race',
    expect: 1,
  },
  {
    id: 'vendor-readme-table-head',
    file: 'vendor/README.md',
    find: '| Directory | npm name | Version | Upstream repo | Commit |\n|---|---|---|---|---|',
    replace: '| Directory | npm name | Upstream name | Version | Upstream repo | Commit |\n|---|---|---|---|---|---|',
    expect: 1,
  },
  {
    // A plain fence listing the bundle's mounted tree: a bare token, no quotes.
    id: 'agent-spine-demo-mounted-tree',
    file: 'packages/examples/agent-spine-demo/README.md',
    find: '@cordisjs/plugin-timer            timer service',
    replace: '@ejunz/cordis-plugin-timer  timer service',
    expect: 1,
  },
  {
    // The client purity gate reads `@ejunz/` as "another plugin package".
    // The rescope moves the vendored framework and its libraries into that
    // namespace, where the gate would reject the library imports client
    // bundles have always inlined, so it needs their names.
    id: 'client-purity-vendored-libraries',
    file: 'packages/client/tsdown.client.ts',
    find: '/** Generated descriptor/codec contribution with no shared runtime identity. */',
    replace: `/**
 * Vendored framework libraries: rescoped into @ejunz, so the gate below
 * would read them as plugin packages. They carry no cross-plugin runtime
 * identity to share — the framework itself is a platform module (external),
 * while these are ordinary libraries a browser bundle inlines.
 */
const VENDORED_LIBRARY = /^@ejunz\\/(cosmokit|schemastery)(\\/|$)/

/** Generated descriptor/codec contribution with no shared runtime identity. */`,
    expect: 1,
  },
  {
    id: 'client-purity-vendored-libraries-predicate',
    file: 'packages/client/tsdown.client.ts',
    find: '        if (INLINE_SAFE.test(source) || GENERATED_REMOTE.test(source)) return null // wire contribution: inline is the point',
    replace: `        if (VENDORED_LIBRARY.test(source)) return null // vendored library: inline, no shared identity
        if (INLINE_SAFE.test(source) || GENERATED_REMOTE.test(source)) return null // wire contribution: inline is the point`,
    expect: 1,
  },
  // The manifest table's name column plus the new upstream-name column, one edit per row.
  ...RENAMES.map(rename => ({
    id: `vendor-readme-row-${rename.directory}`,
    file: 'vendor/README.md',
    find: `| \`${rename.directory}/\` | \`${rename.upstream}\` | `,
    replace: `| \`${rename.directory}/\` | \`${rename.scoped}\` | \`${rename.upstream}\` | `,
    expect: 1,
  })),
]

/** Files the rescope must never rewrite. */
function excluded(file: string): boolean {
  if (file === 'scripts/rescope-vendor.ts') return true // the mapping itself
  if (file.startsWith('.agents/notes/')) return true // notes record what was true when written
  // Recorded model payloads quote documentation verbatim, so they must mirror the
  // sources on disk — including the notes this rescope leaves alone.
  if (file.startsWith('scripts/snapshots/')) return true
  // The mapping documents state both names on purpose.
  if (file === 'docs/rescope.md' || file === 'docs/rescope.zh.md') return true
  if (file.endsWith('.i18n.yaml')) return true // blob-hash records, re-recorded by the pairing gate
  if (file === 'yarn.lock') return true // regenerated by yarn install
  if (/^vendor\/[^/]+\/(README\.md|LICENSE)$/.test(file)) return true // upstream files kept verbatim
  return !EXTENSIONS.some(extension => file.endsWith(extension))
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** One name's rewrite, precompiled for both delimited forms. */
interface Pattern {
  readonly upstream: string
  readonly from: string
  readonly to: string
  readonly token: RegExp
  readonly yamlName: RegExp
}

function patterns(reverse: boolean): Pattern[] {
  return RENAMES
    .map(rename => ({
      upstream: rename.upstream,
      from: reverse ? rename.scoped : rename.upstream,
      to: reverse ? rename.upstream : rename.scoped,
    }))
    .sort((left, right) => right.from.length - left.from.length)
    .map(rename => ({
      ...rename,
      token: new RegExp(`(['"\`])${escapeRegExp(rename.from)}((?:/[^'"\`\\s]*)?)\\1`, 'g'),
      yamlName: new RegExp(`^(\\s*(?:-\\s*)?name:[ \\t]+)${escapeRegExp(rename.from)}([ \\t]*(?:#.*)?)$`, 'gm'),
    }))
}

function skipped(file: string, pattern: Pattern): boolean {
  return GENERIC_SKIPS.some(skip => skip.file === file && skip.upstream.includes(pattern.upstream))
}

function rewriteLine(line: string, file: string, all: readonly Pattern[]): string {
  let out = line
  for (const pattern of all) {
    if (skipped(file, pattern)) continue
    out = out.replace(pattern.token, (_match, quote: string, subpath: string) => `${quote}${pattern.to}${subpath}${quote}`)
    out = out.replace(pattern.yamlName, (_match, prefix: string, suffix: string) => `${prefix}${pattern.to}${suffix}`)
  }
  return out
}

/**
 * Rewrite a file's eligible lines.
 *
 * Markdown splits in two. Every fence is code a reader copies or a
 * configuration they mount, so every fence follows the rename regardless of its
 * info string. Prose follows it only under `docs/`, where a sentence quoting
 * `` `cordis` `` teaches a name this repository no longer resolves; elsewhere
 * prose is a record of what was true when it was written, and the same spelling
 * can mean something else entirely — the Python SDK's `cordis` option, or the
 * unvendored `@cordisjs/plugin-http`.
 */
function rewrite(text: string, file: string, all: readonly Pattern[]): { text: string; lines: number } {
  const markdown = file.endsWith('.md')
  const prose = markdown && file.startsWith('docs/')
  let insideFence = false
  let lines = 0
  const out = text.split('\n').map((line) => {
    if (markdown) {
      if (/^\s*```/.test(line)) {
        insideFence = !insideFence
        return line
      }
      if (!insideFence && !prose) return line
    }
    const next = rewriteLine(line, file, all)
    if (next !== line) lines += 1
    return next
  })
  return { text: out.join('\n'), lines }
}

function classify(file: string): string {
  if (/^vendor\/[^/]+\/package\.json$/.test(file)) return 'vendor manifest name'
  if (file.endsWith('package.json')) return 'package.json dependencies'
  if (/\.(ts|tsx|js|mjs|cjs|tpl)$/.test(file)) return 'code specifiers'
  if (/\.(yml|yaml)$/.test(file)) return 'YAML plugin names'
  if (file.endsWith('.json')) return 'JSON configuration'
  return 'Markdown fences and docs prose'
}

/**
 * One exact edit's state in the text it targets. `pending` means the source
 * form is present and the target form absent; `applied` means the reverse;
 * anything else — a partial application, a moved site, or a DUPLICATED
 * insertion — is `invalid`, so it fails the run instead of being applied again.
 */
export type ExactEditState = 'pending' | 'applied' | 'invalid'

/**
 * Classify one exact edit against its target text.
 *
 * An insertion keeps its anchor (`replace` contains `find`) and a deletion
 * keeps its remainder (`find` contains `replace`), so neither can be judged by
 * the source form alone: the surviving side counts the target form instead.
 * @param text - the complete current text of the edited file.
 * @param find - the source form, already oriented for the running direction.
 * @param replace - the target form, already oriented for the running direction.
 * @param expect - how many occurrences one complete application produces.
 * @returns Whether the edit is pending, already applied, or invalid.
 */
export function exactEditState(text: string, find: string, replace: string, expect: number): ExactEditState {
  const hits = text.split(find).length - 1
  const landed = text.split(replace).length - 1
  if (replace.includes(find)) {
    if (landed === expect) return 'applied'
    return landed === 0 && hits === expect ? 'pending' : 'invalid'
  }
  if (find.includes(replace)) {
    if (hits === 0) return landed === expect ? 'applied' : 'invalid'
    return hits === expect ? 'pending' : 'invalid'
  }
  if (hits === 0 && landed === expect) return 'applied'
  return hits === expect && landed === 0 ? 'pending' : 'invalid'
}

function main(): void {
  const args = process.argv.slice(2)
  const mode = args.includes('--apply') ? 'apply' : args.includes('--check') ? 'check' : 'dry'
  const reverse = args.includes('--reverse')
  const all = patterns(reverse)
  const files = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' })
    .split('\0')
    .filter(file => file !== '' && !excluded(file))

  const counts = new Map<string, { files: number; lines: number }>()
  const failures: string[] = []
  const outstanding: string[] = []

  // Classify every exact edit before writing anything: a single invalid site
  // means the mapping and the tree disagree, and a half-applied tree is worse
  // than an untouched one.
  const planned: { edit: ExactEdit; path: string; find: string; replace: string }[] = []
  for (const edit of EXACT_EDITS) {
    const path = resolve(root, edit.file)
    const before = readFileSync(path, 'utf8')
    const find = reverse ? edit.replace : edit.find
    const replace = reverse ? edit.find : edit.replace
    const state = exactEditState(before, find, replace, edit.expect)
    if (state === 'invalid') {
      failures.push(`exact edit ${edit.id}: ${edit.file} is neither pending nor cleanly applied (duplicated, partial, or moved)`)
      continue
    }
    if (mode === 'check') {
      if (state !== 'applied') failures.push(`exact edit ${edit.id} did not land in ${edit.file}`)
      continue
    }
    if (state === 'pending') planned.push({ edit, path, find, replace })
  }
  if (failures.length > 0) {
    for (const failure of failures) console.error(`rescope-vendor: ${failure}`)
    console.error(`rescope-vendor: ${String(failures.length)} problem(s); nothing was written.`)
    process.exitCode = 1
    return
  }
  if (mode === 'apply') {
    // Re-read per edit: two edits can target one file, and a stale snapshot
    // would let the second write discard the first.
    for (const { path, find, replace } of planned) {
      writeFileSync(path, readFileSync(path, 'utf8').split(find).join(replace))
    }
  }

  for (const file of files) {
    const path = resolve(root, file)
    const before = readFileSync(path, 'utf8')
    const { text: after, lines } = rewrite(before, file, all)
    if (after === before) continue
    outstanding.push(file)
    const kind = classify(file)
    const current = counts.get(kind) ?? { files: 0, lines: 0 }
    counts.set(kind, { files: current.files + 1, lines: current.lines + lines })
    if (mode === 'apply') writeFileSync(path, after)
  }

  console.log(`rescope-vendor: ${mode}${reverse ? ' --reverse' : ''} over ${String(files.length)} tracked files`)
  for (const kind of [...counts.keys()].sort()) {
    const { files: count, lines } = counts.get(kind) ?? { files: 0, lines: 0 }
    console.log(`  ${kind.padEnd(24)} ${String(count).padStart(4)} file(s), ${String(lines)} line(s)`)
  }

  if (mode !== 'dry') {
    for (const check of POSTCONDITIONS) {
      if (reverse) break
      const path = resolve(root, check.file)
      const hits = existsSync(path) ? readFileSync(path, 'utf8').split(check.text).length - 1 : -1
      if (hits !== check.count) {
        failures.push(`postcondition: ${check.file} has ${String(hits)} occurrence(s) of ${JSON.stringify(check.text)}, expected ${String(check.count)}`)
      }
    }
    // The generic pass above already told us which files would still change,
    // which in check mode is exactly the residue-and-idempotency signal.
    if (mode === 'check') {
      for (const file of outstanding) failures.push(`residue: ${file} still carries a pre-rescope name token`)
    }
  }

  if (failures.length > 0) {
    for (const failure of failures) console.error(`rescope-vendor: ${failure}`)
    console.error(`rescope-vendor: ${String(failures.length)} problem(s); the mapping or an upstream site moved.`)
    process.exitCode = 1
  } else if (mode === 'check') {
    console.log('rescope-vendor: post-state verified — no residue, every exact edit landed, idempotent.')
  } else if (mode === 'apply') {
    console.log('rescope-vendor: applied. Run `yarn install` and re-record the touched bilingual pairs.')
  }
}

// Importing this module for its exported classifier must not run the codemod.
if (process.argv[1] !== undefined && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  main()
}
