// W13: prove the consumer project (installing openocean as a dependency)
// renders an ocean with zero console errors — no harness hooks in the app.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { PNG } from 'pngjs';
import { launchBrowser } from './harness.mjs';

const root = path.resolve('consumer-test/dist');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };
const server = http.createServer((req, res) => {
  if (req.url === '/favicon.ico') { res.writeHead(204); res.end(); return; }
  let p = path.join(root, decodeURIComponent(new URL(req.url, 'http://x').pathname));
  if (fs.statSync(p, { throwIfNoEntry: false })?.isDirectory()) p = path.join(p, 'index.html');
  if (!fs.existsSync(p)) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'content-type': MIME[path.extname(p)] ?? 'application/octet-stream' });
  res.end(fs.readFileSync(p));
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;

const browser = await launchBrowser();
const page = await (await browser.newContext({ viewport: { width: 800, height: 450 } })).newPage();
const errors = [];
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
page.on('pageerror', (e) => errors.push(e.message));
await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'load' });
await page.waitForTimeout(30000); // SwiftShader needs time to compile + render a few frames
await page.screenshot({ path: 'shots/w13-consumer.png' });
await browser.close();
server.close();

const png = PNG.sync.read(fs.readFileSync('shots/w13-consumer.png'));
const colors = new Set();
for (let i = 0; i < png.data.length; i += 4096) colors.add(`${png.data[i]},${png.data[i + 1]},${png.data[i + 2]}`);
console.log(`console errors: ${errors.length}`, errors.slice(0, 3));
console.log(`distinct sampled colors: ${colors.size}`);
if (errors.length === 0 && colors.size > 8) {
  console.log('CONSUMER SMOKE PASSED');
} else {
  console.log('CONSUMER SMOKE FAILED');
  process.exit(1);
}
