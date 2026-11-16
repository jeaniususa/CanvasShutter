import { describe, expect, it } from 'vitest';
import { newId } from '../src/library/library';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe('newId', () => {
  it('makes a random id', () => {
    expect(newId()).toMatch(UUID);
    expect(newId()).not.toBe(newId());
  });
  it('still works where randomUUID is missing (plain http pages)', () => {
    Object.defineProperty(crypto, 'randomUUID', { value: undefined, configurable: true }); // hides the real one
    try {
      expect(typeof crypto.randomUUID).toBe('undefined');
      expect(newId()).toMatch(UUID);
      expect(newId()).not.toBe(newId());
    } finally {
      delete (crypto as { randomUUID?: unknown }).randomUUID; // the real one shows again
    }
  });
});
