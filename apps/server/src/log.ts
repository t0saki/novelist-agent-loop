/** 日志（pino）。Owner: lane G。所有模块收 Logger 参数，不自行创建。 */
import { pino, type Logger as PinoLogger } from 'pino';
export type Logger = PinoLogger;

export function createLogger(level: string = 'info', bindings: Record<string, unknown> = {}): Logger {
  return pino({ level, base: { svc: 'novelist', ...bindings }, redact: ['*.secretEnv', '*.ANTHROPIC_API_KEY', '*.ANTHROPIC_AUTH_TOKEN', '*.CLAUDE_CODE_OAUTH_TOKEN'] });
}

/** 测试用静默 logger */
export const silentLogger: Logger = pino({ level: 'silent' });
