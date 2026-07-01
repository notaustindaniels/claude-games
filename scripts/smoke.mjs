// Smoke test: build must already exist (npm run build). Renders the given
// scenario headlessly, captures a screenshot, exits nonzero on any console or
// page error. Usage:
//   node scripts/smoke.mjs [--params 'scenario=cube&fixeddt=1'] [--out shots/smoke.png] [--frames 30] [--sim-time 0]
import { runJobs } from './harness.mjs';

const args = process.argv.slice(2);
function opt(name, dflt) {
  const i = args.indexOf('--' + name);
  return i >= 0 ? args[i + 1] : dflt;
}

const jobs = [
  {
    name: 'smoke',
    params: opt('params', 'scenario=cube&fixeddt=1'),
    width: Number(opt('width', 1280)),
    height: Number(opt('height', 720)),
    captures: [
      {
        untilFrames: Number(opt('frames', 30)),
        untilSimTime: Number(opt('sim-time', 0)),
        out: opt('out', 'shots/smoke.png'),
      },
    ],
  },
];

const report = await runJobs(jobs);
const failed = report.filter((r) => !r.ok || r.consoleErrors.length > 0);
if (failed.length) {
  console.error(`SMOKE FAILED (${failed.length} job(s) with errors)`);
  process.exit(1);
}
console.log('SMOKE PASSED: zero console errors, screenshot captured.');
