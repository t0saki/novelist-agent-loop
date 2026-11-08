/**
 * book.yaml 的最小行级读写：只处理块式 mapping 的标量叶子，保留注释和未涉及的键。
 * 表单改动直接反映到 YAML 草稿，最终由服务端 schema 校验；碰到行内映射等形状就返回 null，让用户手改。
 */
const lead = (l: string) => l.length - l.trimStart().length;
const skip = (l: string) => l.trim() === '' || l.trimStart().startsWith('#');

function keyOf(line: string): string | null {
  const m = /^\s*([A-Za-z0-9_-]+)\s*:(?:\s|$)/.exec(line);
  return m ? (m[1] as string) : null;
}

function splitValue(line: string): { value: string; comment: string } {
  const colon = line.indexOf(':');
  const rest = line.slice(colon + 1);
  let quote: string | null = null;
  for (let i = 0; i < rest.length; i++) {
    const c = rest[i] as string;
    if (quote) {
      if (c === quote) quote = null;
    } else if (c === '"' || c === "'") quote = c;
    else if (c === '#' && (i === 0 || /\s/.test(rest[i - 1] as string))) return { value: rest.slice(0, i).trim(), comment: rest.slice(i) };
  }
  return { value: rest.trim(), comment: '' };
}

interface Block {
  start: number;
  end: number;
  /** 子项缩进；空块时为 null */
  indent: number | null;
}

function childBlock(lines: string[], keyLine: number): Block {
  const parent = lead(lines[keyLine] as string);
  let end = keyLine + 1;
  while (end < lines.length && (skip(lines[end] as string) || lead(lines[end] as string) > parent)) end++;
  while (end > keyLine + 1 && (lines[end - 1] as string).trim() === '') end--;
  let indent: number | null = null;
  for (let i = keyLine + 1; i < end; i++)
    if (!skip(lines[i] as string)) {
      indent = lead(lines[i] as string);
      break;
    }
  return { start: keyLine + 1, end, indent };
}

function rootBlock(lines: string[]): Block {
  let end = lines.length;
  while (end > 0 && (lines[end - 1] as string).trim() === '') end--;
  return { start: 0, end, indent: 0 };
}

function findKey(lines: string[], b: Block, key: string): number {
  if (b.indent === null) return -1;
  for (let i = b.start; i < b.end; i++) {
    const l = lines[i] as string;
    if (!skip(l) && lead(l) === b.indent && keyOf(l) === key) return i;
  }
  return -1;
}

function unquote(v: string): string {
  if (v.length >= 2 && ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'")))) return v.slice(1, -1);
  return v;
}

/** 块式标量序列（`- 1`）的条目；不是这种形状返回 null */
function seqItems(lines: string[], keyLine: number): string[] | null {
  const child = childBlock(lines, keyLine);
  if (child.indent === null) return null;
  const items: string[] = [];
  for (let i = child.start; i < child.end; i++) {
    const l = lines[i] as string;
    if (skip(l)) continue;
    const m = /^\s*-\s+(.+?)\s*$/.exec(l);
    if (!m || lead(l) !== child.indent) return null;
    items.push(unquote(m[1] as string));
  }
  return items.length ? items : null;
}

export function getYaml(raw: string, path: string[]): string | null {
  const lines = raw.split('\n');
  let block = rootBlock(lines);
  for (let i = 0; i < path.length; i++) {
    const at = findKey(lines, block, path[i] as string);
    if (at === -1) return null;
    if (i === path.length - 1) {
      const scalar = unquote(splitValue(lines[at] as string).value);
      if (scalar) return scalar;
      const items = seqItems(lines, at);
      return items ? `[${items.join(', ')}]` : null;
    }
    if (splitValue(lines[at] as string).value !== '') return null;
    block = childBlock(lines, at);
  }
  return null;
}

/** 写入（value=null 表示删除，并清掉因此变空的父键）。无法安全修改时返回 null。 */
export function setYaml(raw: string, path: string[], value: string | null): string | null {
  const lines = raw.split('\n');
  let block = rootBlock(lines);
  const trail: number[] = [];
  for (let i = 0; i < path.length; i++) {
    const key = path[i] as string;
    const at = findKey(lines, block, key);
    if (at === -1) {
      if (value === null) return raw;
      const parentIndent = i === 0 ? -2 : lead(lines[trail[i - 1] as number] as string);
      const indent = block.indent ?? parentIndent + 2;
      const add = path.slice(i).map((k, j) => `${' '.repeat(indent + 2 * j)}${k}:${j === path.length - i - 1 ? ` ${value}` : ''}`);
      lines.splice(block.end, 0, ...add);
      return lines.join('\n');
    }
    trail.push(at);
    if (i === path.length - 1) {
      const line = lines[at] as string;
      const child = childBlock(lines, at);
      // 目标其实是个块（有子项）：块式序列可以整体换成行内值，其余不当作标量覆盖
      if (child.indent !== null && child.indent > lead(line)) {
        if (!seqItems(lines, at)) return null;
        lines.splice(child.start, child.end - child.start);
      }
      if (value === null) {
        lines.splice(at, 1);
        for (let d = trail.length - 2; d >= 0; d--) {
          const parent = trail[d] as number;
          if (childBlock(lines, parent).indent !== null) break;
          lines.splice(parent, 1);
        }
        return lines.join('\n');
      }
      const { comment } = splitValue(line);
      lines[at] = `${' '.repeat(lead(line))}${key}: ${value}${comment ? ` ${comment}` : ''}`;
      return lines.join('\n');
    }
    if (splitValue(lines[at] as string).value !== '') return null;
    block = childBlock(lines, at);
  }
  return null;
}

export function parseRange(v: string | null): [number, number] | null {
  const m = v ? /^\[\s*(-?\d+)\s*,\s*(-?\d+)\s*\]$/.exec(v) : null;
  return m ? [Number(m[1]), Number(m[2])] : null;
}
