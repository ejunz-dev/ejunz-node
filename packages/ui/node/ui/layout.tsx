import type { ReactNode } from 'react';
import './layout.css';

export default function NodeLayout({ children }: { children: ReactNode }) {
    return (
        <div className="node-ui-shell">
            <header className="node-ui-header">
                <a className="node-ui-brand" href="/node-ui">Ejunz Node</a>
                <nav className="node-ui-nav" aria-label="Node UI">
                    <a href="/node-ui">Dashboard</a>
                    <a href="/node-ui/console">Zigbee Console</a>
                    <a href="/node-ui/settings">Settings</a>
                </nav>
            </header>
            <main className="node-ui-main">{children}</main>
        </div>
    );
}
