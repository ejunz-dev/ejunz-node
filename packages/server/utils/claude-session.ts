import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'child_process';
import { Logger } from '@ejunz/utils';

const logger = new Logger('utils/claude-session');

const CLAUDE_DIR = path.join(process.env.HOME || '/root', '.claude');
const SESSIONS_DIR = path.join(CLAUDE_DIR, 'sessions');
const HISTORY_FILE = path.join(CLAUDE_DIR, 'history.jsonl');

interface SessionMeta {
    pid: number;
    sessionId: string;
    cwd: string;
    startedAt: number;
}

/**
 * 从 tmux session 中获取 claude 进程的 PID
 */
function getClaudePidFromTmux(tmuxSession: string): number | null {
    try {
        const stdout = execSync(
            `tmux list-panes -t ${tmuxSession} -F '#{pane_pid}' 2>/dev/null`,
            { encoding: 'utf-8', timeout: 3000 },
        ).trim();
        const panePid = parseInt(stdout.split('\n')[0], 10);
        if (!panePid) return null;

        // 查找 claude 进程（pane_pid 的子进程）
        const psOut = execSync(
            `ps -eo pid,ppid,comm --no-headers 2>/dev/null | grep -E '\\b${panePid}\\b' | grep -i claude | head -1`,
            { encoding: 'utf-8', timeout: 3000 },
        ).trim();
        if (psOut) {
            const pid = parseInt(psOut.trim().split(/\s+/)[0], 10);
            if (pid) return pid;
        }

        // 兜底：直接在 panePid 范围内查找 claude
        const psOut2 = execSync(
            `pgrep -P ${panePid} -f claude 2>/dev/null | head -1`,
            { encoding: 'utf-8', timeout: 3000 },
        ).trim();
        if (psOut2) return parseInt(psOut2, 10);

        return null;
    } catch {
        return null;
    }
}

/**
 * 读取 ~/.claude/sessions/*.json，返回 PID → SessionMeta 映射
 */
function loadSessionMetaMap(): Map<number, SessionMeta> {
    const map = new Map<number, SessionMeta>();
    try {
        const files = fs.readdirSync(SESSIONS_DIR).filter(f => f.endsWith('.json'));
        for (const file of files) {
            try {
                const data = JSON.parse(fs.readFileSync(path.join(SESSIONS_DIR, file), 'utf-8'));
                if (data.pid && data.sessionId) {
                    map.set(data.pid, {
                        pid: data.pid,
                        sessionId: data.sessionId,
                        cwd: data.cwd || '',
                        startedAt: data.startedAt || 0,
                    });
                }
            } catch { /* skip malformed */ }
        }
    } catch { /* sessions dir not found */ }
    return map;
}

// 缓存 history.jsonl 的 sessionId → 首条消息映射
let historyCache: Map<string, string> | null = null;
let historyCacheTime = 0;

/**
 * 读取 ~/.claude/history.jsonl，返回 sessionId → 首条用户消息映射
 */
function loadHistoryMap(): Map<string, string> {
    const now = Date.now();
    if (historyCache && now - historyCacheTime < 30000) return historyCache;

    const map = new Map<string, string>();
    try {
        const content = fs.readFileSync(HISTORY_FILE, 'utf-8');
        for (const line of content.split('\n')) {
            if (!line.trim()) continue;
            try {
                const d = JSON.parse(line);
                if (d.sessionId && d.display && !map.has(d.sessionId)) {
                    map.set(d.sessionId, d.display);
                }
            } catch { /* skip malformed */ }
        }
    } catch { /* history file not found */ }

    historyCache = map;
    historyCacheTime = now;
    return map;
}

export interface ClaudeSessionInfo {
    sessionId: string;
    sessionName: string;  // 首条用户消息（截断到 60 字符）
}

/**
 * 解析 tmux session 对应的 Claude session 信息
 */
export function resolveClaudeSession(tmuxSession: string): ClaudeSessionInfo | null {
    try {
        const pid = getClaudePidFromTmux(tmuxSession);
        if (!pid) return null;

        const metaMap = loadSessionMetaMap();
        const meta = metaMap.get(pid);
        if (!meta) return null;

        const historyMap = loadHistoryMap();
        const displayName = historyMap.get(meta.sessionId) || '';

        return {
            sessionId: meta.sessionId,
            sessionName: displayName.slice(0, 60),
        };
    } catch {
        return null;
    }
}
