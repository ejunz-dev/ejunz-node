# extensions/ — the agent modifies its own runtime


Model-facing tools over the live host Cordis runtime: inspect loaded plugins and service APIs, define and run restricted host-side dynamic packages, and retract them again. The browser-side dynamic-package runner and UI surfaces are not part of this workspace. Design home: the toolset Agent Note.

| Package | Role | ctx key |
|---|---|---|
| `tool-cordis/` | Model-facing runtime inspection and dynamic-package tools | registers on `ctx.tools` |
| `cordis-host-runner/` | Definition registry and the `node:vm` sandbox for host-side dynamic packages | provides `ctx.dynamicCordisRunner` |
