import { describe, expect, it } from 'vitest';
import { overwritesDetailedArc } from './handlers/plan.js';

describe('plan.volume arc overwrite guard', () => {
  const arcs = [
    { id: 'a0001', detail: 'detailed' as const },
    { id: 'a0002', detail: 'outline' as const },
  ];
  it('keeps detailed arcs from being replaced by an outline', () => {
    expect(overwritesDetailedArc('plan/arcs/a0001.yaml', arcs)).toBe(true);
  });
  it('allows outline arcs and new arcs through', () => {
    expect(overwritesDetailedArc('plan/arcs/a0002.yaml', arcs)).toBe(false);
    expect(overwritesDetailedArc('plan/arcs/a0003.yaml', arcs)).toBe(false);
    expect(overwritesDetailedArc('plan/obligations.yaml', arcs)).toBe(false);
  });
});
