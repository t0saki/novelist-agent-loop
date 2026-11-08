/** 归一化 harness 事件（DESIGN §3.2）。run_events.body 存这个；SSE run_event 推这个。 */
import { z } from 'zod';
import { zErrorClass } from './enums.js';

const base = { seq: z.number().int().nonnegative(), ts: z.string(), runId: z.string() };
export const TOOL_KINDS = ['read', 'write', 'edit', 'search', 'list', 'exec', 'mcp', 'subagent', 'web', 'other'] as const;

export const zNEvent = z.discriminatedUnion('t', [
  z.object({
    ...base,
    t: z.literal('init'),
    sessionId: z.string().optional(),
    model: z.string().optional(),
    version: z.string().optional(),
    tools: z.array(z.string()).optional(),
    memoryPaths: z.array(z.string()).optional(),
    mcp: z.array(z.object({ name: z.string(), ok: z.boolean() })).optional(),
    authSource: z.string().optional(),
  }),
  z.object({ ...base, t: z.literal('text'), channel: z.enum(['assistant', 'thinking']), delta: z.string() }),
  z.object({
    ...base,
    t: z.literal('tool_call'),
    id: z.string(),
    name: z.string(),
    kind: z.enum(TOOL_KINDS),
    paths: z.array(z.string()).optional(),
    command: z.string().optional(),
  }),
  z.object({ ...base, t: z.literal('tool_result'), id: z.string(), ok: z.boolean(), error: z.string().optional() }),
  z.object({ ...base, t: z.literal('file_change'), path: z.string(), op: z.enum(['add', 'update', 'delete']), ok: z.boolean() }),
  z.object({
    ...base,
    t: z.literal('usage'),
    input: z.number(),
    cachedInput: z.number().optional(),
    cacheWrite: z.number().optional(),
    output: z.number(),
    reasoning: z.number().optional(),
    costUsd: z.number().optional(),
    costSource: z.enum(['harness', 'computed', 'unknown']),
    scope: z.enum(['delta', 'total']),
  }),
  z.object({
    ...base,
    t: z.literal('rate_limit'),
    window: z.enum(['5h', '7d', 'daily', 'minute', 'other']),
    utilization: z.number().optional(),
    resetsAt: z.string().optional(),
    status: z.enum(['allowed', 'warning', 'rejected']),
  }),
  z.object({ ...base, t: z.literal('retry'), attempt: z.number().int(), delayMs: z.number().optional(), cls: zErrorClass }),
  z.object({ ...base, t: z.literal('compaction') }),
  z.object({ ...base, t: z.literal('denial'), tool: z.string(), path: z.string().optional(), detail: z.string().optional() }),
  z.object({ ...base, t: z.literal('subagent'), id: z.string(), phase: z.enum(['start', 'stop']), role: z.string().optional() }),
  z.object({ ...base, t: z.literal('error'), cls: zErrorClass, message: z.string(), retryable: z.boolean() }),
  z.object({
    ...base,
    t: z.literal('result'),
    status: z.enum(['success', 'error', 'max_turns', 'refusal', 'cancelled', 'timeout']),
    stopReason: z.string().optional(),
    sessionId: z.string().optional(),
    structured: z.unknown().optional(),
    turns: z.number().int().optional(),
    text: z.string().optional(),
  }),
  z.object({ ...base, t: z.literal('unknown'), rawType: z.string() }),
  z.object({ ...base, t: z.literal('heartbeat'), source: z.enum(['stdout', 'stderr', 'partial']) }),
]);
export type NEvent = z.infer<typeof zNEvent>;
export type NEventType = NEvent['t'];
/** parser 产出事件时尚未分配 seq/ts/runId（由 runner 统一补齐） */
export type NEventBody = NEvent extends infer E ? (E extends NEvent ? Omit<E, 'seq' | 'ts' | 'runId'> : never) : never;
