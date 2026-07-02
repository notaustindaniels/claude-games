// W10: same seed + timestamp must yield identical wave state across two
// independently launched renders. Runs the identical job twice (fresh
// browser each) and reports the pixel diff percentage.
import fs from 'node:fs';
import { PNG } from 'pngjs';
import { runJobs } from './harness.mjs';

const params =
  'scenario=ocean&fixeddt=1&dt=0.25&preset=moderate&seed=4242&seabed=0&lighthouse=0&crate=0&buoy=0&cam=0,12,0&look=105,0,-228&hud=0';

const jobs = [
  { name: 'det-run-1', params, width: 960, height: 540, captures: [{ untilSimTime: 8, out: 'shots/w10-run1.png' }] },
  { name: 'det-run-2', params, width: 960, height: 540, captures: [{ untilSimTime: 8, out: 'shots/w10-run2.png' }] },
];

const report = await runJobs(jobs);
if (report.some((r) => !r.ok)) process.exit(1);

const a = PNG.sync.read(fs.readFileSync('shots/w10-run1.png'));
const b = PNG.sync.read(fs.readFileSync('shots/w10-run2.png'));
if (a.width !== b.width || a.height !== b.height) {
  console.error('size mismatch');
  process.exit(1);
}
let diff = 0;
const total = a.width * a.height;
for (let i = 0; i < total * 4; i += 4) {
  if (
    Math.abs(a.data[i] - b.data[i]) > 2 ||
    Math.abs(a.data[i + 1] - b.data[i + 1]) > 2 ||
    Math.abs(a.data[i + 2] - b.data[i + 2]) > 2
  ) {
    diff++;
  }
}
const pct = (100 * diff) / total;
console.log(`W10 determinism: ${diff}/${total} differing pixels = ${pct.toFixed(4)}% (threshold < 1%)`);
process.exit(pct < 1 ? 0 : 1);
