// scan storm M6 across wave phases, save strip, find the "sand" frames
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { chromium } from 'playwright-core'

const OUT = '/private/tmp/claude-501/-Users-austin-openocean-v2/4316a377-048d-4a77-a5d0-6019f945cf7f/scratchpad'
const QS = process.env.M6_QS || ''
const vite = spawn(process.execPath, ['node_modules/vite/bin/vite.js', '--port', '5199', '--strictPort'], { stdio: 'pipe' })
await new Promise(r => { vite.stdout.on('data', d => { if (String(d).includes('5199')) r() }); setTimeout(r, 6000) })
const exe = path.join(os.homedir(), 'Library/Caches/ms-playwright/chromium-1223/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing')
const browser = await chromium.launch({ headless: true, executablePath: exe })
const page = await browser.newPage({ viewport: { width: 640, height: 360 }, deviceScaleFactor: 1 })
page.on('pageerror', e => console.log('PAGEERROR', String(e).slice(0, 200)))
await page.goto(`http://127.0.0.1:5199/?verify=1&backend=webgl&preset=storm${QS}`)
await page.waitForFunction(() => window.__oo && (window.__oo.ready || window.__oo.failed), null, { timeout: 60000 })
await page.evaluate(() => window.__oo.pump(10))
await page.evaluate(() => window.__oo.setCamera([0, 0.05, 0], [300, -2, 0]))
const cdp = await page.context().newCDPSession(page)
for (let i = 0; i < 12; i++) {
  await page.evaluate(() => window.__oo.pump(0.1))
  const shot = await cdp.send('Page.captureScreenshot', { format: 'png' })
  fs.writeFileSync(path.join(OUT, `m6scan-${String(i).padStart(2, '0')}.png`), Buffer.from(shot.data, 'base64'))
}
console.log('done: 12 frames at t=10.1..11.2')
await browser.close()
vite.kill()
process.exit(0)
