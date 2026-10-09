/** Browser runtime services for sessions and connection-stream delivery. */
import type { Context } from '@ejunz/cordis'
import type { ConnectionHandle, SessionId } from '@ejunz/api-remotes/client'
// Type-only: the ctx.remote merge. Deliberately the gateway's Client half rather
// than api-remotes': that face imports a Host-tsdown-generated artifact, and this
// project sits in the Host build graph.
import type {} from '@ejunz/api-remotes/client'
import type { TypertContext } from '@ejunz/typert-protocol'
import { SessionRuntime } from './sessions/service.ts'
import { ConversationEventRegistry } from './conversation/event-registry.ts'
import { ConversationViewRegistry } from './conversation/view-registry.ts'

export { isAppendSurfaceEvent, isReplacementSurfaceEvent } from '@ejunz/session/surface'

export { ConversationEventRegistry } from './conversation/event-registry.ts'
export { ConversationViewRegistry } from './conversation/view-registry.ts'
export { ConversationNodeAssembler } from './sessions/conversation-assembler.ts'
export { ConversationLocationIndex } from './sessions/conversation-location-index.ts'
export { conversationContextKey } from './contract/conversation.ts'
export type {
  ChatConversationViewNode, ConversationContextReader, ConversationEventInput,
  ConversationLocationData, ConversationLocationDataScope, ConversationLocationDataStore,
  ConversationStepDataMap,
  ConversationLocation, ConversationMatch, ConversationMatchResult,
  ConversationNodeContext, ConversationNodeDefinition, ConversationPreviousContext,
  ConversationPublication, ConversationTimelineSnapshot, ConversationTurnDataMap, ConversationViewBuilder,
  ConversationViewDefinition, ConversationViewNode, ConversationViewSnapshotMap,
  ConversationViewSnapshotStore, StepLocation, TurnLocation,
} from './contract/conversation.ts'
export type { ConversationRuntime } from './sessions/conversation-assembler.ts'
export { SessionCreateError, SessionRuntime, scopeOf } from './sessions/service.ts'
export { indexSubagentDescendants } from './sessions/subagent-lineage.ts'
export type { SubagentDescendantSummary } from './sessions/subagent-lineage.ts'
export { createScope } from './agents/scope.ts'
export type { AgentScopeHandle } from './agents/scope.ts'
// Contract only: the scope implementation and its Host transport belong to
// ea-client-ui-settings (see that package's settings-scope.ts).
export type {
  SettingsScope, SettingsScopeSnapshot, SettingsScopeSpec,
} from './contract/settings-scope.ts'
export type { Session } from './sessions/session.ts'
export type { ISession, ProjectionsFace, SessionFace } from './contract/session.ts'
export type { AgentContext, ISessions } from './contract/sessions.ts'
export type {
  SessionBinding, SessionListState, SessionSummary,
} from './sessions/service.ts'
export type { SessionListPhase, SessionSearchResultItem, SubagentCatalogSnapshot } from './sessions/manager.ts'
export type { SubagentAddress, JobView } from '@ejunz/client-connection/client'
export { createSnapshotStore, shallowEqual } from './contract/store.ts'
export type { ObservableSnapshot, SnapshotStore } from './contract/store.ts'
export type {
  AssistantBlock, AssistantMessageNode, AssistantProvenanceView, AssistantRequestConfig,
  AssistantTiming, ChatLocationNodeIndex, ChatNodeStore, ChatSnapshot,
  CommandNode, CompactionSummaryNode, ComposerPhase,
  ContextMessageNode, ConversationNode, ConversationSnapshot, ModelRetryNode, QueuedMessage,
  LegacyConversationSlice, PartialAssistant, RunningToolCall,
  SteeringMessageNode, TodoItem, ToolCallBlock, ToolResultNode, TurnErrorNode, TurnMaxTokensNode,
  UnknownSurfaceNode, UserMessageNode,
} from './sessions/conversation.ts'
export {
  EMPTY_CHAT_SNAPSHOT, EMPTY_CONVERSATION_VIEWS, toAssistantBlock, toAssistantBlocks,
} from './sessions/conversation.ts'
export { emptyAssistantBlock } from './sessions/partial.ts'
export { isTokenDelta } from './sessions/assistant-timing.ts'
export { contextForm, contextProvenance } from './sessions/context-provenance.ts'
export { displayFailureMessage } from './sessions/failure-display.ts'
export type {
  ConversationContext, ConversationContextOriginKind,
} from './sessions/conversation-context.ts'
export type {
  ContextProvenanceView, ContextRole, KnownContextForm,
} from './sessions/context-provenance.ts'
export type {
  ConversationPromptSnapshot, RequestInspectionSnapshot, RequestPromptChange, RequestView,
} from './sessions/request-inspection.ts'
export { PendingWait } from './sessions/pending.ts'
export type {
  PendingInteraction, PendingInteractionStatus, PendingKind, PendingPayloads,
} from './sessions/pending.ts'
// Projection value store (push model; see the session-projection subsystem
// page, docs/subsystems/session-projection.md): host-computed
// whole values per key; domains ship projection support with zero client code.
export type {
  ProjectionsBaseline, ProjectionValueStore, SessionProjectionMap,
} from './sessions/projection-store.ts'
export type { SessionId } from '@ejunz/client-connection/client'

/** Client-side Cordis context after declaration merging. */
export type ClientContext = Context

declare module '@ejunz/typert-protocol' {
  interface TypertContextMap {
    /** Client Agent scope identity; the agent and session share one wire id. */
    agent: TypertContext<SessionId>
  }
}

declare module '@ejunz/cordis' {
  interface Events {
    /**
     * A connection generation was (re-)established. Wire-derived caches must
     * treat their state as stale and repull (commands directory; the queue
     * mirrors reset themselves through the session resync path).
     * @mode emit
     */
    'connection/reset'(): void
  }
  interface Context {
    /** Event-to-business-Context Definition registry. */
    conversationEvents: import('./conversation/event-registry.ts').ConversationEventRegistry
    /** Per-target Conversation snapshot builder registry. */
    conversationViews: import('./conversation/view-registry.ts').ConversationViewRegistry
    /** The outward face only; the concrete service stays inside the runtime. */
    sessions: import('./contract/sessions.ts').ISessions
  }
}

/** Required services: the wire handle and Client Typert registry. */
export const inject = ['connection', 'typert', 'remote', 'remote.commands']

/** Mounts the browser runtime services and connection stream.
 * @param ctx - Client Cordis context.
 */
export function apply(ctx: Context): void {
  const conversation = {
    events: new ConversationEventRegistry(ctx),
    views: new ConversationViewRegistry(ctx),
  }
  const connection = ctx.get('connection') as ConnectionHandle
  const sessions = new SessionRuntime(ctx, connection.api, ctx.remote, conversation)
  ctx.typert.contexts.registerClient('agent', {
    identity: candidate => sessions.scopeOf(candidate),
  })
  const loop = connection.start({
    onMuxEnvelope: (envelope) => {
      sessions.handleMuxEnvelope(envelope)
    },
    onHostEnvelope: (envelope) => {
      sessions.handleHostEnvelope(envelope)
      // Forwarded-event bridge: the session layer ignores registry frames (no
      // session routing). This plugin owns the frame sink, so it hands the
      // decoded frame straight to the Remote service, which fans it out to
      // `ctx.remote.$on` subscribers; no consumer reads a frame.
      const frame = envelope.payload
      if (frame.type === 'host/remote-event') ctx.remote.$dispatch(frame.event, frame.args)
    },
    onConnected: () => {
      sessions.handleConnected()
      ctx.emit('connection/reset')
    },
    onStateChange: (state) => {
      // Generation death fires before any next-generation frame can arrive
      // (reconnect replays flow from stream open, ahead of onConnected):
      // the only safe moment to drop generation-scoped interaction state.
      if (state === 'reconnecting') {
        sessions.handleDisconnected()
      }
    },
  })
  ctx.effect(() => () => { loop.stop() }, 'runtime: connection stream loop')
}
