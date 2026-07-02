// Batch screenshot runner: node scripts/shoot.mjs jobs/<file>.json
// Each job: { name, params, width?, height?, captures: [{untilSimTime?, untilFrames?, out}] }
import fs from 'node:fs';
import { runJobs } from './harness.mjs';

const file = process.argv[2];
if (!file) {
  console.error('usage: node scripts/shoot.mjs <jobs.json>');
  process.exit(2);
}
const jobs = JSON.parse(fs.readFileSync(file, 'utf8'));
const report = await runJobs(jobs);
const failed = report.filter((r) => !r.ok || r.consoleErrors.length > 0);
console.log(`${report.length - failed.length}/${report.length} jobs clean`);
if (failed.length) process.exit(1);
