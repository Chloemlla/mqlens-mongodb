import { describe, it, expect } from 'vitest';
import { scaleEditorFontSize } from '../ui-scale';

// jsdom reports devicePixelRatio 1 and a small viewport, so computeAutoDpiScale()
// is 1 — the numbers below isolate the user's font-size and zoom settings.
describe('scaleEditorFontSize', () => {
  it('leaves a size unchanged at the 13px design baseline and zoom 1', () => {
    expect(scaleEditorFontSize(11.5, 13, 1)).toBe(11.5);
    expect(scaleEditorFontSize(13, 13, 1)).toBe(13);
  });

  it('scales with the interface font-size setting', () => {
    // 16/13 of 13px ≈ 16
    expect(scaleEditorFontSize(13, 16, 1)).toBeCloseTo(16, 1);
    // and proportionally for a smaller editor size
    expect(scaleEditorFontSize(11.5, 16, 1)).toBeCloseTo(14.2, 1);
  });

  it('scales with the user zoom', () => {
    expect(scaleEditorFontSize(13, 13, 1.5)).toBeCloseTo(19.5, 1);
    expect(scaleEditorFontSize(13, 13, 0.75)).toBeCloseTo(9.8, 1);
  });

  it('combines font-size and zoom', () => {
    expect(scaleEditorFontSize(13, 16, 1.25)).toBeCloseTo(20, 1);
  });

  it('clamps zoom to the supported range rather than trusting bad input', () => {
    expect(scaleEditorFontSize(13, 13, 99)).toBe(scaleEditorFontSize(13, 13, 1.5));
    expect(scaleEditorFontSize(13, 13, 0.1)).toBe(scaleEditorFontSize(13, 13, 0.75));
  });
});
