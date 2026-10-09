/**
 * TypeScript client SDK for the EjunzAgent runtime: spawn the
 * `ea-jsonrpc-agent` runtime as a subprocess and drive agent turns over
 * stdio JSON-RPC. `EjunzAgent` is the high-level run API;
 * `EjunzAgentClient` is the lower-level protocol client. A pure library — it
 * registers nothing on a Cordis context; the runtime process it spawns is a
 * complete ejunzAgent configured by its own `cordis.yml`.
 *
 * @module @ejunz/sdk-client
 */

export { EjunzAgent, EjunzAgentSession } from './api.ts'
export type { RunOptions } from './api.ts'
export {
  EjunzAgentClient,
  RequestTimeoutError,
  SdkProtocolError,
  TransportClosedError,
} from './client.ts'
export type { NotificationSubscription } from './client.ts'
export { JsonRpcResponseError } from '@ejunz/sdk-protocol'
export type {
  ContentBlock,
  EjunzAgentOptions,
  EjunzAgentClientOptions,
  EjunzAgentNotification,
  NotificationFilter,
  RunResult,
} from './types.ts'
