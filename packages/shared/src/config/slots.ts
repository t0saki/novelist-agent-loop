/**
 * 路由位置（DESIGN §7）：只有“写作用的模型”和“杂活用的模型”两个位置，每个位置主、备各一个 profile。
 * 存在 settings 'routing.slots'。备用不限制同模型；默认不配备用，主用不可用时就等。
 */
import { z } from 'zod';
import type { Capabilities } from '../harness.js';
import type { Profile } from './routing.js';

export const SLOT_IDS = ['writer', 'utility'] as const;
export type SlotId = (typeof SLOT_IDS)[number];

export const zSlot = z.object({ primary: z.string().nullable().default(null), fallback: z.string().nullable().default(null) });
export type Slot = z.infer<typeof zSlot>;

export const zRoutingSlots = z.object({
  schema: z.literal('nv.slots/1').default('nv.slots/1'),
  writer: zSlot.default({ primary: null, fallback: null }),
  utility: zSlot.default({ primary: null, fallback: null }),
  /** 开机迁移从哪个旧 preset 换算来的（只用于显示） */
  migratedFrom: z.string().optional(),
  /** 开机迁移时旧 preset 里已经不存在的 profile（被丢掉了；只用于显示） */
  droppedProfiles: z.array(z.string()).default([]),
});
export type RoutingSlots = z.infer<typeof zRoutingSlots>;

export interface SlotStatus {
  slot: SlotId;
  profile: string | null;
  account: string | null;
  harness: string | null;
  model: string | null;
  usedFallback: boolean;
  waitUntil: string | null;
  reason: string | null;
}

/** `forced` 不存库：就是运行中进程的 config.fakeHarness（fake 模式两个位置都走 fake，忽略书级覆盖） */
export interface RoutingSlotsView {
  slots: RoutingSlots;
  forced: boolean;
  status: Record<SlotId, SlotStatus>;
  profiles: Profile[];
}

export const zPutRoutingSlots = z.object({ writer: zSlot, utility: zSlot });
export type PutRoutingSlots = z.infer<typeof zPutRoutingSlots>;

/** 目录探测（canary）的结果：在一个临时书房里按 ORDER.md 写 canary.txt，并带上 AGENTS.md 里的暗号 */
export interface CanaryResult {
  ok: boolean;
  steps: Capabilities['probeSteps'];
  /** 写出了 canary.txt 且第一行是标记 */
  wroteFile: boolean;
  /** canary.txt 里有 AGENTS.md 的暗号（指令文件确实被读到） */
  honouredAgents: boolean;
  toolSteps: number;
}

export interface SlotCanaryResult {
  status: SlotStatus;
  caps: Capabilities;
  result: CanaryResult;
}
