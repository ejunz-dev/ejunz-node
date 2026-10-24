import { registerLayout } from '@ejunz/ui-next/registry/layout';
import { registerPage } from '@ejunz/ui-next/registry/page';
import type { ReactNode } from 'react';
import { Header } from './components/Header';
import Auth from './pages/Auth';
import Chat from './pages/Chat';
import Config from './pages/Config';
import Dashboard from './pages/Dashboard';
import Devices from './pages/Devices';
import Nodes from './pages/Nodes';
import Upstream from './pages/Upstream';
import './layout.css';

function EdgeLayout({ children }: { children: ReactNode }) {
    return <div className="edge-ui-shell"><Header /><main className="edge-ui-main">{children}</main></div>;
}

registerLayout('edge', EdgeLayout);
registerPage('edge_dashboard', async () => ({ default: Dashboard }), { layout: 'edge' });
registerPage('edge_devices', async () => ({ default: Devices }), { layout: 'edge' });
registerPage('edge_nodes', async () => ({ default: Nodes }), { layout: 'edge' });
registerPage('edge_upstream', async () => ({ default: Upstream }), { layout: 'edge' });
registerPage('edge_chat', async () => ({ default: Chat }), { layout: 'edge' });
registerPage('edge_config', async () => ({ default: Config }), { layout: 'edge' });
registerPage('edge_auth', async () => ({ default: Auth }), { layout: 'edge' });
