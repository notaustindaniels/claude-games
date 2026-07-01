// Headless screenshot-verification harness.
// Serves the built app from dist/, drives headless Chromium (playwright-core,
// software GL), waits for rendered frames / sim time, captures PNGs via CDP
// Page.captureScreenshot, and reports console/page errors.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'dist');

const MIME = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.css': 'text/css',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.json': 'application/json',
  '.wasm': 'application/wasm',
  '.svg': 'image/svg+xml',
};

export function serve(dir = DIST) {
  const server = http.createServer((req, res) => {
    let urlPath = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (urlPath.endsWith('/')) urlPath += 'index.html';
    const file = path.join(dir, urlPath);
    if (!file.startsWith(dir) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
      res.writeHead(404);
      res.end('not found');
      return;
    }
    res.writeHead(200, {
      'content-type': MIME[path.extname(file)] || 'application/octet-stream',
      'cache-control': 'no-store',
    });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, port: server.address().port });
    });
  });
}

export const CHROMIUM_ARGS = [
  '--use-gl=angle',
  '--use-angle=swiftshader',
  '--enable-unsafe-swiftshader',
  '--no-sandbox',
  '--disable-dev-shm-usage',
];

export async function launchBrowser() {
  const executablePath = '/opt/pw-browsers/chromium';
  return chromium.launch({
    executablePath: fs.existsSync(executablePath) ? executablePath : undefined,
    headless: true,
    args: CHROMIUM_ARGS,
  });
}

/**
 * Run one job: open the app with query params, wait for capture conditions,
 * save PNGs. Returns { errors, consoleErrors, backend, captures }.
 *
 * job = {
 *   name, params: 'scenario=cube&fixeddt=1',
 *   width = 1280, height = 720,
 *   captures: [{ untilFrames?, untilSimTime?, out }],
 *   timeoutMs = 120000,
 * }
 */
export async function runJob(browser, port, job) {
  const width = job.width ?? 1280;
  const height = job.height ?? 720;
  const timeoutMs = job.timeoutMs ?? 120000;
  const context = await browser.newContext({ viewport: { width, height } });
  const page = await context.newPage();

  const consoleErrors = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text());
  });
  page.on('pageerror', (err) => consoleErrors.push('pageerror: ' + err.message));

  const url = `http://127.0.0.1:${port}/?${job.params}`;
  await page.goto(url, { waitUntil: 'load', timeout: timeoutMs });

  const cdp = await context.newCDPSession(page);
  const results = [];
  const deadline = Date.now() + timeoutMs;

  for (const cap of job.captures) {
    const untilFrames = cap.untilFrames ?? 10;
    const untilSimTime = cap.untilSimTime ?? 0;
    // Poll the page's __OO contract until the capture condition holds.
    for (;;) {
      const state = await page.evaluate(() => ({
        ready: window.__OO?.ready,
        frames: window.__OO?.frames ?? 0,
        simTime: window.__OO?.simTime ?? 0,
        errors: window.__OO?.errors ?? [],
        backend: window.__OO?.backend,
      }));
      if (state.errors.length) {
        await context.close();
        return { job: job.name, ok: false, errors: state.errors, consoleErrors, captures: results };
      }
      if (state.ready && state.frames >= untilFrames && state.simTime >= untilSimTime) {
        results.backend = state.backend;
        break;
      }
      if (Date.now() > deadline) {
        await context.close();
        return {
          job: job.name, ok: false,
          errors: [`timeout waiting for frames>=${untilFrames} simTime>=${untilSimTime} (got frames=${state.frames} simTime=${state.simTime.toFixed(2)} ready=${state.ready})`],
          consoleErrors, captures: results,
        };
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
    const outPath = path.resolve(ROOT, cap.out);
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, Buffer.from(shot.data, 'base64'));
    results.push({ out: cap.out, bytes: shot.data.length });
  }

  const backend = await page.evaluate(() => window.__OO?.backend);
  const finalErrors = await page.evaluate(() => window.__OO?.errors ?? []);
  await context.close();
  return { job: job.name, ok: finalErrors.length === 0, errors: finalErrors, consoleErrors, backend, captures: results };
}

/**
 * Run a list of jobs, each in a fresh browser (full isolation — required for
 * the determinism check, harmless elsewhere). Prints a report.
 */
export async function runJobs(jobs) {
  const { server, port } = await serve();
  const report = [];
  try {
    for (const job of jobs) {
      const browser = await launchBrowser();
      try {
        const res = await runJob(browser, port, job);
        report.push(res);
        const status = res.ok ? 'OK ' : 'ERR';
        console.log(`[${status}] ${job.name} backend=${res.backend ?? '?'} captures=${res.captures.map((c) => c.out).join(', ')}`);
        for (const e of res.errors) console.log(`      app error: ${e}`);
        for (const e of res.consoleErrors) console.log(`      console error: ${e}`);
      } finally {
        await browser.close();
      }
    }
  } finally {
    server.close();
  }
  return report;
}
