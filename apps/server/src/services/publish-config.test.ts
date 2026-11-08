import { describe, expect, it } from 'vitest';
import { zPublishConfig } from '@novelist/shared';
import { assertPublishConfig } from './publish-config.js';

const base = zPublishConfig.parse({});

describe('assertPublishConfig', () => {
  it('默认配置通过', () => {
    expect(() => assertPublishConfig(base)).not.toThrow();
  });

  it('错误的 cron 和时区都在保存时拒绝', () => {
    expect(() => assertPublishConfig({ ...base, cadence: 'not a cron' })).toThrow(/发布节奏或时区无效/);
    expect(() => assertPublishConfig({ ...base, timezone: 'Mars/Olympus' })).toThrow(/发布节奏或时区无效/);
  });
});
