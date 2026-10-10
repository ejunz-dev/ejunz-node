import type { RpcRequest, RpcResponse } from './rpc.ts'

/** Host-level information shared with the browser surface. */
export interface HostApi {
  /**
   * One-shot host snapshot. The working directory is a display/default value;
   * this API exposes no host filesystem or native-application operations.
   * @param request - empty request payload.
   * @returns the host version, default working directory, model selection, and attached-session count.
   */
  describe(request: RpcRequest<{}>): Promise<RpcResponse<{
    version: string
    cwd: string
    provider?: string
    model?: string
    attachedSessions: number
  }>>
}
