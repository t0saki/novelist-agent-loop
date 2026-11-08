/** 发布配置校验（cron / 时区 / lag 与 max_buffer 的关系）：写错会让定时发布静默停止或生产发布互等，保存时就拒绝。Owner: lane G。 */
import { Cron } from 'croner';
import type { PublishConfig } from '@novelist/shared';
import { HttpProblem } from '../api/problem.js';

export function assertPublishConfig(cfg: PublishConfig): void {
  try {
    new Cron(cfg.cadence, { timezone: cfg.timezone }).nextRun();
  } catch (e) {
    throw new HttpProblem(400, 'invalid_publish', `发布节奏或时区无效：${(e as Error).message}`);
  }
  if (cfg.resume_buffer >= cfg.max_buffer) throw new HttpProblem(400, 'invalid_publish', 'resume_buffer 必须小于 max_buffer');
  const lag = cfg.lag === 'auto' ? cfg.min_lag : Math.max(cfg.lag, cfg.min_lag);
  if (cfg.mode === 'scheduled' && lag >= cfg.max_buffer) throw new HttpProblem(400, 'invalid_publish', `发布滞后（lag=${lag}）必须小于 max_buffer（${cfg.max_buffer}），否则存稿永远到不了可发布的量`);
}
