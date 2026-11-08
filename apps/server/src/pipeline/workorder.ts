/**
 * 工作单渲染（DESIGN §3.5、§6.3）。Owner: lane E。
 * 文件 = '---\n' + YAML(nv.workorder/1 frontmatter) + '---\n' + 中文正文。默认上限 65k 汉字（settings.workOrderMaxCjk）。
 * 正文模板在 pipeline/templates/<kind>.md（中文，内置；用户的 instructions/tasks/<kind>.md 属于作者层，进 system channel，不进这里）。
 * 评审建议须标注“评审建议（优先级低于作者指令）”。
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { parse as yamlParse, stringify as yamlStringify } from 'yaml';
import type { WorkOrderFrontmatter } from '@novelist/shared';
import { zWorkOrderFrontmatter } from '@novelist/shared';

export function renderWorkOrder(fm: WorkOrderFrontmatter, body: string): string {
  const parsed = zWorkOrderFrontmatter.parse(fm);
  return `---\n${yamlStringify(parsed, { lineWidth: 0 })}---\n\n${body.replace(/^\s+/, '')}${body.endsWith('\n') ? '' : '\n'}`;
}

export function parseWorkOrder(text: string): { frontmatter: WorkOrderFrontmatter; body: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  if (!m) throw new Error('work order: 缺少 frontmatter');
  const frontmatter = zWorkOrderFrontmatter.parse(yamlParse(m[1] ?? ''));
  return { frontmatter, body: (m[2] ?? '').replace(/^\n+/, '') };
}

export const TEMPLATES_DIR = new URL('./templates/', import.meta.url).pathname;

const cache = new Map<string, string>();

async function readTemplate(kind: string): Promise<string> {
  const hit = cache.get(kind);
  if (hit !== undefined) return hit;
  if (!/^[a-z0-9_.-]+$/.test(kind)) throw new Error(`非法模板名：${kind}`);
  const text = await fs.readFile(path.join(TEMPLATES_DIR, `${kind}.md`), 'utf8');
  cache.set(kind, text);
  return text;
}

/**
 * 读取内置模板并做 {{var}} 替换：单次扫描（模板自己的占位符），被插入的值（用户文本）不再展开，也不做任何改写。
 * 模板引用了未提供的变量时抛错（工单缺项不能静默）。
 */
export async function renderTemplate(kind: string, vars: Record<string, string>): Promise<string> {
  const tpl = await readTemplate(kind);
  return tpl.replace(/\{\{([a-z0-9_]+)\}\}/g, (_m, name: string) => {
    const v = vars[name];
    if (v === undefined) throw new Error(`模板 ${kind} 缺少变量 ${name}`);
    return v;
  });
}
