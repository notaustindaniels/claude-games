// W12/W14: measure realtime performance per quality tier (SwiftShader).
// No fixeddt — the page runs wall-clock; we count frames over a window.
import { serve, launchBrowser } from './harness.mjs';

const TIERS = [
  { q: 'low', width: 640, height: 360 },
  { q: 'medium', width: 960, height: 540 },
  { q: 'high', width: 960, height: 540 },
];

const { server, port } = await serve();
const results = [];
for (const t of TIERS) {
  const browser = await launchBrowser();
  const context = await browser.newContext({ viewport: { width: t.width, height: t.height } });
  const page = await context.newPage();
  const params = `scenario=ocean&preset=moderate&seed=1337&quality=${t.q}&seabed=0&lighthouse=0&crate=0&buoy=0&cam=0,10,0&look=105,0,-228&label=W12:+quality=${t.q}`;
  await page.goto(`http://127.0.0.1:${port}/?${params}`, { waitUntil: 'load' });
  await page.waitForFunction(() => window.__OO && window.__OO.ready === true, null, { timeout: 120000 });
  // Warmup 6s wall, then measure 20s.
  await page.waitForTimeout(6000);
  const s0 = await page.evaluate(() => ({ f: window.__OO.frames, sim: window.__OO.stats.simMs }));
  const t0 = Date.now();
  await page.waitForTimeout(20000);
  const s1 = await page.evaluate(() => ({ f: window.__OO.frames, sim: window.__OO.stats.simMs }));
  const wall = (Date.now() - t0) / 1000;
  const fps = (s1.f - s0.f) / wall;
  results.push({ tier: t.q, res: `${t.width}x${t.height}`, fps: fps.toFixed(2), simMs: s1.sim.toFixed(1) });
  await page.screenshot({ path: `shots/w12-${t.q}.png` });
  await browser.close();
}
server.close();
console.log('tier | resolution | fps (SwiftShader) | sim ms/step');
for (const r of results) console.log(`${r.tier} | ${r.res} | ${r.fps} | ${r.simMs}`);
