/** 进程级依赖容器（main.ts 组装，API / CLI 使用）。Owner: lane G。 */
import type { AppConfig, DataPaths } from './config/index.js';
import type { Db, DbHandle } from './db/client.js';
import type { Logger } from './log.js';
import type { SecretStore } from './services/secrets.js';
import type { Orchestrator } from './orchestrator/index.js';
import type { EventBus } from './orchestrator/bus.js';
import type { LoginManager } from './harness/login.js';

export interface AppDeps {
  config: AppConfig;
  paths: DataPaths;
  dbh: DbHandle;
  db: Db;
  log: Logger;
  bus: EventBus;
  secrets: SecretStore;
  orchestrator: Orchestrator;
  logins: LoginManager;
  /** 主密钥来源（doctor 展示） */
  masterKeySource: 'env' | 'file' | 'generated';
  startedAt: Date;
}
