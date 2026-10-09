/** Host registry and HTTP adapter for generic Connection RPC channels. */
import { Context, Service } from '@ejunz/cordis';
import { type FetchHandler } from './http-bridge.ts';
import type { ConnectionFetchHandler, HostConnectionHandle, HostConnectionRpc } from './rpc.ts';
declare module '@ejunz/cordis' {
    interface Context {
        /** Host Connection transport and RPC registrations. */
        connection: HostConnectionHandle;
    }
}
/** Host Connection service whose channel registrations belong to the caller fiber. */
export declare class HostConnectionService extends Service implements HostConnectionHandle {
    private readonly trustedHosts;
    private readonly interceptors;
    /**
     * The composed `/api` handler, assigned by the Host half beside its route
     * registration. An embedding host reads it through `ctx.connection` and calls
     * it directly instead of dialling that route.
     */
    apiHandler?: ConnectionFetchHandler;
    /**
     * Provide the Host half over the active HTTP server.
     * @param ctx - owning Connection plugin context.
     * @param trustedHosts - deployment authorities accepted by trusted-host channels.
     */
    constructor(ctx: Context, trustedHosts: readonly string[]);
    /** Generic channel registry scoped to the Context reading this service. */
    get rpc(): HostConnectionRpc;
    /**
     * Compose one shared-channel Fetch handler from its interceptor and fallback.
     * @param channel - shared channel mounted by Connection.
     * @param fallback - handler for endpoints not claimed by the interceptor.
     * @returns Fetch handler that selects exactly one target for each request.
     */
    createSharedFetchHandler(channel: '/api', fallback: FetchHandler): FetchHandler;
    private register;
    private registerInterceptor;
}
//# sourceMappingURL=rpc-host.d.ts.map