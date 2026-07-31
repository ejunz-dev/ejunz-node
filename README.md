# ejunz-node

Ejunz Node / Edge：Node 负责 Zigbee2MQTT 与本地 MQTT Broker，Edge 负责多 Node 的认证、聚合和上游连接。

## Node 模式

```bash
cp config.node.example.yaml config.node.yaml
# ws.endpoint 指向 Edge，例如 ws://edge-host:5283/node/conn
# nodeId 必须为每个 Node 设置唯一值；授权成功后 ws.token 会自动写回配置
yarn install && yarn build:ui && yarn dev
```

Node 首次连接 Edge 时不带 token，Edge 控制面板会显示待授权请求。打开 Edge 面板批准后，Node 会收到 token、保存到 `config.node.yaml`，以后重启会自动使用该 token 连接。

## Edge 模式

```bash
cp config.edge.example.yaml config.edge.yaml
# 设置 viewPass；如需连接 Ejunz，填写 upstream.endpoint / upstream.token
yarn build:ui && yarn dev:edge
```

Edge 启动本地 MQTT TCP/WebSocket Broker，但不会启动 Zigbee2MQTT 或 Node 的 MQTT bridge。控制面板位于 `http://edge-host:5283/`，使用 `admin / viewPass` 登录；管理 API 位于 `/api/edge/*`。Edge 可以同时管理多个 Node，并把 Node 的 MCP/MQTT Envelope 转发到配置的 upstream。

未配置对应的 `config.node.yaml` 或 `config.edge.yaml` 时，服务会分别从 `config.node.example.yaml` 或 `config.edge.example.yaml` 创建配置。
