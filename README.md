# ejunz-node

Ejunz Node / Edge: the Node runs Zigbee2MQTT and a local MQTT broker, while the Edge provides authentication, multi-Node management, aggregation, and the upstream Ejunz connection.

## Node mode

```bash
cp config.node.example.yaml config.node.yaml
# Set ws.endpoint to the Edge endpoint, for example:
# ws://edge-host:5283/node/conn
# Set a unique nodeId for each Node. ws.token is written automatically after authorization.
yarn install && yarn build:ui && yarn dev
```

On its first connection, a Node connects to the Edge without a token. The Edge control panel shows the pending authorization request. After an administrator approves it, the Node receives a token, stores it in `config.node.yaml`, and uses it automatically on subsequent connections.

## Edge mode

```bash
cp config.edge.example.yaml config.edge.yaml
# Set viewPass. To connect to Ejunz, configure upstream.endpoint and upstream.token.
yarn build:ui && yarn dev:edge
```

Edge mode starts the local MQTT TCP/WebSocket broker but does not start Zigbee2MQTT or the Node MQTT bridge. The control panel is available at `http://edge-host:5283/` and uses `admin` plus the configured `viewPass`. Management APIs are available under `/api/edge/*`.

An Edge instance can manage multiple Nodes and forward their MCP/MQTT envelopes to the configured upstream.

When `config.node.yaml` or `config.edge.yaml` is missing, the corresponding example file is copied automatically:

- `config.node.example.yaml` → `config.node.yaml`
- `config.edge.example.yaml` → `config.edge.yaml`
