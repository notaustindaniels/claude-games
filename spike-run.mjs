import { spawn } from 'node:child_process'
import { chromium } from 'playwright-core'
import os from 'node:os'
import path from 'node:path'

const vite = spawn(process.execPath, ['node_modules/vite/bin/vite.js', '--port', '5199', '--strictPort'], { stdio: 'pipe' })
await new Promise(r => { vite.stdout.on('data', d => { if (String(d).includes('5199')) r() }); setTimeout(r, 5000) })
const exe = path.join(os.homedir(), 'Library/Caches/ms-playwright/chromium-1223/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing')
const browser = await chromium.launch({ headless: true, executablePath: exe })
const page = await browser.newPage()
page.on('console', m => { if (m.type() === 'error' || m.type() === 'warning') console.log('CONSOLE', m.type(), m.text().slice(0, 200)) })
page.on('pageerror', e => console.log('PAGEERROR', String(e).slice(0, 300)))
await page.goto('http://127.0.0.1:5199/'+(process.env.SPIKE_PAGE||'spike.html'))
await page.waitForFunction(() => window.__spike && window.__spike.done, null, { timeout: 60000 }).catch(() => console.log('TIMEOUT'))
const res = await page.evaluate(() => window.__spike)
for (const [k, v] of res.steps) console.log('»', k, '→', v)
await browser.close()
vite.kill()
process.exit(0)
