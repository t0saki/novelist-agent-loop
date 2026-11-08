/**
 * custom_api 账号的真实连通探测：用账号的 base_url 与 key 发一个 GET 模型列表（不产生模型调用费用）。
 * 结果只出 detail 文本，绝不回显 key。harness 没有可探测的端点时明确标注“仅校验配置”。
 */
import type { HarnessId } from '@novelist/shared';

export const CONFIG_ONLY_LABEL = '仅校验配置，未实际连通';
const TIMEOUT_MS = 8000;

export type ConnectivityResult =
  | { kind: 'verified'; ok: true; detail: string; models: string[] }
  | { kind: 'reachable'; ok: true; detail: string; models: [] }
  | { kind: 'failed'; ok: false; detail: string; models: [] }
  | { kind: 'config_only'; ok: true; detail: string; models: [] };

interface ProbeTarget {
  url: string;
  headers: Record<string, string>;
}

const joinUrl = (base: string, path: string) => `${base.replace(/\/+$/, '')}${path}`;

/** 每个 harness 的 custom_api 环境变量 → 模型列表端点；无法确定端点时返回 null */
export function probeTarget(harness: HarnessId, env: Record<string, string>): ProbeTarget | null {
  if (harness === 'claude-code' && env.ANTHROPIC_BASE_URL) {
    const headers: Record<string, string> = { 'anthropic-version': '2023-06-01' };
    if (env.ANTHROPIC_API_KEY) headers['x-api-key'] = env.ANTHROPIC_API_KEY;
    if (env.ANTHROPIC_AUTH_TOKEN) headers.authorization = `Bearer ${env.ANTHROPIC_AUTH_TOKEN}`;
    return { url: joinUrl(env.ANTHROPIC_BASE_URL, '/v1/models'), headers };
  }
  if (harness === 'codex' && env.OPENAI_BASE_URL) {
    return { url: joinUrl(env.OPENAI_BASE_URL, '/models'), headers: env.OPENAI_API_KEY ? { authorization: `Bearer ${env.OPENAI_API_KEY}` } : {} };
  }
  if (harness === 'agy' && env.GOOGLE_GEMINI_BASE_URL) {
    return { url: joinUrl(env.GOOGLE_GEMINI_BASE_URL, '/v1beta/models'), headers: env.GEMINI_API_KEY ? { 'x-goog-api-key': env.GEMINI_API_KEY } : {} };
  }
  return null;
}

function modelsFrom(body: unknown): string[] {
  const o = body as { data?: { id?: unknown }[]; models?: { name?: unknown; id?: unknown }[] } | null;
  const raw = [...(o?.data ?? []).map((m) => m.id), ...(o?.models ?? []).map((m) => m.id ?? m.name)];
  return raw.filter((m): m is string => typeof m === 'string' && m.length > 0).map((m) => m.replace(/^models\//, ''));
}

/** 发最小真实请求：2xx=已连通；401/403=密钥被拒；404 等=有响应但没有可用的列表接口（不声称已验证密钥） */
export async function probeCustomApi(harness: HarnessId, env: Record<string, string>): Promise<ConnectivityResult> {
  const target = probeTarget(harness, env);
  if (!target) return { kind: 'config_only', ok: true, detail: `${CONFIG_ONLY_LABEL}（该 harness 没有可探测的网关地址）`, models: [] };
  try {
    const res = await fetch(target.url, { method: 'GET', headers: target.headers, redirect: 'manual', signal: AbortSignal.timeout(TIMEOUT_MS) });
    const where = new URL(target.url).host;
    if (res.ok) {
      const models = modelsFrom(await res.json().catch(() => null));
      return { kind: 'verified', ok: true, detail: `网关已连通，密钥被接受（${where}，HTTP ${res.status}）`, models };
    }
    if (res.status === 401 || res.status === 403) return { kind: 'failed', ok: false, detail: `网关拒绝了密钥（${where}，HTTP ${res.status}）`, models: [] };
    if (res.status >= 500) return { kind: 'failed', ok: false, detail: `网关错误（${where}，HTTP ${res.status}）`, models: [] };
    return { kind: 'reachable', ok: true, detail: `网关有响应（${where}，HTTP ${res.status}），但没有可用的模型列表接口，未能验证密钥`, models: [] };
  } catch (e) {
    const cause = (e as { cause?: { code?: string; message?: string } }).cause;
    const reason = (e as Error).name === 'TimeoutError' ? `超过 ${TIMEOUT_MS / 1000} 秒无响应` : (cause?.code ?? cause?.message ?? (e as Error).message);
    return { kind: 'failed', ok: false, detail: `无法连接网关：${reason}`, models: [] };
  }
}
