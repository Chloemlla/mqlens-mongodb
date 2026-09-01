import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { lagClass, memberDotClass } from '../clusterHealth';

// #282: status colours written as fixed Tailwind palette shades ignore the
// theme entirely — `text-amber-500` renders the same on mqlens-dark,
// high-contrast and solarized-light, because nothing about it is theme-aware.
// The token equivalents (`warning`, `success`, `destructive`) are defined per
// preset and per mode, so they follow whatever the user picked.
describe('status colours use theme tokens (#282)', () => {
  it('grades replica lag with tokens', () => {
    expect(lagClass(120)).toContain('text-destructive');
    expect(lagClass(30)).toContain('text-warning');
    expect(lagClass(1)).toContain('text-muted-foreground');
  });

  it('grades member health with tokens', () => {
    expect(memberDotClass({ health: 0, stateStr: 'DOWN' })).toBe('bg-destructive');
    expect(memberDotClass({ health: 1, stateStr: 'PRIMARY' })).toBe('bg-success');
    expect(memberDotClass({ health: 1, stateStr: 'SECONDARY' })).toBe('bg-chart-1');
    expect(memberDotClass({ health: 1, stateStr: 'STARTUP2' })).toBe('bg-warning');
  });

  it('keeps the status maps free of fixed palette shades', () => {
    // A regression here means a status colour stopped following the theme.
    // Decorative kind tints (a folder icon's amber, say) are deliberately not
    // covered — those are a design choice, not a theme bug.
    const literal = /\b(bg|text|border)-(red|orange|amber|yellow|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|pink|rose)-[0-9]{2,3}\b/;
    for (const file of [
      'src/lib/clusterHealth.ts',
      'src/components/dialogs/ToastStack.tsx',
    ]) {
      expect(readFileSync(file, 'utf8')).not.toMatch(literal);
    }
  });

  it('keeps change-stream operation badges on tokens', () => {
    const source = readFileSync('src/components/WatchPanel.tsx', 'utf8');
    const styles = source.slice(
      source.indexOf('const OPERATION_STYLES'),
      source.indexOf('};', source.indexOf('const OPERATION_STYLES'))
    );
    expect(styles).not.toMatch(
      /\b(bg|text|border)-(red|amber|emerald|sky|violet|rose)-[0-9]{2,3}\b/
    );
    expect(styles).toContain('bg-success');
    expect(styles).toContain('bg-destructive');
  });
});

// #324 review: `chart-3` holds exactly the same value as `success` in every
// built-in preset, so mapping rename events to it turned them the same green as
// inserts — the change-stream table exists to tell operations apart at a
// glance, and a token swap quietly undid that.
describe('tokens chosen to differentiate stay visually distinct (#324 review)', () => {
  const presets = readFileSync('src/lib/themes/presets.ts', 'utf8');

  /** Every value a token takes across the presets file. */
  const valuesOf = (token: string): string[] => {
    // Hyphenated token names are quoted object keys in the presets file.
    const key = token.includes('-') ? `"${token}"` : token;
    const pattern = new RegExp(`${key}:\\s*"([^"]+)"`, 'g');
    return [...presets.matchAll(pattern)].map((m) => m[1]);
  };

  it('gives each change-stream operation its own colour', () => {
    const source = readFileSync('src/components/WatchPanel.tsx', 'utf8');
    const styles = source.slice(
      source.indexOf('const OPERATION_STYLES'),
      source.indexOf('};', source.indexOf('const OPERATION_STYLES'))
    );
    // Distinct tokens only: `delete` and `drop` deliberately share
    // `destructive`, since both are removals and reading alike is correct.
    const used = [...new Set([...styles.matchAll(/rail: 'bg-([a-z0-9-]+)'/g)].map((m) => m[1]))];
    expect(used.length).toBeGreaterThan(3);

    // Compare per base (dark values first, then light) so a collision in either
    // mode fails, rather than comparing across modes where overlap is expected.
    const perToken = used.map(valuesOf).filter((values) => values.length > 0);
    for (let i = 0; i < (perToken[0]?.length ?? 0); i++) {
      const shades = perToken.map((values) => values[i]).filter(Boolean);
      expect(new Set(shades).size).toBe(shades.length);
    }
  });

  it('confirms the collision that prompted this: chart-3 is success', () => {
    // Documents why rename uses chart-4. If these ever diverge, chart-3 becomes
    // usable again and this test says so rather than leaving a stale rule.
    expect(valuesOf('chart-3')).toEqual(valuesOf('success'));
    expect(valuesOf('chart-4')).not.toEqual(valuesOf('success'));
  });
});
