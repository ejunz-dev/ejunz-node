/**
 * Default executor-less, UI-less agent spine. It bundles the common services,
 * background-job registry and controls, optional persisted goals, concrete loop, local skill and
 * agent-instructions providers, and model-facing skill/job consumers;
 * deployments still choose the LLM adapter and entry-point-specific services.
 * The plugin intentionally exposes named exports only because Loader default
 * unwrapping would discard its `Config` schema (see docs/postmortem/0001).
 * @module @ejunz/agent-spine-demo
 */

import type { Context } from '@ejunz/cordis'
import Timer from '@ejunz/cordis-plugin-timer'
import z from '@ejunz/schemastery'
import LlmRuntime from '@ejunz/llm'
import SessionStore from '@ejunz/session'
import SessionTitleService, { type Config as SessionTitleConfig } from '@ejunz/session-title'
import SystemPrompt, { type Config as SystemPromptConfig } from '@ejunz/system-prompt'
import ToolRuntime from '@ejunz/tools'
import SkillRegistry, { type Config as SkillRegistryConfig } from '@ejunz/skill'
import * as SkillFileSystem from '@ejunz/skill-filesystem'
import AgentRegistry from '@ejunz/agent'
import GoalService, { type Config as GoalDomainConfig } from '@ejunz/goal'
import * as goalSession from '@ejunz/goal-round-driver'
import * as toolGoal from '@ejunz/tool-goal'
import LocalJobRegistry, { type Config as JobsConfig } from '@ejunz/jobs-local'
import InvariantRegistry, { type Config as InvariantConfig } from '@ejunz/invariants'
import * as sessionInvariant from '@ejunz/session/invariant'
import * as agentInvariant from '@ejunz/agent/invariant'
import * as scopeInvariant from '@ejunz/scope/invariant'
import * as agentLoopInvariant from '@ejunz/agent-loop/invariant'
import * as workspaceContext from '@ejunz/agent-instructions'
import * as toolSkill from '@ejunz/tool-skill'
import * as toolJobs from '@ejunz/tool-jobs'
import AgentLoop, { type Config as AgentLoopConfig } from '@ejunz/agent-loop'
import * as llmRetry from '@ejunz/llm-retry'
import { resolveEaHome } from '@ejunz/home-paths'

export const name = 'agent-spine-demo'

/** Overridable example policy used when a bundle consumer omits `sessionTitle`. */
const EXAMPLE_SESSION_TITLE_CONFIG: SessionTitleConfig = {
  fallbackMaxWords: 5,
  fallbackMaxBytes: 40,
  maxTitleBytes: 80,
}

/** Skill bundle config forwarded to the registry, local provider, and model-facing consumer. */
export interface SkillConfig {
  /** Mount the bundled local skill provider and model-facing skill tool (default true). */
  enabled?: boolean
  /** Registry-level discovery cache settings. */
  registry?: SkillRegistryConfig
  /** Local filesystem skill provider settings. */
  filesystem?: SkillFileSystem.Config
  /** Model-facing skill catalog and tool settings. */
  tool?: toolSkill.Config
}

/** Persisted goal domain, model-tool policy, and same-session driver config. */
export interface GoalConfig {
  /** Goal-domain creation defaults. */
  domain?: GoalDomainConfig
  /** Model-facing goal-tool authority policy. */
  tool?: toolGoal.Config
}

/**
 * Bundle config: each field forwarded verbatim to the child that owns it —
 * `agents` to the agent loop (an app that pre-creates no agents, like the ACP
 * bridge, simply omits it), `includeEjunzAgentIdentity`, `includeRuntimeContext`,
 * `persona`, and `toolOrder` to the system-prompt plugin (the fixed opener,
 * dynamic-context policy, deployment persona, and explicit model-facing tool
 * order), `eaHome` to local skill discovery, `sessionTitle` to
 * the fallback title service, `skills` to the
 * skill registry/local provider/tool consumer, `workspaceContext` to the
 * agent-instructions loader, `jobs` to the process-local job provider, and
 * `toolJobs` to its model-facing tool plugin.
 * Provider adapters own their `retryPolicy`; this bundle mounts the shared
 * agent loop and service spine.
 * `goals` opts into and configures the persisted goal domain plus its model tool
 * and same-session driver; `invariants` configures global and package-filtered
 * relational checks. Owner schemas supply defaults for optional input;
 * workspace context instead requires an explicit byte budget or `false` because
 * it changes model-visible input.
 */
export interface Config {
  /** The agent-loop `agents` list (see ea-agent-loop's `Config`). */
  agents?: AgentLoopConfig['agents']
  /** Agent-loop concurrency cap; `1` is serial. */
  maxParallelToolCalls?: AgentLoopConfig['maxParallelToolCalls']
  /** Whether the system prompt includes the fixed EjunzAgent identity (default true). */
  includeEjunzAgentIdentity?: SystemPromptConfig['includeEjunzAgentIdentity']
  /** Whether model history includes dynamic runtime-context snapshots (default true). */
  includeRuntimeContext?: SystemPromptConfig['includeRuntimeContext']
  /** The deployment persona (see ea-system-prompt's `Config`). */
  persona?: SystemPromptConfig['persona']
  /** The explicit model-facing tool order (see ea-system-prompt's `Config`). */
  toolOrder?: SystemPromptConfig['toolOrder']
  /** EjunzAgent home directory used by local skill discovery. */
  eaHome?: string
  /** Deterministic fallback and accepted-title limits; omission uses the bundle's example policy. */
  sessionTitle?: SessionTitleConfig
  /** Workspace-context loader controls with an explicit byte budget; set `false` for hermetic prompts. */
  workspaceContext: workspaceContext.Config | false
  /**
   * Skill registry, local provider, and model-facing consumer config.
   * Skills use `enabled` because one nested config controls a provider stack;
   * single model-tool plugins use `Config | false` to disable that one consumer.
   */
  skills?: SkillConfig
  /** Process-local background-job admission config. */
  jobs?: JobsConfig
  /** Generic background-job controls; set false to keep the job service without model-facing job tools. */
  toolJobs?: toolJobs.Config | false
  /** Global enablement and package-name filters for invariant companions. */
  invariants?: InvariantConfig
  /** Opt-in persisted same-session goal stack; set false or omit to leave it unmounted. */
  goals?: GoalConfig | false
}

/** The skill config schema exported for app packages that forward `skills`. */
export const SkillConfigSchema: z<SkillConfig> = z.object({
  enabled: z.boolean().default(true),
  registry: SkillRegistry.Config,
  filesystem: SkillFileSystem.Config,
  tool: toolSkill.Config,
})

/** The session-title config schema with the shared bundle's overridable example limits. */
export const SessionTitleConfigSchema: z<SessionTitleConfig> = SessionTitleService.Config
  .default(EXAMPLE_SESSION_TITLE_CONFIG)

/** The process-local job registry schema exported for app packages that forward `jobs`. */
export const JobsConfigSchema: z<JobsConfig> = LocalJobRegistry.Config

/** The job-control-tool config schema exported for app packages that forward `toolJobs`. */
export const ToolJobsConfigSchema: z<toolJobs.Config> = toolJobs.Config

/** The persisted-goal config schema exported for app packages that opt in. */
export const GoalConfigSchema: z<GoalConfig> = z.object({
  domain: GoalService.Config,
  tool: toolGoal.Config,
})

/** Intersect the owners' schemas so validation + defaulting stay identical. */
export const Config = z.intersect([
  AgentLoop.Config,
  SystemPrompt.Config,
  z.object({
    eaHome: z.string(),
    sessionTitle: SessionTitleConfigSchema,
    skills: SkillConfigSchema,
    workspaceContext: z.union([z.const(false), workspaceContext.Config]).required(),
    jobs: JobsConfigSchema,
    toolJobs: z.union([z.const(false), ToolJobsConfigSchema]),
    invariants: InvariantRegistry.Config,
    goals: z.union([z.const(false), GoalConfigSchema]),
  }) as unknown as z<Pick<Config, 'eaHome' | 'sessionTitle' | 'skills' | 'workspaceContext' | 'jobs' | 'toolJobs' | 'invariants' | 'goals'>>,
]) as unknown as z<Config>

/**
 * Copy the bundle-owned fields from an app config without leaking entry-point settings.
 * @param config - App config containing the shared spine fields.
 * @returns The fields accepted by this bundle, preserving optional absence.
 */
export function pickSpineConfig(config: Omit<Config, 'agents'>): Omit<Config, 'agents'> {
  return {
    ...config.maxParallelToolCalls !== undefined ? { maxParallelToolCalls: config.maxParallelToolCalls } : {},
    ...config.includeEjunzAgentIdentity !== undefined ? { includeEjunzAgentIdentity: config.includeEjunzAgentIdentity } : {},
    ...config.includeRuntimeContext !== undefined ? { includeRuntimeContext: config.includeRuntimeContext } : {},
    ...config.persona !== undefined ? { persona: config.persona } : {},
    ...config.toolOrder !== undefined ? { toolOrder: config.toolOrder } : {},
    ...config.eaHome !== undefined ? { eaHome: config.eaHome } : {},
    ...config.sessionTitle !== undefined ? { sessionTitle: config.sessionTitle } : {},
    workspaceContext: config.workspaceContext,
    ...config.skills !== undefined ? { skills: config.skills } : {},
    ...config.jobs !== undefined ? { jobs: config.jobs } : {},
    ...config.toolJobs !== undefined ? { toolJobs: config.toolJobs } : {},
    ...config.invariants !== undefined ? { invariants: config.invariants } : {},
    ...config.goals !== undefined ? { goals: config.goals } : {},
  }
}

/**
 * Load the spine. Each `ctx.plugin(...)` mounts one child of the bundle fiber;
 * `agent-loop` receives the forwarded `agents` list and `system-prompt` the
 * forwarded `persona` and `toolOrder`. Workspace-context receives its own
 * explicitly forwarded config. Load order is irrelevant (cordis
 * pends each fiber on its `inject` until the services it needs exist), but the
 * listing mirrors the dependency layering for readability: the LLM vocabulary
 * and core registries first, then extension plugins that wrap request/tool
 * seams, then the loop that drives them.
 */
export function apply(ctx: Context, config: Config): void {
  const nestedEaHome = config.skills?.filesystem?.eaHome
  if (config.eaHome !== undefined && nestedEaHome !== undefined
    && resolveEaHome(config.eaHome) !== resolveEaHome(nestedEaHome)) {
    throw new Error('agent-spine-demo: eaHome and skills.filesystem.eaHome must resolve to the same directory')
  }
  const eaHome = resolveEaHome(config.eaHome ?? nestedEaHome)

  ctx.plugin(Timer)
  ctx.plugin(LlmRuntime)
  ctx.plugin(SessionStore)
  ctx.plugin(SessionTitleService, config.sessionTitle ?? EXAMPLE_SESSION_TITLE_CONFIG)
  // Owner schemas resolve defaults; forward toolOrder only when explicitly set.
  ctx.plugin(SystemPrompt, {
    includeEjunzAgentIdentity: config.includeEjunzAgentIdentity ?? true,
    includeRuntimeContext: config.includeRuntimeContext ?? true,
    persona: config.persona ?? '',
    ...config.toolOrder !== undefined ? { toolOrder: config.toolOrder } : {},
  })
  ctx.plugin(ToolRuntime)
  const skillsEnabled = config.skills?.enabled ?? true
  if (skillsEnabled) {
    ctx.plugin(SkillRegistry, config.skills?.registry ?? {})
    ctx.plugin(SkillFileSystem, Object.assign({}, config.skills?.filesystem, { eaHome }))
  }
  ctx.plugin(AgentRegistry)
  ctx.plugin(llmRetry)
  if (config.goals !== undefined && config.goals !== false) {
    ctx.plugin(GoalService, config.goals.domain ?? {})
    ctx.plugin(toolGoal, config.goals.tool ?? {})
    ctx.plugin(goalSession)
  }
  ctx.plugin(LocalJobRegistry, config.jobs ?? {})
  ctx.plugin(InvariantRegistry, config.invariants ?? {})
  ctx.plugin(sessionInvariant)
  ctx.plugin(agentInvariant)
  ctx.plugin(scopeInvariant)
  ctx.plugin(agentLoopInvariant)
  if (config.workspaceContext !== false) {
    ctx.plugin(workspaceContext, config.workspaceContext)
  }
  // Both plugins prepend session-prefix messages. Registration order is the
  // rendered order, so workspace instructions must precede the skill catalog.
  if (skillsEnabled) ctx.plugin(toolSkill, config.skills?.tool ?? {})
  if (config.toolJobs !== false) ctx.plugin(toolJobs, config.toolJobs ?? {})
  ctx.plugin(AgentLoop, {
    agents: config.agents ?? [],
    ...config.maxParallelToolCalls !== undefined ? { maxParallelToolCalls: config.maxParallelToolCalls } : {},
  })
}
