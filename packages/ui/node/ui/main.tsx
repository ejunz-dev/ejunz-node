import '@ejunz/ui-next/components/theme.css';
import '@ejunz/ui-next/components/ui.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from '@ejunz/ui-next/app';
import { initialPage } from '@ejunz/ui-next/globals';
import { PageDataProvider } from '@ejunz/ui-next/context/page-data';
import './index';

const pathname = window.location.pathname.replace(/\/+$/, '');
const pathPage = pathname.endsWith('/console')
    ? 'node_console'
    : pathname.endsWith('/settings') ? 'node_settings' : 'node_dashboard';
const pageData = {
    ...initialPage,
    name: initialPage.name || pathPage,
    args: {
        UserContext: {},
        UiContext: {},
        ...initialPage.args,
    },
    url: initialPage.url || window.location.pathname,
};

createRoot(document.getElementById('root')!).render(
    <StrictMode>
        <PageDataProvider initial={pageData}>
            <App />
        </PageDataProvider>
    </StrictMode>,
);
