/** 发布配置校验（cron / 时区 / lag 与 max_buffer 的关系）：写错会让定时发布静默停止或生产发布互等，保存时就拒绝。Owner: lane G。 */
import { Cron } from 'croner';
import type { PublishConfig } from '@novelist/shared';
import { HttpProblem } from '../api/problem.js';

/**
 * v3 书另传 { batch }：存稿上限必须 ≥ 2 × 每批章数（docs/v3/DESIGN.md §3.4），否则存稿上限和批次边界互等，一批要等上一天才能发。
 * 旧流程不传，校验和原来一样。
 */
export function assertPublishConfig(cfg: PublishConfig, v3?: { batch: number }): void {
  try {
    new Cron(cfg.cadence, { timezone: cfg.timezone }).nextRun();
  } catch (e) {
    throw new HttpProblem(400, 'invalid_publish', `发布节奏或时区无效：${(e as Error).message}`);
  }
  if (cfg.resume_buffer >= cfg.max_buffer) throw new HttpProblem(400, 'invalid_publish', 'resume_buffer 必须小于 max_buffer');
  const lag = cfg.lag === 'auto' ? cfg.min_lag : Math.max(cfg.lag, cfg.min_lag);
  if (cfg.mode === 'scheduled' && lag >= cfg.max_buffer) throw new HttpProblem(400, 'invalid_publish', `发布滞后（lag=${lag}）必须小于 max_buffer（${cfg.max_buffer}），否则存稿永远到不了可发布的量`);
  if (v3 && cfg.max_buffer < 2 * v3.batch) throw new HttpProblem(400, 'invalid_publish', `存稿上限（max_buffer=${cfg.max_buffer}）必须 ≥ 2 × 每批章数（v3.batch=${v3.batch}）`);
}
