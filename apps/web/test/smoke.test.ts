import { describe, expect, it } from 'vitest';
import { ROUTES } from '@novelist/shared';

describe('web smoke', () => {
  it('shares the API route table with the server', () => {
    expect(ROUTES.some((r) => r.path === '/api/reader/books')).toBe(true);
  });
});
