# context/ — request-context extensions


Product plugins that add model-visible request context without defining a tool. `agent-instructions` is included by the default `ea-agent-spine-demo` bundle and can be disabled through bundle config; `time-context` and `session-reference` are opt-in.

| Package | Role | ctx key |
|---|---|---|
| [`session-reference/`](session-reference/README.md) | Bounded snapshots of other sessions | `ctx.sessionReferenceResolver` |
| [`time-context/`](time-context/README.md) | Current-time and elapsed-time context | — |
| [`agent-instructions/`](agent-instructions/README.md) | Working-directory instruction context | — |

Session references are documented in [docs/subsystems/session-reference.md](../../docs/subsystems/session-reference.md); the `agent-instructions` decision record owns its per-agent/session isolation and lifecycle split.
