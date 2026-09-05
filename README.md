# ejunz-node

Ejunz Edge/Node gateway.

`ejunz-node` runs in two modes around a Zigbee/MQTT IoT setup:

- **Node** – runs Zigbee2MQTT and a local MQTT broker at the edge of the network.
- **Edge** – provides authentication, multi-Node management, aggregation, a shared
  MQTT TCP/WebSocket broker, and the upstream connection to
  [Ejunz](https://github.com/ejunz-dev/Ejunz).

A Node first connects to an Edge without a token; an administrator approves it in the
Edge control panel, the Node receives and stores its token, and uses it automatically
on subsequent connections. An Edge can manage multiple Nodes and forward their
MCP/MQTT envelopes to the configured upstream.

## Architecture

```
                     ┌──────────────┐
   Ejunz upstream ◄──┤     Edge     │  (auth, multi-node mgmt, aggregation,
                     │  (ejunz-node)│   MQTT broker, control panel :5283)
                     └──────┬───────┘
                            │ ws /api/edge/*
              ┌─────────────┼─────────────┐
              │             │             │
        ┌─────┴─────┐  ┌────┴─────┐  ┌────┴─────┐
        │  Node 1   │  │  Node 2  │  │  Node n  │  (Zigbee2MQTT + local MQTT)
        └───────────┘  └──────────┘  └──────────┘
```

Multi-platform control is provided by the
[ejunz-node_client](https://github.com/ejunz-dev/ejunz-node_client) app
(H5 / iOS / Android / mini-programs / Electron), which talks to the Edge REST API.

## Node mode

```bash
cp config.node.example.yaml config.node.yaml
# Set ws.endpoint to the Edge endpoint, for example:
# ws://edge-host:5283/node/conn
# Set a unique nodeId for each Node. ws.token is written automatically after authorization.
yarn install && yarn build:ui && yarn dev
```

On its first connection, a Node connects to the Edge without a token. The Edge control
panel shows the pending authorization request. After an administrator approves it, the
Node receives a token, stores it in `config.node.yaml`, and uses it automatically on
subsequent connections.

## Edge mode

```bash
cp config.edge.example.yaml config.edge.yaml
# Set viewPass. To connect to Ejunz, configure upstream.endpoint and upstream.token.
yarn build:ui && yarn dev:edge
```

Edge mode starts the local MQTT TCP/WebSocket broker but does not start Zigbee2MQTT or
the Node MQTT bridge. The control panel is available at `http://edge-host:5283/` and
uses `admin` plus the configured `viewPass`. Management APIs are available under
`/api/edge/*`.

When `config.node.yaml` or `config.edge.yaml` is missing, the corresponding example
file is copied automatically:

- `config.node.example.yaml` → `config.node.yaml`
- `config.edge.example.yaml` → `config.edge.yaml`

## Ports

| Port | Service        |
|------|----------------|
| 5283 | Edge control panel, `/api/edge/*` API, Node WebSocket endpoint |
| 5284 | Node (Zigbee2MQTT + local MQTT broker)                         |

## Related

- [ejunz-node_client](https://github.com/ejunz-dev/ejunz-node_client) – multi-platform Edge client
- [ejunz-mfs](https://github.com/ejunz-dev/ejunz-mfs) – Microsoft Flight Simulator 2024 overlay
- [ejunz-projection](https://github.com/ejunz-dev/ejunz-projection) – CS2 GSI projection overlay
- [Ejunz](https://github.com/ejunz-dev/Ejunz) – knowledge management & learning platform
