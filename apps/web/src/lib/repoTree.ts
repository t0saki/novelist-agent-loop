import type { RepoEntry } from '@novelist/shared';

export interface TreeNode {
  name: string;
  path: string;
  type: 'file' | 'dir';
  entry: RepoEntry | null;
}

/** dir 的直接子项。兼容服务端返回单层或递归列表；递归列表里只有文件时补出隐含目录。 */
export function childrenOf(entries: RepoEntry[], dir: string): TreeNode[] {
  const prefix = dir ? `${dir.replace(/\/$/, '')}/` : '';
  const out = new Map<string, TreeNode>();
  for (const e of entries) {
    const p = e.path.replace(/\/$/, '');
    if (!p.startsWith(prefix) || p === dir) continue;
    const rest = p.slice(prefix.length);
    const slash = rest.indexOf('/');
    if (slash === -1) out.set(rest, { name: rest, path: p, type: e.type, entry: e });
    else {
      const name = rest.slice(0, slash);
      if (!out.has(name)) out.set(name, { name, path: prefix + name, type: 'dir', entry: null });
    }
  }
  return [...out.values()].sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name, 'zh-CN') : a.type === 'dir' ? -1 : 1));
}
