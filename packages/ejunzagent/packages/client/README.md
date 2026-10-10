# client/ — browser runtime

The retained client group contains the browser transport and session/conversation projection runtime. Browser UI composition, slot registration, workspace management, and `ui-*` feature packages are not included.

| Package | Role | Context surface |
|---|---|---|
| `connection/` | Browser-side API and event-stream transport | `connection`, `remote` |
| `runtime/` | Client session and conversation state | `sessions`, `conversationEvents`, `conversationViews` |
