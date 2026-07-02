// Diagnostic: fetch the compiled shader of a mesh from the running app.
import { serve, launchBrowser } from './harness.mjs';
import fs from 'node:fs';

const params = process.argv[2] || 'scenario=ocean&fixeddt=1&dt=0.25&preset=calm&seed=1337&lighthouse=0&crate=0&buoy=0&cam=-10,-5,80&look=-45,-14,125&dumpshader=seabed';
const { server, port } = await serve();
const browser = await launchBrowser();
const context = await browser.newContext({ viewport: { width: 640, height: 360 } });
const page = await context.newPage();
page.on('pageerror', (e) => console.log('pageerror:', e.message));
await page.goto(`http://127.0.0.1:${port}/?${params}`, { waitUntil: 'load' });
let dump = null;
for (let i = 0; i < 120; i++) {
  dump = await page.evaluate(() => window.__OO?.shaderDump || null);
  if (dump) break;
  await new Promise((r) => setTimeout(r, 500));
}
await browser.close();
server.close();
if (!dump) {
  console.error('no shader dump received');
  process.exit(1);
}
fs.writeFileSync('/tmp/claude-0/-home-user-claude-games/a7b2ccd3-7e2b-5331-9344-997b2a828ce8/scratchpad/frag.glsl', dump.fragmentShader || dump.error || '');
console.log('dumped', (dump.fragmentShader || '').length, 'chars');
