declare module 'cordis' {
    interface Context {
        params: any;
        fetcher: any;
        voice: import('./service/voice').IVoiceService;
        exporterManager: import('./service/exporter-manager').default;
    }
    interface Events {
        'app/started': () => void
        'app/ready': () => VoidReturn
        'app/exit': () => VoidReturn
        'exporter/status-change': (agent: import('./service/exporter-manager').ExporterProcess) => void
        'exporter/idle': (agent: import('./service/exporter-manager').ExporterProcess) => void
        'exporter/working': (agent: import('./service/exporter-manager').ExporterProcess) => void
        'exporter/error': (agent: import('./service/exporter-manager').ExporterProcess) => void
    }
}

export type VoidReturn = Promise<any> | any;

export interface MCPLogDoc {
    _id: string;
    timestamp: number;
    level: 'info' | 'warn' | 'error' | 'debug';
    message: string;
    tool?: string;
    metadata?: Record<string, any>;
}

export interface MCPToolDoc {
    _id: string;
    name: string;
    description: string;
    server: string;
    callCount: number;
    lastCalled?: number;
    createdAt: number;
    metadata?: Record<string, any>;
}

export interface MCPServerDoc {
    _id: string;
    name: string;
    endpoint: string;
    status: 'online' | 'offline';
    toolCount: number;
    totalCalls: number;
    lastUpdate: number;
    createdAt: number;
    metadata?: Record<string, any>;
}

export interface VTuberAuthTokenDoc {
    _id: string;
    host: string;
    port: number;
    authToken: string;
    updatedAt: number;
    createdAt: number;
}

export interface WidgetConfigDoc {
    _id: string;
    widgetName: string;
    config: Record<string, any>;
    updatedAt: number;
    createdAt: number;
}

export interface CustomWidgetDoc {
    _id: string;
    widgetName: string; // 组件名称（唯一标识）
    displayName: string; // 显示名称
    type: 'image' | 'video' | 'audio'; // 组件类型
    group: string; // 分组名称
    mediaPath?: string; // 媒体文件路径（从 storage 选择）
    mediaUrl?: string; // 媒体文件 URL（上传的文件）
    config: Record<string, any>; // 其他配置（样式等）
    updatedAt: number;
    createdAt: number;
}

export interface EventConfigDoc {
    _id: string;
    sceneId: string; // 事件所属的场景 ID
    name: string;
    enabled: boolean;
    trigger: {
        field: string; // GSI 字段路径，如 "round.phase"
        operator: 'equals' | 'not_equals' | 'greater_than' | 'less_than' | 'contains';
        value: any;
    };
    actions: Array<{
        widgetName: string; // 组件名称
        effect: 'show' | 'hide' | 'toggle'; // 效果
        duration?: number; // 持续时间（秒），0 表示永久
    }>;
    updatedAt: number;
    createdAt: number;
}

export interface SceneConfigDoc {
    _id: string;
    name: string;
    active: boolean; // 是否激活（只有一个场景可以是激活状态）
    widgetDefaults?: Record<string, boolean>; // 组件默认状态配置，key为组件名称，value为默认可见性
    updatedAt: number;
    createdAt: number;
}

/** Per-player daily ELO: today's change = current ELO - start-of-day ELO */
export interface FaceitDailyEloDoc {
    _id: string; // playerId
    lastDate: string; // YYYY-MM-DD
    startOfDayElo: number; // ELO at start of day (or on first request)
    lastKnownElo: number; // last known current ELO
    updatedAt: number;
}

/** Exporter API provider */
export interface ExporterApiProviderDoc {
    _id: string;
    name: string;
    baseUrl: string;
    apiKey: string;
    enabled: boolean;
    source: 'config' | 'manual';
    lastSyncAt?: number;
    createdAt: number;
    updatedAt: number;
}

/** Exporter model synced from API provider */
export interface ExporterModelDoc {
    _id: string;
    providerId: string;
    modelId: string;
    label: string;
    series: string;
    opusModel: string;
    sonnetModel: string;
    haikuModel: string;
    enabled: boolean;
    createdAt: number;
    updatedAt: number;
}

/** Saved working directory for instance creation */
export interface ExporterWorkingDirDoc {
    _id: string;
    path: string;
    label: string;
    isDefault: boolean;
    createdAt: number;
}

/** Exporter session document stored in nedb */
export interface ExporterSessionDoc {
    _id: string;               // 数据库唯一 ID (nanoid UUID)
    exporterId: string;        // tmux session name (如 "tmux-claude-hydro-mimo")
    name: string;              // 用户自定义名称（默认 = tmux session 简化名）
    sessionName: string;       // Claude session 名（history.jsonl 的首条消息）
    model: string;             // 模型名
    workingDir: string;
    tmuxSession: string;       // 原始 tmux session name
    claudeSessionId: string;   // Claude sessionId
    startTime: number;
    endTime?: number;
    status: 'running' | 'stopped' | 'error';
    createdAt: number;
}