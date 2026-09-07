import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';

// #325 review: the results tab is persisted on the tab so it survives the grid
// remounting on every run. That persistence is what makes this necessary —
// a run started from Explain would otherwise hide its own rows behind the plan,
// because the grid's documents effect skips the mount it remounts into.
describe('a run that loads documents returns to the Results tab (#325 review)', () => {
  it('resets resultsTab wherever an existing tab starts loading', () => {
    const app = readFileSync('src/App.tsx', 'utf8');
    // Patches to an EXISTING tab (`...t,`) — creating a fresh tab needs no
    // reset, since it has no persisted tab to carry over.
    const patches = [...app.matchAll(/\{ \.\.\.t, [^}]*loading: true[^}]*\}/g)].map((m) => m[0]);
    expect(patches.length).toBeGreaterThan(0);
    for (const patch of patches) {
      expect(patch).toContain("resultsTab: 'results'");
    }
  });
});
