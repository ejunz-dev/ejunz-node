import path from 'node:path';
import { Context, Service } from 'cordis';
import Datastore from 'nedb-promises';
import {
    MCPLogDoc, MCPServerDoc, MCPToolDoc, VTuberAuthTokenDoc, WidgetConfigDoc, EventConfigDoc, SceneConfigDoc, CustomWidgetDoc, FaceitDailyEloDoc,
    ExporterSessionDoc, ExporterApiProviderDoc, ExporterModelDoc, ExporterWorkingDirDoc,
} from '../interface';
import { fs } from '../utils';

export interface Collections {
    mcplog: MCPLogDoc;
    mcpserver: MCPServerDoc;
    mcptool: MCPToolDoc;
    vtuberAuthToken: VTuberAuthTokenDoc;
    widgetConfig: WidgetConfigDoc;
    eventConfig: EventConfigDoc;
    sceneConfig: SceneConfigDoc;
    customWidget: CustomWidgetDoc;
    faceitDailyElo: FaceitDailyEloDoc;
    exportersession: ExporterSessionDoc;
    exporterapiprovider: ExporterApiProviderDoc;
    exportermodel: ExporterModelDoc;
    exporterworkingdir: ExporterWorkingDirDoc;
}

declare module 'cordis' {
    interface Context {
        dbservice: DBService;
        db: DBService['db'];
    }
}

export default class DBService extends Service {
    constructor(ctx: Context) {
        fs.ensureDirSync(path.resolve(process.cwd(), 'data/.db'));
        super(ctx, 'dbservice');
        ctx.mixin('dbservice', ['db']);
    }

    db: { [T in keyof Collections]: Datastore<Collections[T]> } = {} as any;

    async initDatabase(key: string, fields: string[]) {
        this.db[key] = Datastore.create(path.resolve(process.cwd(), `data/.db/${key}.db`));
        await this.db[key].load();
        // eslint-disable-next-line no-await-in-loop
        for (const field of fields) await this.db[key].ensureIndex({ fieldName: field });
        this.ctx.logger('db').info(`${key} Database loaded`);
    }

    async [Service.init]() {
        await this.initDatabase('mcplog', ['_id', 'timestamp', 'level', 'tool']);
        await this.initDatabase('mcpserver', ['_id', 'name', 'endpoint', 'status', 'lastUpdate']);
        await this.initDatabase('mcptool', ['_id', 'name', 'server', 'callCount']);
        await this.initDatabase('vtuberAuthToken', ['_id', 'host', 'port']);
        await this.initDatabase('widgetConfig', ['_id', 'widgetName', 'updatedAt']);
        await this.initDatabase('eventConfig', ['_id', 'sceneId', 'enabled', 'updatedAt']);
        await this.initDatabase('sceneConfig', ['_id', 'active', 'updatedAt']);
        await this.initDatabase('customWidget', ['_id', 'widgetName', 'type', 'group', 'updatedAt']);
        await this.initDatabase('faceitDailyElo', ['_id', 'lastDate', 'updatedAt']);
        await this.initDatabase('exportersession', ['_id', 'exporterId', 'startTime', 'status']);
        await this.initDatabase('exporterapiprovider', ['_id', 'name', 'enabled', 'updatedAt']);
        await this.initDatabase('exportermodel', ['_id', 'providerId', 'modelId', 'enabled', 'updatedAt']);
        await this.initDatabase('exporterworkingdir', ['_id', 'path', 'isDefault']);
    }
}
