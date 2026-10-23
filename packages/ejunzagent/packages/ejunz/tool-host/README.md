# `@ejunz/tool-host`

Registers the tool set a host declares, scoped to each Agent session.

The package keeps no tool list of its own. The attached host client declares the set, so a deployment registers exactly the tools its host exposes, with the host's names, descriptions, and parameter schemas. A host serves its catalog per domain, so the catalog is read for one Agent session: the current session id lets the host resolve the acting domain, and the tools land in that Agent's scope alone. When the session's add-on state changes, the live Agent refreshes its catalog and guidance before the update is acknowledged.

## Configuration

None. A deployment attaches a client; the host owns the rest.

## Client

The package does not access host storage directly. A deployment supplies a root `hostProvider` before the package is loaded.

A client declares what it can execute and executes it:

- `catalog(signal, { sessionId, runtimeTools })` declares the tools to install: each one's `name`, `description`, and `inputSchema`, plus optional `runtimeDelegation` and `guidance`. The Agent supplies schemas for tools installed in its current scope; the host merges those capabilities with its registered tools and applies session visibility. Reading without a session omits runtime-only tools.
- `call(name, args, { sessionId, runtimeDelegation }, signal)` executes one declared host tool, or asks the host to authorize delegation of a same-named native Agent tool.

A host may return a private `{"type":"ejunz/runtime-tool-call","toolName":"..."}` result to ask the adapter to execute the same-named native tool in the current Agent runtime with the original call arguments. For runtime-only catalog entries, `runtimeDelegation: true` marks the wrapper and the call asks the host to authorize delegation; the host checks the session's `agent-runtime` add-on and user privilege before returning the marker. The adapter captures the same-scope native definition before registering the scoped host tool, rejects a different name or missing implementation, and preserves the native output/presentation contract. The delegation envelope is consumed internally and never returned to the model. Ordinary host results continue through the host tool's result renderer.

For the standalone Agent process, the CLI installs a root bridge from `EJUNZ_AGENT_DATA_ORIGIN` and `EJUNZ_AGENT_DATA_TOKEN`. The Agent factory installs the set in each Agent's `setup`, before that Agent is published, so an Agent never reaches its first turn without the tools its domain publishes. A composition that cannot reach the provided installer service builds the bridge from those same environment variables and installs with its own client.

The Ejunz host resolves the session through its domain- and user-isolated Agent model, then creates its own provider from its own Cordis context:

```ts ignore-check
const provider = createProvider(ejunzContext, {
  domainId: session.domainId,
  owner: session.userId,
  baseDocId: Number(session.baseDocId),
  sessionId,
})
```

The host owns the catalog: an addon registers its tools, with their names, descriptions, and JSON Schemas, through the Ejunz tool registry (`packages/ejunztools/src/registry.ts`), and the host's bridge serves whatever is registered, filtered by the domain of the session that asks. Tools that act on the session itself — `base_context`, `base_select` — are declared in the same place and reach the session through `ToolContext.sessionId`, so this package holds no declaration of its own.

## Tools

Every tool the host declares, under the name it declares.

## Model Experience

### Tool schemas the host declares

#### What the model sees

One tool per entry of the host-provided catalog for this session's domain, under the host's own names, descriptions, and parameter schemas. A domain that publishes extra tools offers them only to its own sessions, and a call resolves the domain and owner from the Agent session id it carries.

#### Token effect

Every declared tool occupies one entry of the request's `tools` array, and the host's description and parameter schema are sent verbatim, so a deployment's own catalog bounds the cost. This package adds no schema text of its own. Ordinary host results are rendered from the host's lossless JSON value; delegated native results use the captured native tool's output contract.

#### KV Cache effect

Each Agent reads the catalog for its own session and installs it into its own scope. A session add-on change refreshes that scope's tool block before the next model request; the changed tool block invalidates the prior prompt-cache prefix for that request.

### System prompt section

#### What the model sees

One section named `host-tools`, carrying only the guidance the host resolved for this session. The tool names and schemas are already in the request's tool list, so the section repeats none of them.

##### Guidance for a session with a selected Base

```markdown
Current Ejunz Base domain: Jacka1_; Base id: 12 (Notes).
```

#### Token effect

The section costs exactly the host's guidance text, which the host builds while it serves the catalog and the Agent side appends unchanged. A session with no selected Base receives one sentence instead: that the bridge resolves the Base scope for each call.

#### KV Cache effect

The guidance is registered per Agent and stays stable across turns until that session's add-on state changes; the host refreshes it together with the tool catalog before acknowledging the change.

## Known Limitations and Deferred Work

- The package requires a host integration to attach a client; a deployment that attaches none installs no tool.
- User permission checks for the operations a host declares remain owned by the host.
- There is no fallback catalog, because a copy would drift from the host's registry, so a client whose catalog is empty installs nothing.
- The host's guidance is registered per Agent, so an Agent that switches domain mid-session keeps the guidance of the domain it composed under until it is recomposed.
