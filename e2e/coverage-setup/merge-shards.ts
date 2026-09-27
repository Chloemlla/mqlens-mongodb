// Merge the coverage CI shards kept raw into one report, and enforce the gate (#396).
//
// Usage: npm run test:e2e:merge-coverage -- <dir>
// where <dir> holds one sub-directory of raw coverage per Chromium shard.
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { CoverageReport } from 'monocart-coverage-reports';
import { enforceCoverageGate } from './gate';
import { coverageOptions } from './options';

const root = process.argv[2];
if (!root) throw new Error('Pass the directory that holds each shard\'s raw coverage.');

const inputDir = readdirSync(root, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => join(root, entry.name));
if (inputDir.length === 0) throw new Error(`No shard coverage found in ${root}.`);

const results = await new CoverageReport({ ...coverageOptions, inputDir }).generate();
if (!results) throw new Error(`The coverage in ${inputDir.join(', ')} could not be merged.`);
enforceCoverageGate(results);
