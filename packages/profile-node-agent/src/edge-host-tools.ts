// @ts-nocheck
import type { Context } from '@ejunz/cordis';

export const name = 'edge-host-tools';

export function apply(ctx: Context) {
    const client = (globalThis as any).__ejunz_edge_host_tool_client;
    if (!client) throw new Error('Edge host-tool client must be installed before the Agent profile');
    ctx.provide('hostProvider', client);
    ctx.on('tools/pre-execute', (execution: any, next: () => Promise<any>) => {
        if (execution.name !== 'zigbee_control_device') return next();
        return Promise.resolve({
            kind: 'ask',
            reason: `Approve changing ${String(execution.arguments?.deviceId || 'the selected device')} on node ${String(execution.arguments?.nodeId || 'unknown')} to ${String(execution.arguments?.state || 'unknown')}?`,
        });
    });
}
