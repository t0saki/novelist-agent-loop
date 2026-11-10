import { describe, expect, it } from 'vitest';
import { TASK_KINDS } from '@novelist/shared';
import { HANDLERS, UnknownTaskKindError, handlerFor, isKnownKind } from './registry.js';

describe('runtime registry', () => {
  it('HANDLERS keys are exactly TASK_KINDS, each handler declares its own kind', () => {
    expect(Object.keys(HANDLERS).sort()).toEqual([...TASK_KINDS].sort());
    expect([...TASK_KINDS].sort()).toEqual(['book.open', 'book.retro', 'book.write', 'publish']);
    for (const k of TASK_KINDS) expect(handlerFor(k).kind).toBe(k);
    // agent 任务 = 有 prepare；publish 是确定性任务
    expect(TASK_KINDS.filter((k) => HANDLERS[k].prepare !== undefined).sort()).toEqual(['book.open', 'book.retro', 'book.write']);
    expect(HANDLERS.publish.execute).toBeTypeOf('function');
  });

  it('a removed kind throws UnknownTaskKindError (rows of old kinds stay readable as strings)', () => {
    expect(() => handlerFor('chapter.extract')).toThrow(UnknownTaskKindError);
    try {
      handlerFor('harness.canary');
    } catch (e) {
      expect(e).toBeInstanceOf(UnknownTaskKindError);
      expect((e as UnknownTaskKindError).kind).toBe('harness.canary');
    }
  });

  it('isKnownKind', () => {
    expect(isKnownKind('book.write')).toBe(true);
    expect(isKnownKind('publish')).toBe(true);
    expect(isKnownKind('chapter.write')).toBe(false);
    expect(isKnownKind('import.bootstrap')).toBe(false);
    expect(isKnownKind('')).toBe(false);
  });
});
