import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ArtifactDecl } from '@novelist/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { checkTruncation, runContractGates } from './contract.js';

let out: string;
beforeEach(async () => {
  out = await fs.mkdtemp(path.join(os.tmpdir(), 'nv-contract-'));
});
afterEach(async () => {
  await fs.rm(out, { recursive: true, force: true });
});

const write = async (rel: string, content: string | Buffer) => {
  await fs.mkdir(path.dirname(path.join(out, rel)), { recursive: true });
  await fs.writeFile(path.join(out, rel), content);
};
const receipt = JSON.stringify({ schema: 'nv.receipt/1', status: 'done', artifacts: [] });
const draftDecl: ArtifactDecl = { path: 'draft.md', kind: 'chapter_draft', required: true };
const failed = (r: Awaited<ReturnType<typeof runContractGates>>) => r.results.filter((x) => !x.ok).map((x) => x.rule);

describe('runContractGates', () => {
  it('passes declared, well-formed artifacts and parses JSON', async () => {
    await write('receipt.json', receipt);
    await write('draft.md', '他转身离开了青云山。\n');
    await write('delta.json', JSON.stringify({ schema: 'nv.delta/1', chapter: 'c00001' }));
    const r = await runContractGates({ outDir: out, artifacts: [draftDecl, { path: 'delta.json', kind: 'delta', required: true }] });
    expect(r.ok).toBe(true);
    expect(r.receipt?.status).toBe('done');
    expect(r.files['delta.json']?.json).toMatchObject({ ops: [] });
    expect(r.results.every((x) => x.family === 'contract' && x.level === 'hard' && x.source === 'novelist')).toBe(true);
  });

  it('flags missing artifacts, extra files and missing receipt', async () => {
    await write('stray.txt', 'x');
    const r = await runContractGates({ outDir: out, artifacts: [draftDecl] });
    expect(r.ok).toBe(false);
    expect(r.extraFiles).toEqual(['stray.txt']);
    expect(failed(r)).toEqual(expect.arrayContaining(['contract.path', 'contract.artifacts_exact', 'contract.receipt']));
  });

  it('rejects non-UTF-8, empty and schema-invalid artifacts', async () => {
    await write('receipt.json', receipt);
    await write('draft.md', Buffer.from([0xe6, 0x88]));
    await write('delta.json', JSON.stringify({ schema: 'nv.delta/1', chapter: 'bad' }));
    await write('review.json', '   \n');
    const r = await runContractGates({
      outDir: out,
      artifacts: [draftDecl, { path: 'delta.json', kind: 'delta', required: true }, { path: 'review.json', kind: 'review', required: true }],
    });
    expect(failed(r)).toEqual(expect.arrayContaining(['contract.utf8', 'contract.schema', 'contract.nonempty']));
  });

  it('handles glob declarations with min/max and detects truncation', async () => {
    await write('receipt.json', receipt);
    await write('cards/c00001.yaml', 'a: 1\n');
    await write('cards/c00002.yaml', 'a: 2\n');
    await write('draft.md', '他说：“我这就');
    const r = await runContractGates({
      outDir: out,
      artifacts: [draftDecl, { path: 'cards/c*.yaml', kind: 'yaml', required: true, max: 1 }],
    });
    expect(failed(r)).toEqual(expect.arrayContaining(['contract.truncation', 'contract.artifacts_exact']));
  });

  it('accepts hyphenated declared paths', async () => {
    await write('receipt.json', receipt);
    await write('arc-notes/my-card.yaml', 'a: 1\n');
    const r = await runContractGates({ outDir: out, artifacts: [{ path: 'arc-notes/my-card.yaml', kind: 'yaml', required: true }] });
    expect(r.ok).toBe(true);
  });

  it('refuses symlinks as artifacts', async () => {
    await write('receipt.json', receipt);
    await fs.symlink('/etc/hostname', path.join(out, 'draft.md'));
    const r = await runContractGates({ outDir: out, artifacts: [draftDecl] });
    expect(failed(r)).toContain('contract.path');
  });

  it('checks receipt.task_id when asked', async () => {
    await write('receipt.json', JSON.stringify({ schema: 'nv.receipt/1', status: 'done', task_id: 'other' }));
    const r = await runContractGates({ outDir: out, artifacts: [], taskId: 'expected' });
    expect(failed(r)).toEqual(['contract.receipt']);
  });
});

describe('checkTruncation', () => {
  it('accepts complete prose, closing quotes and beat markers', () => {
    expect(checkTruncation('他走了。').ok).toBe(true);
    expect(checkTruncation('“我走了！”').ok).toBe(true);
    expect(checkTruncation('他走了……\n<!-- beat:b4 -->\n').ok).toBe(true);
  });
  it('rejects mid-sentence endings, unclosed quotes and replacement chars', () => {
    expect(checkTruncation('他走了，然后').ok).toBe(false);
    expect(checkTruncation('他说：“我走了').ok).toBe(false);
    expect(checkTruncation('他走了。�').ok).toBe(false);
  });
  it('only checks structure when sentence=false', () => {
    expect(checkTruncation('- 列表项', { sentence: false }).ok).toBe(true);
    expect(checkTruncation('“未闭合', { sentence: false }).ok).toBe(false);
  });
});
