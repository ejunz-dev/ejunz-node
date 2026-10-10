# host/ — embedded Host API


The host-side API gateway and loopback HTTP carrier used by embedded Agent runtimes and non-browser clients. The browser UI is not part of this composition.

| Package | Role | ctx key |
|---|---|---|
| [`apiproxy/`](apiproxy/README.md) | Shared host API gateway and wire contract | `ctx.apiProxy` |
| [`webserver/`](webserver/README.md) | HTTP route carrier | `ctx.webServer` |
| [`plugin-inventory/`](plugin-inventory/README.md) | Read-only projection of current Loader entries | Remote `pluginInventory/list` |

`apiproxy` remains transport-independent; [`client/connection`](../client/connection/README.md) supplies the RPC carrier.
