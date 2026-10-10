# e2b/ — E2B remote runtime family


An experimental provider-composition POC that places one filesystem/process/remote-execution world in an E2B Linux sandbox. E2B supplies only sandbox lifecycle and the two fundamental OS adapters; provider-neutral consumers build higher capabilities above them.

| Package | ctx key | Role |
|---|---|---|
| [`e2b`](e2b/README.md) (`@ejunz/e2b`) | `ctx.e2b` | Create one sandbox, prepare its working/runtime directories, expose the shared SDK handle, and delete it on timeout or disposal |
| [`fs-e2b`](fs-e2b/README.md) (`@ejunz/fs-e2b`) | `ctx.fs` | Implement the filesystem seam over E2B Filesystem APIs |
| [`subprocess-e2b`](subprocess-e2b/README.md) (`@ejunz/subprocess-e2b`) | `ctx.subprocess` | Implement executable lookup, managed process groups and stdio, and remote spill files over E2B Commands and Filesystem APIs |

The [`lsp-stdio`](../lsp/lsp-stdio/README.md) adapter needs no E2B-specific fork: it delegates execution-world operations to `ctx.fs` and `ctx.subprocess`, so mounting the two E2B adapters places its mutable work in the same remote sandbox.

This boundary does not move the ejunzAgent process, Cordis objects, model calls, agent/session state, session persistence, skills, higher-level protocol state, or E2B SDK buffers. The portable execution-world decision owns both the generic composition and this POC boundary.
