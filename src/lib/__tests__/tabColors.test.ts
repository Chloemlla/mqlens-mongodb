import { describe, expect, it, vi } from 'vitest';
import { loadTabColors, saveTabColor, TAB_COLORS } from '../tabColors';

describe('tab colors', () => {
  it('offers exactly seven subdued colors', () => {
    expect(TAB_COLORS).toHaveLength(7);
    expect(TAB_COLORS.every(color => color.saturation <= 50)).toBe(true);
  });

  it('persists a color by stable tab id and can reset it', () => {
    const storage = { getItem: vi.fn<() => string | null>(() => null), setItem: vi.fn() };
    saveTabColor('collection.profile:one.main.rates', 'blue', storage);
    expect(storage.setItem).toHaveBeenLastCalledWith(
      'mqlens-tab-colors',
      JSON.stringify({ 'collection.profile:one.main.rates': 'blue' }),
    );

    storage.getItem.mockReturnValue(JSON.stringify({ 'collection.profile:one.main.rates': 'blue' }));
    saveTabColor('collection.profile:one.main.rates', undefined, storage);
    expect(storage.setItem).toHaveBeenLastCalledWith('mqlens-tab-colors', '{}');
  });

  it('ignores malformed storage and unknown colors', () => {
    expect(loadTabColors({ getItem: () => '{bad', setItem: vi.fn() })).toEqual({});
    expect(loadTabColors({
      getItem: () => JSON.stringify({ good: 'green', bad: 'neon' }),
      setItem: vi.fn(),
    })).toEqual({ good: 'green' });
  });
});
