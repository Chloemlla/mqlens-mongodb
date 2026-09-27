// The coverage gate (#396), checked against a generated report's own summary.
import type { CoverageResults } from 'monocart-coverage-reports';
import { COVERAGE_GATE } from './options';

/** Throw when the report falls below any metric in COVERAGE_GATE. */
export function enforceCoverageGate(results: CoverageResults): void {
  const below = (Object.keys(COVERAGE_GATE) as Array<keyof typeof COVERAGE_GATE>).filter((metric) => {
    const pct = results.summary[metric].pct;
    return typeof pct !== 'number' || pct < COVERAGE_GATE[metric];
  });
  if (below.length > 0) {
    const detail = below
      .map((metric) => `${metric} ${results.summary[metric].pct}% < ${COVERAGE_GATE[metric]}%`)
      .join(', ');
    throw new Error(`E2E coverage is below the gate (#396): ${detail}. See coverage/e2e/index.html.`);
  }
}
