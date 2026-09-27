// Build the coverage report and enforce the gate (#396).
//
// The gate is a ratchet: COVERAGE_GATE in ./options holds the minimum the suite
// must keep. It is raised as tests are added and never lowered, until it
// reaches the 95% target.
import { CoverageReport } from 'monocart-coverage-reports';
import { enforceCoverageGate } from './gate';
import { IS_SHARD, coverageOptions } from './options';

export default async function globalTeardown(): Promise<void> {
  const report = new CoverageReport(coverageOptions);
  // No cache means no Chromium test ran (e.g. `--project=webkit`): nothing to report.
  if (!report.hasCache()) return;

  const results = await report.generate();
  if (!results) return;

  // A CI shard ran part of the suite. It only keeps its coverage raw; the
  // workflow's merge job combines every shard's and gates the whole.
  if (IS_SHARD) return;

  // Enforced in CI, where the whole suite runs. A local run of a few files
  // measures only what those files reach, so the gate would fail it for no
  // reason; set E2E_COVERAGE_GATE=1 to enforce it locally too.
  if (!process.env.CI && process.env.E2E_COVERAGE_GATE !== '1') return;
  enforceCoverageGate(results);
}
