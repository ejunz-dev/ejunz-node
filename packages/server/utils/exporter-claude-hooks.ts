import fs from 'node:fs';
import path from 'node:path';

const HOOK_SCRIPT = path.resolve(__dirname, '../../../.claude/hooks/status.sh');

function hookCmd(status: string, detail: string) {
    const extra = detail ? ` ${detail}` : '';
    return `bash ${HOOK_SCRIPT} "$(tmux display-message -p '#S')" ${status}${extra}`;
}

export function buildExporterHooksConfig() {
    return {
        hooks: {
            UserPromptSubmit: [{
                hooks: [{ type: 'command', command: hookCmd('working', 'prompt') }],
            }],
            PreToolUse: [{
                matcher: '',
                hooks: [{ type: 'command', command: hookCmd('working', 'tool') }],
            }],
            SubagentStart: [{
                matcher: '',
                hooks: [{ type: 'command', command: hookCmd('working', 'subagent') }],
            }],
            Notification: [{
                matcher: 'permission_prompt',
                hooks: [{ type: 'command', command: hookCmd('waiting_approval', '') }],
            }],
            Stop: [{
                hooks: [{ type: 'command', command: hookCmd('idle', 'stop') }],
            }],
        },
    };
}

/** Install exporter status hooks into a project's .claude/settings.local.json */
export function installClaudeExporterHooks(workingDir: string): boolean {
    if (!workingDir || !fs.existsSync(workingDir)) return false;
    if (!fs.existsSync(HOOK_SCRIPT)) return false;

    const claudeDir = path.join(workingDir, '.claude');
    const localPath = path.join(claudeDir, 'settings.local.json');
    fs.mkdirSync(claudeDir, { recursive: true });

    let existing: Record<string, unknown> = {};
    if (fs.existsSync(localPath)) {
        try {
            existing = JSON.parse(fs.readFileSync(localPath, 'utf-8'));
        } catch { /* ignore corrupt file */ }
    }

    const hooksConfig = buildExporterHooksConfig();
    const merged = { ...existing, ...hooksConfig };
    const next = `${JSON.stringify(merged, null, 2)}\n`;
    if (fs.existsSync(localPath) && fs.readFileSync(localPath, 'utf-8') === next) return false;

    fs.writeFileSync(localPath, next);
    return true;
}
