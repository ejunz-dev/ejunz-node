# ejunz-node

Ejunz Node：Zigbee2MQTT 与 MQTT Broker 控制节点。

```bash
cp config.example.yaml config.node.yaml
# 编辑 config.node.yaml，将 ws.endpoint 替换为实际的上游 MCP WebSocket 地址
# ws.localEndpoint 是本机提供给客户端的 WebSocket 路径，默认 /mcp/ws
yarn install && yarn build:ui && yarn dev
```

未配置 `config.node.yaml` 时，服务会自动从 `config.example.yaml` 创建配置；启动前仍需替换示例中的 `ws.endpoint`，否则客户端会尝试连接占位地址。
