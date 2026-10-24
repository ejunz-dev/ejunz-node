import '@ejunz/ui-next/components/theme.css';
import '@ejunz/ui-next/components/ui.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from '@ejunz/ui-next/app';
import { initialPage } from '@ejunz/ui-next/globals';
import { PageDataProvider } from '@ejunz/ui-next/context/page-data';
import './index';

const pathname = window.location.pathname.replace(/\/+$/, '');
const pageName = pathname.endsWith('/devices') ? 'edge_devices'
    : pathname.endsWith('/nodes') ? 'edge_nodes'
        : pathname.endsWith('/upstream') ? 'edge_upstream'
            : pathname.endsWith('/chat') ? 'edge_chat'
                : pathname.endsWith('/config') ? 'edge_config'
                    : pathname.endsWith('/auth') ? 'edge_auth' : 'edge_dashboard';
const pageData = { ...initialPage, name: initialPage.name || pageName, args: { UserContext: {}, UiContext: {}, ...initialPage.args }, url: initialPage.url || window.location.pathname };

createRoot(document.getElementById('root')!).render(
    <StrictMode><PageDataProvider initial={pageData}><App /></PageDataProvider></StrictMode>,
);
