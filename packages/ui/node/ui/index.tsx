import { registerLayout } from '@ejunz/ui-next/registry/layout';
import { registerPage } from '@ejunz/ui-next/registry/page';
import Dashboard from './Dashboard';
import Console from './Console';
import NodeLayout from './layout';
import Settings from './Settings';

registerLayout('node', NodeLayout);
registerPage('node_dashboard', async () => ({ default: Dashboard }), { layout: 'node' });
registerPage('node_console', async () => ({ default: Console }), { layout: 'node' });
registerPage('node_settings', async () => ({ default: Settings }), { layout: 'node' });
