// dev iteration helper (NOT evidence): vite dev + screenshot + console dump
// usage: node dev-shot.mjs [preset] [camId|px,py,pz,lx,ly,lz] [outname] [pumpSecs]
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { chromium } from 'playwright-core'

const preset = process.argv[2] || 'blackflag'
const camArg = process.argv[3] || 'M1'
const outName = process.argv[4] || 'dev'
const pumpSecs = +(process.argv[5] || 3)
const OUT = process.env.DEVSHOT_DIR || '/private/tmp/claude-501/-Users-austin-openocean-v2/4316a377-048d-4a77-a5d0-6019f945cf7f/scratchpad'

const CAMS = {
  M1: [[0, 3.5, 0], [300, 0, 0]], M1s: [[0, 6.5, 0], [300, 0, 0]],
  M2: [[0, 3.5, 0], [-300, 0, 0]],
  M3: [[0, 1.2, 0], [400, 0.2, 60]],
  M4: [[0, 100, 0], [100, 0, 0]],
  M5: [[0, 400, 0], [2, 0, 0]],
  M6: [[0, 0.05, 0], [300, -2, 0]],
  M7: [[0, -8, 0], [60, -24, 0]],
  M8: [[0, -15, 0], [18, 0, 6]],
  M9: [[0, -6, 0], [48, -26, 0]],
  M10: [[0, -24, 0], [200, -24, 0]],
}
const cam = CAMS[camArg] || (() => { const v = camArg.split(',').map(Number); return [[v[0], v[1], v[2]], [v[3], v[4], v[5]]] })()

const vite = spawn(process.execPath, ['node_modules/vite/bin/vite.js', '--port', '5199', '--strictPort'], { stdio: 'pipe' })
await new Promise(r => { vite.stdout.on('data', d => { if (String(d).includes('5199')) r() }); setTimeout(r, 6000) })

const exe = path.join(os.homedir(), 'Library/Caches/ms-playwright/chromium-1223/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing')
const browser = await chromium.launch({ headless: true, executablePath: exe })
const page = await browser.newPage({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 })
const errs = []
page.on('console', m => { if (m.type() === 'error') errs.push(m.text().slice(0, 400)) })
page.on('pageerror', e => errs.push('PAGEERROR ' + String(e).slice(0, 600)))
await page.goto(`http://127.0.0.1:5199/?verify=1&backend=webgl&preset=${preset}${process.env.DEVSHOT_QS||''}`)
const ready = await page.waitForFunction(() => window.__oo && (window.__oo.ready || window.__oo.failed), null, { timeout: 60000 })
  .then(() => page.evaluate(() => window.__oo.failed || 'ok')).catch(() => 'TIMEOUT')
console.log('ready:', ready)
if (ready === 'ok') {
  const t0 = Date.now()
  await page.evaluate(d => window.__oo.pump(d), pumpSecs)
  console.log(`pumped ${pumpSecs}s sim in ${((Date.now() - t0) / 1000).toFixed(1)}s wall; simT=`, await page.evaluate(() => window.__oo.time()))
  await page.evaluate(([p, l]) => window.__oo.setCamera(p, l), cam)
  await page.evaluate(() => window.__oo.pump(0.03))
  if (process.env.DEVSHOT_JSTATS) {
    const j = await page.evaluate(async () => {
      const oc = window.__oo && window.__ooOcean
      if (!oc) return 'no ocean handle'
      const r = oc.renderer, rt = oc.ocean.foam.rtA
      const raw = await r.readRenderTargetPixelsAsync(rt, 256, 256, 512, 512)
      const half = (u) => { const s2 = (u & 0x8000) ? -1 : 1, e = (u >> 10) & 0x1f, m = u & 0x3ff
        if (e === 0) return s2 * m * Math.pow(2, -24); if (e === 31) return m ? NaN : s2 * Infinity
        return s2 * (1 + m / 1024) * Math.pow(2, e - 15) }
      let jmin = 1e9, jmax = -1e9, jsum = 0, n = 0, below = [0,0,0,0,0]
      const th = [0.9, 0.7, 0.5, 0.3, 0.0]
      let fsum = 0, fmax = 0
      for (let i = 0; i < 512*512; i++) {
        const J = half(raw[i*4+1]); const f = half(raw[i*4])
        if (!isFinite(J)) continue
        jmin = Math.min(jmin, J); jmax = Math.max(jmax, J); jsum += J; n++
        for (let k = 0; k < 5; k++) if (J < th[k]) below[k]++
        fsum += f; fmax = Math.max(fmax, f)
      }
      return { jmin: +jmin.toFixed(3), jmax: +jmax.toFixed(3), jmean: +(jsum/n).toFixed(3),
        pctBelow: th.map((t,k) => t + ':' + (below[k]/n*100).toFixed(2) + '%').join(' '),
        foamMean: +(fsum/n).toFixed(4), foamMax: +fmax.toFixed(3) }
    })
    console.log('JSTATS:', JSON.stringify(j))
  }
  if (process.env.DEVSHOT_STATS) {
    console.log('stats:', JSON.stringify(await page.evaluate(() => window.__oo.getStats()), null, 1).slice(0, 800))
  }
}
const cdp = await page.context().newCDPSession(page)
const shot = await cdp.send('Page.captureScreenshot', { format: 'png' })
fs.writeFileSync(path.join(OUT, outName + '.png'), Buffer.from(shot.data, 'base64'))
console.log('shot:', path.join(OUT, outName + '.png'))
console.log('console errors:', errs.length ? errs.slice(0, 6) : 'none')
await browser.close()
vite.kill()
process.exit(0)
