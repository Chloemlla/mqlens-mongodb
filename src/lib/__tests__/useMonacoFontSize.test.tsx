import { describe, it, expect, vi } from 'vitest';
import { renderHook } from '@testing-library/react';

const themeConfig = { fontSize: 13, uiZoom: 1 };
vi.mock('@/hooks/use-theme', () => ({
  useThemeOptional: () => ({ config: themeConfig, resolvedMode: 'dark' as const }),
  useTheme: () => ({ config: themeConfig, resolvedMode: 'dark' as const }),
}));

import { useMonacoFontSize } from '../useMonacoTheme';

describe('useMonacoFontSize', () => {
  it('returns the design size at default settings', () => {
    themeConfig.fontSize = 13;
    themeConfig.uiZoom = 1;
    const { result } = renderHook(() => useMonacoFontSize(11.5));
    expect(result.current).toBe(11.5);
  });

  it('grows with the interface font-size setting', () => {
    themeConfig.fontSize = 16;
    themeConfig.uiZoom = 1;
    const { result } = renderHook(() => useMonacoFontSize(11.5));
    expect(result.current).toBeGreaterThan(11.5);
    expect(result.current).toBeCloseTo(14.2, 1);
  });

  it('grows with the interface zoom', () => {
    themeConfig.fontSize = 13;
    themeConfig.uiZoom = 1.5;
    const { result } = renderHook(() => useMonacoFontSize(13));
    expect(result.current).toBeCloseTo(19.5, 1);
  });
});
