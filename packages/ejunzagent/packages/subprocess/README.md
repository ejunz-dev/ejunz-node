# subprocess/ — subprocess capability family


The shared process substrate for one execution world: executable lookup, fully-specified managed child-process trees, raw or collected stdio, and process-tree cleanup. Command defaulting, deadlines, and presentation stay with consumers such as the [LSP host](../lsp/README.md) and [ACP subagent backend](../subagent/README.md). See the subprocess seam Agent Note.

| Package | ctx key | Role |
|---|---|---|
| [`subprocess`](subprocess/README.md) (`@ejunz/subprocess`) | `ctx.subprocess` | Service Definition: executable lookup, managed child-process spawns, handle lifecycles, and shared environment/output vocabulary |
| [`subprocess-local`](subprocess-local/README.md) (`@ejunz/subprocess-local`) | — | Local Service Provider: detached process trees, bounded collection/spill, tree signalling, and terminate-and-join disposal |

The service owns process lifetime across consumer reloads; consumers own what a process means and every default that shapes one.

The subsystem reference — spawn specs, output readers, outcomes, the `EA_*` environment — is [docs/subsystems/subprocess.md](../../docs/subsystems/subprocess.md); the seam decision in the subprocess seam Agent Note.
