const links = [
    ['/edge-ui', 'Dashboard'], ['/edge-ui/devices', '设备控制'], ['/edge-ui/nodes', 'Node 管理'],
    ['/edge-ui/upstream', '上游连接'], ['/edge-ui/chat', 'Agent Chat'], ['/edge-ui/config', '模型配置'], ['/edge-ui/auth', '认证设置'],
] as const;

export function Header() {
    return <header className="edge-ui-header"><strong>Edge Dashboard</strong><nav aria-label="Edge UI">
        {links.map(([href, label]) => <a key={href} href={href}>{label}</a>)}
    </nav></header>;
}
