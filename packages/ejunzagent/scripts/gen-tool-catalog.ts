/**
 * Generate `docs/tool-catalog.md` from schemas collected by booting each tool
 * plugin. Runtime registration is the source of truth for computed schemas;
 * the manifest is checked against every on-disk `tool-*` package. `--check`
 * verifies the committed artifact. Rationale and ownership live in
 * `.agents/notes/implemented/process/2026-07-02-tool-schema-catalog.md`.
 */

import { existsSync, globSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, resolve } from 'node:path'
import { Context } from '@ejunz/cordis'
import type { ToolSchema } from '@ejunz/llm'
import AgentRegistry from '@ejunz/agent'
import type { Agent } from '@ejunz/agent'
import { createScope } from '@ejunz/scope'
import SessionStore, { SessionId } from '@ejunz/session'
import SessionProjectionRegistry from '@ejunz/session-projection'
import SqliteSessionQueryEngine from '@ejunz/session-query-sqlite'
import GoalService from '@ejunz/goal'
import SystemPrompt from '@ejunz/system-prompt'
import ToolRuntime from '@ejunz/tools'
import UserQuestionService from '@ejunz/user-questions'
import PlanModeController from '@ejunz/plan-mode'
import WebRuntime from '@ejunz/web'
import * as WebSearchExa from '@ejunz/web-search-exa'
import * as WebFetchLocal from '@ejunz/web-fetch-http'
import SubagentRuntime from '@ejunz/subagent'
import type { SubagentProvider, SubagentReportDelivery } from '@ejunz/subagent'
import * as ToolSubagentControl from '@ejunz/tool-subagent-control'
import * as ToolSubagentListAgents from '@ejunz/tool-subagent-control/list-agents'
import * as ToolSubagentReport from '@ejunz/tool-subagent-report'
import SkillRegistry from '@ejunz/skill'
import * as SkillFileSystem from '@ejunz/skill-filesystem'
import LocalJobRegistry from '@ejunz/jobs-local'
import * as ToolAskUser from '@ejunz/tool-ask-user'
import CordisHostRunner from '@ejunz/cordis-host-runner'
import * as ToolCordis from '@ejunz/tool-cordis'
import * as ToolGoal from '@ejunz/tool-goal'
import * as ToolSchedule from '@ejunz/schedule'
import Lsp from '@ejunz/lsp'
import * as ToolLsp from '@ejunz/tool-lsp'
import * as ToolSkill from '@ejunz/tool-skill'
import * as ToolSessionQuery from '@ejunz/tool-session-query'
import * as ToolTasks from '@ejunz/tool-jobs'
import * as ToolTodo from '@ejunz/tool-todo'
import * as ToolHost from '../packages/ejunz/tool-host/src/index.ts'
import * as ToolSubagent from '@ejunz/tool-subagent'
import * as ToolWeb from '@ejunz/tool-web'
import VmWorkflowEngine from '@ejunz/workflow-worker-thread'
import * as ToolRalph from '@ejunz/tool-ralph'
import * as ToolWorkflow from '@ejunz/tool-workflow'
import { githubSlug } from './verify-md-links.ts'

const root = resolve(import.meta.dirname, '..')
const OUT = 'docs/tool-catalog.md'

/**
 * Register the descriptor needed to mount schema-producing consumers. Declares
 * the full capability set of the shipped in-process providers so consumers
 * mount under their shipped defaults (tool-subagent's default numeric maxDepth
 * requires `depthLimit`).
 */
function registerCatalogSubagentProvider(ctx: Context, name: string): void {
  const provider: SubagentProvider = {
    name,
    capabilities: { outputSchema: true, depthLimit: true, toolFilter: true, persona: true },
    inheritsParentContext: false,
    start: () => Promise.reject(new Error('tool-catalog provider cannot start a child')),
    // Declared so consumers configured for continuable background mode mount.
    prepareContinuable: () => Promise.reject(new Error('tool-catalog provider cannot prepare a child')),
  }
  ctx.subagents.registerProvider(provider)
}

/** Minted child-scope keys for packages whose tools are never global. */
const catalogChildScopes = new WeakMap<Context, Agent>()

/**
 * Install one scope-local tool package into an agent-like child scope for
 * schema harvest, without starting a model, Agent loop, or persistence backend.
 * @param ctx - catalog context owning the scope.
 * @param mountScoped - package installer for the scoped context.
 * @param key - agent-like scope key exposed to the package's scope selector.
 * @param inject - services the package installer must await before mounting.
 */
async function mountCatalogChildScope(
  ctx: Context,
  mountScoped: (childCtx: Context) => void,
  key: Agent = { id: SessionId('tool-catalog-child') } as Agent,
  inject: string[] = ['tools', 'systemPrompt', 'subagents'],
): Promise<void> {
  await ctx.plugin(Object.assign((inner: Context) => {
    mountScoped(createScope(inner, key).ctx)
  }, { inject }))
  catalogChildScopes.set(ctx, key)
}

/**
 * Tool package plus its hand-maintained boot recipe. The caller mounts the
 * prompt and registry; each recipe supplies only package-specific seams and
 * config, while `dir` participates in the completeness check.
 */
export interface ToolPackage {
  /** The npm package name, used as the catalog section heading. */
  pkg: string
  /** The `packages/<group>/<dir>` leaf name — matched by the completeness guard. */
  dir: string
  /**
   * Repo-relative implementation source linked per harvested tool. Packages
   * whose tools share one plugin may use a string; split plugins map each tool
   * name to its own source.
   */
  source: string | Readonly<Record<string, string>>
  /** Services or owning runtimes the package requires at execution time. */
  requires: string[]
  /** Session events or other visible state the tools write or affect. */
  writes: string[]
  /** Additional model-visible names shipped by example/app config. */
  shippedNames?: string[]
  /** Plug the injected seams + the tool plugin onto a context that already
   * carries `systemPrompt` + `tools`. */
  mount: (ctx: Context) => Promise<void>
  /** Agent-like scope key whose tool view is catalogued instead of the global view. */
  scope?: (ctx: Context) => Agent
  /**
   * Set when the package installs its tools per Agent session rather than at boot, so
   * a boot harvest finds none by design. The section then documents the seam and the
   * owner of the names instead of listing tools this package does not hold.
   */
  registersPerAgent?: boolean
  /**
   * A deployment note rendered after the package's tools, for a fact that
   * booting the package alone cannot show. The registered tool NAME can be a
   * load-time config (`tool-subagent`'s `toolName`), so one package may appear
   * under several names across deployments — the boot yields the package
   * DEFAULT, and this note records the shipped alternatives the model sees.
   */
  note?: string
}

/**
 * The boot manifest: every shipped tool package (a `tool-*` leaf under
 * `packages/`). Ordered by package name (the render order); the completeness
 * guard proves it is exhaustive against the on-disk glob.
 */
const TOOL_PACKAGES: ToolPackage[] = [
  {
    pkg: '@ejunz/tool-ask-user',
    dir: 'tool-ask-user',
    source: 'packages/interaction/tool-ask-user/src/index.ts',
    requires: ['ctx.tools', 'ctx.userQuestions'],
    writes: ['tool/call', 'tool/result after a UI/provider answers the question'],
    async mount(ctx) {
      await ctx.plugin(UserQuestionService)
      await ctx.plugin(ToolAskUser)
    },
    note:
      'ask_user_question pauses the tool call until the active UI provider returns a human answer.',
  },
  {
    pkg: '@ejunz/plan-mode',
    dir: 'plan-mode',
    source: 'packages/plan/plan-mode/src/index.ts',
    requires: ['ctx.tools', 'ctx.systemPrompt', 'ctx.userQuestions (execution time, opportunistic)'],
    writes: ['tool/call', 'plan/mode inactive on an approved review', 'tool/result'],
    async mount(ctx) {
      await ctx.plugin(PlanModeController, { section: 'Tool catalog schema harvest.' })
    },
    note:
      'exit_plan_mode stays in the model-facing schema while planning is inactive so transitions add no tool-catalog churn on top of the plan-policy change. Its execute path rejects calls outside plan mode; in plan mode it presents the plan over the user-questions seam (approve / keep planning with feedback), and approval logs plan mode inactive at the step boundary.',
  },


  {
    pkg: '@ejunz/tool-cordis',
    dir: 'tool-cordis',
    source: 'packages/extensions/tool-cordis/src/index.ts',
    requires: ['ctx.tools', 'ctx.dynamicCordisRunner'],
    writes: ['tool/call', 'tool/result', 'process-local dynamic package lifecycle'],
    async mount(ctx) {
      await ctx.plugin(CordisHostRunner)
      await ctx.plugin(ToolCordis)
    },
    note:
      'Not in any shipped tree (a deliberate opt-in — dynamic package code reaches the real runtime, see .agents/notes/implemented/feature/2026-07-08-self-referential-cordis-toolset.md). The toolset injects `ctx.dynamicCordisRunner` from `@ejunz/cordis-host-runner`, which owns the definition registry and the vm sandbox; a composition missing it never activates the tools. A running package may register ADDITIONAL model-visible tools until it is stopped, undefined, or EA restarts; a full changed request header logs those tool-set changes.',
  },





  {
    pkg: '@ejunz/tool-goal',
    dir: 'tool-goal',
    source: 'packages/goal/tool-goal/src/index.ts',
    requires: ['ctx.tools', 'ctx.agents', 'ctx.goals', 'ctx.systemPrompt', 'a calling Agent in an authorized open turn'],
    writes: ['tool/call', 'goal/change for mutations', 'tool/result'],
    async mount(ctx) {
      await ctx.plugin(AgentRegistry)
      await ctx.plugin(GoalService)
      await ctx.plugin(ToolGoal)
    },
    note:
      'create, edit, pause, and resume require direct-human root authority; complete and blocked also accept the exact current goal round. The default blocked lower bound is three admitted rounds.',
  },
  {
    pkg: '@ejunz/schedule',
    dir: 'schedule',
    source: 'packages/schedule/schedule/src/tools.ts',
    requires: ['ctx.tools', 'ctx.sessions', 'Session persistence', 'a future live root Agent'],
    writes: ['tool/call', 'schedule/change create or delete', 'tool/result'],
    async mount(ctx) {
      await ctx.plugin(SessionStore)
      const session = ctx.sessions.create(SessionId('tool-catalog-schedule'))
      const agent = { id: session.id, session } as Agent
      await mountCatalogChildScope(ctx, (childCtx) => {
        ToolSchedule.registerScheduleTools(ctx, childCtx, agent, () => {})
      }, agent, ['tools', 'systemPrompt'])
    },
    scope: ctx => catalogChildScopes.get(ctx) as Agent,
    note:
      'Registered only inside live root Agent scopes created after the opt-in Schedule plugin loads. '
      + 'Version 1 accepts after_seconds, explicit absolute at, and bounded fixed-rate every_seconds, '
      + 'and discloses session-local delivery; '
      + 'management reads and mutations require the shared Session persistence barrier.',
  },
  {
    pkg: '@ejunz/tool-lsp',
    dir: 'tool-lsp',
    source: 'packages/lsp/tool-lsp/src/index.ts',
    requires: ['ctx.tools', 'ctx.lsp', 'ctx.systemPrompt'],
    writes: ['tool/call', 'tool/result'],
    async mount(ctx) {
      // The tool registers from the seam alone; the schema does not depend on any provider.
      await ctx.plugin(Lsp)
      await ctx.plugin(ToolLsp)
    },
    note:
      'The lsp tool keeps provider selection and language-server subprocesses behind ctx.lsp, so its model-visible schema stays stable across providers. Requires a registered provider (e.g. `@ejunz/lsp-stdio`) at runtime; without one, a query returns the structured `LSP_UNAVAILABLE` error rather than changing the schema.',
  },
  {
    pkg: '@ejunz/tool-ralph',
    dir: 'tool-ralph',
    source: 'packages/workflow/tool-ralph/src/index.ts',
    requires: ['ctx.tools', 'ctx.workflowEngine', 'ctx.subagents', 'ctx.systemPrompt', 'a calling Agent (exec.agent parents every fresh round)'],
    writes: ['tool/call', 'tool/result', 'workflow and child session events during execution'],
    async mount(ctx) {
      await ctx.plugin(SubagentRuntime)
      registerCatalogSubagentProvider(ctx, 'mock')
      await ctx.plugin(VmWorkflowEngine, { provider: 'mock' })
      await ctx.plugin(ToolRalph, { subagentProvider: 'mock' })
    },
    note:
      'A fixed foreground workflow starts one fresh structured child per round; the model selects only the immutable objective and an optional round cap.',
  },
  {
    pkg: '@ejunz/tool-skill',
    dir: 'tool-skill',
    source: 'packages/skill/tool-skill/src/index.ts',
    requires: ['ctx.tools', 'ctx.agents', 'ctx.skills'],
    writes: ['tool/call', 'tool/result', 'user/message replacement catalogs via agent.inject()'],
    async mount(ctx) {
      await ctx.plugin(AgentRegistry)
      await ctx.plugin(SkillRegistry)
      await ctx.plugin(SkillFileSystem, {
        eaHome: resolve(root, '.tmp/tool-catalog/.ea'),
        agentsHome: resolve(root, '.tmp/tool-catalog/.agents'),
      })
      await ctx.plugin(ToolSkill)
    },
  },
  {
    pkg: '@ejunz/tool-session-query',
    dir: 'tool-session-query',
    source: 'packages/session-query/tool-session-query/src/index.ts',
    requires: ['ctx.tools', 'ctx.systemPrompt', 'ctx.sessionQuery', 'a calling Agent for workspace authority'],
    writes: ['tool/call', 'tool/result'],
    async mount(ctx) {
      await ctx.plugin(SessionStore)
      await ctx.plugin(SqliteSessionQueryEngine, { path: ':memory:' })
      await ctx.plugin(ToolSessionQuery)
    },
    note:
      'The five read-only tools hide provider cursors and authorize every result from the immutable calling agent session. The package is opt-in; compositions that need enforced deadlines or bounded inline output also mount the generic timeout or spill policies.',
  },
  {
    pkg: '@ejunz/tool-subagent',
    dir: 'tool-subagent',
    source: 'packages/subagent/tool-subagent/src/index.ts',
    requires: ['ctx.tools', 'ctx.subagents', 'ctx.systemPrompt'],
    writes: ['tool/call', 'tool/result', 'child session events through the chosen provider'],
    shippedNames: ['subagent', 'subagent_fork'],
    async mount(ctx) {
      await ctx.plugin(SubagentRuntime)
      registerCatalogSubagentProvider(ctx, 'mock')
      await ctx.plugin(ToolSubagent, { provider: 'mock' })
    },
    note:
      'The registered tool name is the load-time `toolName` config (default `subagent`); the schema above is that default. The shipped compositions load this package once per subagent backend, so the model additionally sees `subagent_fork` bound to the fork backend. Each instance\'s description, `run_in_background` parameter, and system-prompt policy follow its own `backgroundMode` and `enableRunInBackground`, so the two shipped schemas are not identical: `subagent` is `continuable` and defaults omitted calls to background with automatic settlement delivery, while `subagent_fork` stays `one-shot` and defaults them to foreground — see `packages/bundle/base/cordis.patch.yml` and `examples/acp-agent/cordis.yml`.',
  },
  {
    pkg: '@ejunz/tool-subagent-control',
    dir: 'tool-subagent-control',
    source: {
      interrupt_agent: 'packages/subagent/tool-subagent-control/src/index.ts',
      list_agents: 'packages/subagent/tool-subagent-control/src/list-agents.ts',
      send_message: 'packages/subagent/tool-subagent-control/src/index.ts',
    },
    requires: ['ctx.tools', 'ctx.subagents', 'ctx.agents and ctx.sessionProjections (list_agents only)'],
    writes: ['tool/call', 'tool/result', 'child session events through ctx.subagents'],
    async mount(ctx) {
      await ctx.plugin(SubagentRuntime)
      await ctx.plugin(LocalJobRegistry)
      await ctx.plugin(AgentRegistry)
      await ctx.plugin(SessionStore)
      await ctx.plugin(SessionProjectionRegistry)
      await ctx.plugin(ToolSubagentControl)
      await ctx.plugin(ToolSubagentListAgents)
    },
    note:
      'The globally named control tools over continuable background subagents: provider-bound `tool-subagent` instances register distinct delegation tools, while this package registers `send_message` and `interrupt_agent` once, plus `list_agents` from its separately loaded `/list-agents` plugin (whose catalog rows use the sessionProjections and live Agent registries).',
  },
  {
    pkg: '@ejunz/tool-subagent-report',
    dir: 'tool-subagent-report',
    source: 'packages/subagent/tool-subagent-report/src/index.ts',
    requires: ['ctx.subagents', 'ctx.systemPrompt', 'a live continuable in-process child Agent'],
    writes: ['tool/call', 'tool/result', 'a user-role message in the direct parent session'],
    async mount(ctx) {
      await ctx.plugin(AgentRegistry)
      await ctx.plugin(SubagentRuntime)
      const { reportDelivery } = ToolSubagentReport.Config({}) as { reportDelivery: SubagentReportDelivery }
      await mountCatalogChildScope(ctx, (childCtx) => {
        ToolSubagentReport.installReportTool(childCtx, ctx, reportDelivery)
      })
    },
    scope: ctx => catalogChildScopes.get(ctx) as Agent,
    note:
      'Registered per continuable in-process child rather than globally, so this schema is visible only '
      + 'inside such a child and survives its global `toolFilter`. The same contribution installs the '
      + 'child-scoped `tool:report` prompt section, which this catalog does not render. The parent-facing '
      + '`send_message` tool is installed independently.',
  },
  {
    pkg: '@ejunz/tool-jobs',
    dir: 'tool-jobs',
    source: 'packages/jobs/tool-jobs/src/index.ts',
    requires: ['ctx.tools', 'ctx.jobs', 'ctx.systemPrompt'],
    writes: ['tool/call', 'tool/result', 'user/message via agent.inject() for background completion notices'],
    async mount(ctx) {
      await ctx.plugin(LocalJobRegistry)
      await ctx.plugin(ToolTasks)
    },
    note:
      'The kind-agnostic background-job controller: background processes and subagent runs are read, listed, and killed through the same three tools. Loading the plugin attaches the controller that arms producers\' `ctx.jobs.start()`.',
  },
  {
    pkg: '@ejunz/tool-todo',
    dir: 'tool-todo',
    source: 'packages/todo/tool-todo/src/index.ts',
    requires: ['ctx.tools', 'owning Agent session'],
    writes: ['tool/call', 'todo/write', 'tool/result'],
    async mount(ctx) {
      await ctx.plugin(ToolTodo, { allowParallelInProgress: true })
    },
    note:
      'todo_write is session-owned state; UIs render the latest todo/write event as a checklist. `allowParallelInProgress` is required with no default, so the catalog states its choice: `true`, whose description invites several `in_progress` items. A deployment choosing `false` receives the same tool with a description asking for exactly one active task.',
  },
  {
    pkg: '@ejunz/tool-host',
    dir: 'tool-host',
    source: 'packages/ejunz/tool-host/src/index.ts',
    requires: ['ctx.tools', 'ctx.systemPrompt', 'ctx.hostProvider / ctx.provider'],
    writes: ['tool/call', 'tool/result'],
    // The set is installed per Agent, so a boot harvest finds nothing: the Agent
    // factory calls the published installer while composing one Agent, and every
    // name comes from the host's registry.
    registersPerAgent: true,
    async mount(ctx) {
      // The tool set is deployment-supplied, so the harvest declares none: addons
      // register their tools in the Ejunz tool registry and the install registers
      // whatever the attached client declares for one Agent.
      ctx.provide('hostProvider', {
        catalog: async () => ({ tools: [] }),
        call: async () => { throw new Error('gen-tool-catalog: a host tool call is unreachable during schema harvest') },
      })
      await ctx.plugin(ToolHost)
    },
    note:
      'Installs the tool set the deployment\'s host declares, into each Agent as that Agent is composed. '
      + 'No declaration lives here or in the host bridge: an addon registers its tools — names, descriptions, and JSON Schemas — through the Ejunz tool registry (`packages/ejunztools/src/catalog.ts` and `packages/ejunztools/src/registry.ts`), which owns them, so this section lists no tool. '
      + 'That registry holds the tools that act on one Agent session (`base_context`, `base_select`) alongside the Base operations, and the session reaches them as `ToolContext.sessionId`. '
      + 'A host serves its catalog per domain, so the set a model receives is the set its own session\'s domain publishes, and the session id is what lets the host resolve that domain. '
      + 'The package exposes a client seam without selecting a transport; a deployment that attaches no authorized client installs nothing.',
  },
  {
    pkg: '@ejunz/tool-workflow',
    dir: 'tool-workflow',
    source: 'packages/workflow/tool-workflow/src/index.ts',
    requires: ['ctx.tools', 'ctx.workflowEngine', 'ctx.systemPrompt', 'a calling Agent (exec.agent parents the script children)'],
    writes: ['tool/call', 'tool/result'],
    async mount(ctx) {
      // The tool injects `workflows`; boot the vm engine over a scripted
      // subagent provider to satisfy it. The schema does not depend on which
      // provider backs the engine.
      await ctx.plugin(SubagentRuntime)
      registerCatalogSubagentProvider(ctx, 'mock')
      await ctx.plugin(VmWorkflowEngine, { provider: 'mock' })
      await ctx.plugin(ToolWorkflow)
    },
  },
  {
    pkg: '@ejunz/tool-web',
    dir: 'tool-web',
    source: 'packages/web/tool-web/src/index.ts',
    requires: ['ctx.tools', 'ctx.web', 'ctx.systemPrompt'],
    writes: ['tool/call', 'tool/result'],
    async mount(ctx) {
      // Mount search and fetch providers so both tools register. Their schemas
      // do not depend on provider identity or availability.
      await ctx.plugin(WebRuntime)
      await ctx.plugin(WebSearchExa)
      await ctx.plugin(WebFetchLocal)
      await ctx.plugin(ToolWeb)
    },
    note:
      'web_search and web_fetch keep provider selection behind ctx.web so model-visible schemas stay stable across backend swaps.',
  },
]

/** One package's contribution to the catalog: its schemas plus attribution. */
interface CatalogPackage {
  pkg: string
  sources: Readonly<Record<string, string>>
  requires: string[]
  writes: string[]
  shippedNames?: string[]
  schemas: ToolSchema[]
  /** A deployment note (see {@link ToolPackage.note}), rendered after the tools. */
  note?: string
}

/** The whole catalog: one entry per booted tool package, in manifest order. */
export type ToolCatalog = CatalogPackage[]

/**
 * Assert the boot manifest covers every shipped tool package on disk (a
 * `tool-*` leaf under `packages/`).
 * Booting has no source declaration to enumerate, so this glob restores the
 * "a new tool cannot be silently undocumented" guarantee: an unlisted package
 * fails the generator (and the freshness gate) until it is added to
 * {@link TOOL_PACKAGES}. Exported for a direct negative test.
 *
 * `scanRoot` defaults to the repo root; a test may point it at a fixture tree.
 */
export function assertManifestComplete(packages: ToolPackage[] = TOOL_PACKAGES, scanRoot: string = root): void {
  const onDisk = globSync('packages/*/tool-*', { cwd: scanRoot }).map(p => basename(p)).sort()
  const listed = new Set(packages.map(p => p.dir))
  const missing = onDisk.filter(dir => !listed.has(dir))
  if (missing.length > 0) {
    throw new Error(
      `gen-tool-catalog: ${missing.length} tool package(s) not in the boot manifest: ${missing.join(', ')}. `
      + 'Add each to TOOL_PACKAGES in scripts/gen-tool-catalog.ts so its schema is catalogued.',
    )
  }
}

/**
 * Assert one manifest entry actually registered a tool.
 *
 * A tool package that boots without registering anything is a broken boot, not
 * an empty catalog section. The usual cause is an `inject` the entry's `mount`
 * does not satisfy: cordis leaves the plugin PENDING, every step here still
 * succeeds, and the generator writes a catalog missing that package's tools —
 * with the freshness gate green on it, because the omission is now what the
 * generator produces. {@link assertManifestComplete} cannot see this: the
 * package IS listed, it just contributed nothing.
 * @param entry - the manifest entry that was booted.
 * @param harvested - how many schemas its boot registered.
 * @throws when the boot registered no tool at all.
 */
export function assertToolsHarvested(entry: ToolPackage, harvested: number): void {
  if (harvested > 0) return
  throw new Error(
    `gen-tool-catalog: ${entry.pkg} booted without registering a single tool. `
    + 'Its plugin is most likely PENDING on a service this manifest entry does not mount — '
    + `compare the plugin's inject with mount() and requires: ${entry.requires.join(', ')}.`,
  )
}

/**
 * Boot each tool package on a fresh Context and harvest its model-facing
 * schemas. A fresh Context per package keeps attribution clean (each entry's
 * schemas come from exactly that package) and isolates a boot failure to its
 * own entry. Disposed after harvest so no executor/provider outlives the run.
 */
export async function collectToolCatalog(packages: ToolPackage[] = TOOL_PACKAGES): Promise<ToolCatalog> {
  assertManifestComplete(packages)
  const catalog: ToolCatalog = []
  for (const entry of packages) {
    const ctx = new Context()
    // Dispose in `finally` so a throw from `mount`/`schemas()` after earlier
    // plugins mounted still tears the context down (no leaked executor/provider
    // fiber) — the repo's "dispose must reach quiescence" rule.
    try {
      await ctx.plugin(SystemPrompt)
      await ctx.plugin(ToolRuntime)
      await entry.mount(ctx)
      const schemas = ctx.tools.schemas(entry.scope?.(ctx)).sort((a, b) => a.name.localeCompare(b.name))
      if (entry.registersPerAgent !== true) assertToolsHarvested(entry, schemas.length)
      catalog.push({
        pkg: entry.pkg,
        sources: Object.fromEntries(schemas.map(schema => [
          schema.name,
          toolSource(entry, schema.name),
        ])),
        requires: entry.requires,
        writes: entry.writes,
        schemas,
        ...entry.shippedNames !== undefined ? { shippedNames: entry.shippedNames } : {},
        ...entry.note !== undefined ? { note: entry.note } : {},
      })
    } finally {
      await ctx.fiber.dispose()
    }
  }
  return catalog
}

/** Resolve one harvested tool to the plugin source that registered it. */
function toolSource(entry: ToolPackage, toolName: string): string {
  if (typeof entry.source === 'string') return entry.source
  const source = entry.source[toolName]
  if (source === undefined) {
    throw new Error(
      `gen-tool-catalog: ${entry.pkg} has no source mapping for harvested tool ${toolName}`,
    )
  }
  return source
}

/** Render one tool's entry: name, description, JSON-Schema parameters, source. */
function renderTool(schema: ToolSchema, source: string): string[] {
  const out = [`### \`${schema.name}\``, '']
  if (schema.description) out.push(schema.description, '')
  out.push('```json', JSON.stringify(schema.parameters, null, 2), '```', '')
  out.push(`Source: [\`${source}\`](../${source})`, '')
  return out
}

function codeList(values: string[] | undefined): string {
  return values?.length ? values.map(value => `\`${value}\``).join(', ') : '-'
}

function tableCell(value: string | undefined): string {
  return value ? value.replace(/\|/g, '\\|').replace(/\n/g, '<br>') : '-'
}

/** Render the full catalog (pure, deterministic given the manifest-ordered input). */
export function render(catalog: ToolCatalog): string {
  const lines: string[] = [
    '<!-- Generated by scripts/gen-tool-catalog.ts — do not edit by hand.',
    '     Run `yarn run gen-tool-catalog` to regenerate. -->',
    '',
    '# Tool Schema Catalog',
    '',
    'Every model-facing tool a shipped plugin contributes to `ctx.tools`: the `name`, `description`, and JSON-Schema `parameters` the model receives via the system-prompt assembly. It complements the [subsystem pages](subsystems/core.md) (the types plus each page\'s generated Cordis API region) — this page is the *tools* the agent is offered.',
    '',
    'This file is GENERATED and verified fresh by `yarn run verify-tool-catalog` (part of `doc-sync`) — do not edit it by hand. Unlike the cordis catalog (a pure source-AST pass), this generator BOOTS each tool plugin on a real context and reads `ctx.tools.schemas()`, because a tool schema is not statically knowable (runtime-spread enums, concatenated descriptions, config-driven names, raw-JSON-Schema MCP tools). A completeness guard globs `packages/*/tool-*` and fails if any package is missing from the generator\'s boot manifest, so a new tool cannot be silently undocumented. See [the tool-schema-catalog Agent Note](../.agents/notes/implemented/process/2026-07-02-tool-schema-catalog.md).',
    '',
    'Scope: shipped product tools under `packages/*/tool-*`, each booted with its DEFAULT config, except where a Config field is REQUIRED with no default — there the generator must choose, and the per-package note records which branch this page shows. The registered tool NAME can be a load-time config (e.g. `tool-subagent`\'s `toolName`), so a deployment may expose a package under a different or additional name — a per-package note records those shipped aliases where they exist. The `examples/` demo tools (e.g. `echo`) are excluded, matching the cordis catalog\'s packages-only scope.',
    '',
    '## Tool Package Map',
    '',
    'This table connects model-visible tool names to the plugin package and service seams behind them. Exact JSON Schemas follow in the package sections below.',
    '',
    '| Tool package | Model-visible names | Requires | Writes / affects | Shipped aliases | Deployment note |',
    '| --- | --- | --- | --- | --- | --- |',
    ...catalog.map(entry => `| \`${entry.pkg}\` | ${codeList(entry.schemas.map(schema => schema.name))} | ${codeList(entry.requires)} | ${codeList(entry.writes)} | ${codeList(entry.shippedNames)} | ${tableCell(entry.note)} |`),
    '',
  ]
  for (const entry of catalog) {
    lines.push(`<a id="${githubSlug(entry.pkg)}"></a>`, '', `## \`${entry.pkg}\``, '')
    for (const schema of entry.schemas) {
      // Collection validated that every harvested schema has a source.
      const source = entry.sources[schema.name] as string
      lines.push(...renderTool(schema, source))
    }
    if (entry.note) lines.push(entry.note, '')
  }
  return lines.join('\n')
}

/** CLI entry: default writes the catalog, `--check` fails if the committed copy
 * is stale. Guarded behind an entry-point check so importing this module for
 * tests neither regenerates the committed file nor calls process.exit. */
async function main(): Promise<void> {
  if (!existsSync(resolve(root, 'docs'))) {
    console.log('gen-tool-catalog: docs/ is not included in this checkout; skipping documentation output.')
    return
  }
  const content = render(await collectToolCatalog())
  if (process.argv.includes('--check')) {
    let committed: string | null = null
    try {
      committed = readFileSync(resolve(root, OUT), 'utf8')
    } catch {
      // Only ENOENT (not yet generated) is expected; a present-but-unreadable
      // file is not a state this repo produces. Either way the remedy is the
      // same — regenerate — so treat a read failure as "stale".
      committed = null
    }
    if (committed === content) {
      console.log(`gen-tool-catalog: ${OUT} is up to date.`)
      process.exit(0)
    }
    console.error(`gen-tool-catalog: ${OUT} is stale. Run \`yarn run gen-tool-catalog\` and commit ${OUT}.`)
    const committedLines = committed?.split('\n') ?? []
    const generatedLines = content.split('\n')
    const lineCount = Math.max(committedLines.length, generatedLines.length)
    for (let index = 0; index < lineCount; index += 1) {
      if (committedLines[index] === generatedLines[index]) continue
      console.error(`gen-tool-catalog: first difference at line ${index + 1}`)
      console.error(`  committed: ${JSON.stringify(committedLines[index])}`)
      console.error(`  generated: ${JSON.stringify(generatedLines[index])}`)
      break
    }
    process.exit(1)
  }

  writeFileSync(resolve(root, OUT), content)
  console.log(`gen-tool-catalog: wrote ${OUT}.`)
}

// Run only when invoked as a script, not when imported by a test.
if (process.argv[1] && import.meta.filename === resolve(process.argv[1])) {
  await main()
}
