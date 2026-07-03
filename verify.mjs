#!/usr/bin/env node
/*
 * verify.mjs — the ONLY producer of claimable evidence (VERIFY.md).
 *
 *   node verify.mjs [--backend webgpu|webgl|auto] [--preset all|<name>] [--out shots/]
 *                   [--no-build] [--scratch]
 *
 * Serves the built app, drives headless Chromium (playwright-core, reusing
 * installed browsers — never downloading), waits for sim t>=10s, captures via
 * CDP Page.captureScreenshot, computes gates G1–G6, writes:
 *   shots/pass-<n>-matrix.png   labeled contact sheet M1–M10 x 3 presets
 *   shots/pass-<n>-sweep.png    24-frame free-roam sheet
 *   shots/pass-<n>-gates.txt    gate table (also printed to stdout)
 *   shots/pass-<n>-g*.png       per-gate crops
 * Any pageerror fails the run outright (exit 1) after evidence is written.
 *
 * App contract — window.__oo when loaded with ?verify=1&backend=...&preset=...:
 *   ready:boolean, failed:string|null, backend():string, time():number
 *   pump(dt):Promise            advance sim in fixed 1/60 s steps, render once
 *   setPreset(name):Promise, setCamera(pos[3], look[3])
 *   getConstants():{seaLevel,seabedBaseY,causticRadius}
 *   getStats():Promise<{hs,minSurfaceY,maxSeabedTop,
 *                       shafts:[{apex[3],axis[3],topY,bottomY}],
 *                       sunDir[3], flatConstants:[[r,g,b]..]}|null>
 *   getSeabedAt(x,z):number|null, getFlowAt(x,z):Promise<[fx,fz]|null>
 *   getCausticInfo():{cx,cz,r}|null
 * Missing pieces of the contract make the dependent gates FAIL (never SKIP).
 */
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'
import { chromium } from 'playwright-core'

const ROOT = path.dirname(fileURLToPath(import.meta.url))
const PRESETS = ['blackflag', 'storm', 'seaofthieves']
const VIEW_W = 1280, VIEW_H = 720, FOV_Y = 55

// ---------------------------------------------------------------- args
const argv = process.argv.slice(2)
function argOf (name, dflt) {
  const i = argv.indexOf('--' + name)
  return i >= 0 ? argv[i + 1] : dflt
}
const OPT = {
  backend: argOf('backend', 'auto'),
  preset: argOf('preset', 'all'),
  out: argOf('out', 'shots/'),
  build: !argv.includes('--no-build'),
  scratch: argv.includes('--scratch'),
}
const RUN_PRESETS = OPT.preset === 'all' ? PRESETS : [OPT.preset]

// ------------------------------------------------- camera matrix (hardcoded)
// Sun is toward +X in the app. Constants below are the contract values the
// app must report via getConstants(); mismatch is reported and fails G4.
const EXPECT_CONST = { seaLevel: 0, seabedBaseY: -28, causticRadius: 48 }
const M1Y = { blackflag: 3.5, storm: 6.5, seaofthieves: 3.5 }
const CAMS = {
  M1: p => [[0, M1Y[p], 0], [300, 0, 0]],          // wave-level toward sun
  M2: p => [[0, M1Y[p], 0], [-300, 0, 0]],         // wave-level away from sun
  M3: () => [[0, 1.2, 0], [400, 0.2, 60]],         // grazing along surface
  M4: () => [[0, 100, 0], [100, 0, 0]],            // 100 m, 45 deg down
  M5: () => [[0, 400, 0], [2, 0, 0]],              // 400 m, straight down
  M6: () => [[0, 0.05, 0], [300, -2, 0]],          // waterline half-submerged
  M7: () => [[0, -8, 0], [60, -24, 0]],            // underwater, seabed+surface
  M8: () => [[0, -15, 0], [18, 0, 6]],             // underwater, up at surface
  M9: () => [[0, -6, 0], [48, -26, 0]],            // caustic-region boundary
  M10: () => [[0, -24, 0], [200, -24, 0]],         // level across seabed
}
const CAM_IDS = Object.keys(CAMS)

// Free-roam sweep: deterministic 25 s spiral, 24 frames.
function sweepPose (t) {
  const clamp = (x, a, b) => Math.min(b, Math.max(a, x))
  const lerp = (a, b, u) => a + (b - a) * u
  const ease = u => u * u * (3 - 2 * u)
  let pos, look
  if (t < 8) {                      // descend spiral 300 m -> 3 m
    const u = ease(t / 8)
    const ang = 0.6 + u * 4.2
    const R = lerp(180, 55, u)
    const h = lerp(300, 3, u)
    pos = [Math.cos(ang) * R, h, Math.sin(ang) * R]
    const ang2 = ang + 0.55
    look = [Math.cos(ang2) * R * 0.45, h * 0.55 - 2, Math.sin(ang2) * R * 0.45]
  } else if (t < 11) {              // skim at wave level toward origin
    const u = (t - 8) / 3
    const x = lerp(48, 10, u)
    pos = [x, 2.4, lerp(26, 6, u)]
    look = [x - 60, 0.5, -14]
  } else if (t < 13) {              // pierce the waterline
    const u = ease((t - 11) / 2)
    pos = [lerp(10, 4, u), lerp(2.4, -7, u), lerp(6, 2, u)]
    look = [-50, lerp(0, -16, u), -6]
  } else if (t < 19) {              // cruise along the floor
    const u = (t - 13) / 6
    const ang = u * 2.6
    const R = 26 + 14 * u
    pos = [Math.cos(ang) * R - 20, -22.5, Math.sin(ang) * R]
    const a2 = ang + 0.8
    look = [Math.cos(a2) * (R + 60) - 20, -25, Math.sin(a2) * (R + 60)]
  } else {                          // rise back out toward the sun
    const u = ease(clamp((t - 19) / 6, 0, 1))
    pos = [lerp(10, 30, u), lerp(-20, 40, u), lerp(10, -20, u)]
    look = [lerp(60, 400, u), lerp(-18, 10, u), 0]
  }
  return { pos, look }
}
const SWEEP_N = 24, SWEEP_T = 25

// ---------------------------------------------------------------- utilities
const log = (...a) => console.log('[verify]', ...a)
function fmt (x, n = 3) { return typeof x === 'number' && isFinite(x) ? x.toFixed(n) : String(x) }

function findChromium () {
  const home = os.homedir()
  const roots = [
    path.join(home, 'Library/Caches/ms-playwright'),
    path.join(home, '.cache/ms-playwright'),
    '/opt/ms-playwright', '/opt/playwright',
  ]
  const cands = []
  for (const r of roots) {
    if (!fs.existsSync(r)) continue
    for (const d of fs.readdirSync(r).filter(d => d.startsWith('chromium-')).sort().reverse()) {
      for (const rel of [
        'chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
        'chrome-mac/Chromium.app/Contents/MacOS/Chromium',
        'chrome-linux/chrome']) {
        const p = path.join(r, d, rel)
        if (fs.existsSync(p)) { cands.push(p); break }
      }
    }
  }
  for (const p of [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome', '/usr/bin/chromium',
  ]) if (fs.existsSync(p)) cands.push(p)
  return cands
}

async function launchBrowser () {
  const flags = [
    '--enable-unsafe-webgpu', '--enable-features=WebGPU', '--use-angle=metal',
    '--hide-scrollbars', '--mute-audio',
  ]
  const errs = []
  for (const exe of findChromium()) {
    try {
      const b = await chromium.launch({ headless: true, executablePath: exe, args: flags })
      log('browser:', exe)
      return b
    } catch (e) { errs.push(`${exe}: ${e.message.split('\n')[0]}`) }
  }
  throw new Error('no launchable chromium found (never downloading per VERIFY.md):\n' + errs.join('\n'))
}

function serve (dir) {
  const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.jpg': 'image/jpeg', '.json': 'application/json', '.wasm': 'application/wasm' }
  const srv = http.createServer((req, res) => {
    let p = decodeURIComponent(new URL(req.url, 'http://x').pathname)
    if (p.endsWith('/')) p += 'index.html'
    const file = path.join(dir, p)
    if (!file.startsWith(dir) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
      res.writeHead(404); res.end('nope'); return
    }
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' })
    fs.createReadStream(file).pipe(res)
  })
  return new Promise(resolve => srv.listen(0, '127.0.0.1', () => resolve({ srv, port: srv.address().port })))
}

// ------------------------------------------------------------ lab page (pixel math)
const LAB_HTML = `<!doctype html><body><script>
async function loadImg(b64){const im=new Image();im.src='data:image/png;base64,'+b64;await im.decode();return im}
function toCanvas(im,w,h){const c=document.createElement('canvas');c.width=w||im.width;c.height=h||im.height;
  const g=c.getContext('2d',{willReadFrequently:true});g.imageSmoothingEnabled=true;g.imageSmoothingQuality='high';
  g.drawImage(im,0,0,c.width,c.height);return c}
function data(c){return c.getContext('2d').getImageData(0,0,c.width,c.height)}
function gray(d){const g=new Float32Array(d.width*d.height);for(let i=0,j=0;i<g.length;i++,j+=4)
  g[i]=0.299*d.data[j]+0.587*d.data[j+1]+0.114*d.data[j+2];return g}
window.lapVarBand=async(b64,x0,y0,x1,y1)=>{const im=await loadImg(b64);const d=data(toCanvas(im));const g=gray(d);const W=d.width;
  let s=0,s2=0,n=0;for(let y=Math.max(1,y0);y<Math.min(d.height-1,y1);y++)for(let x=Math.max(1,x0);x<Math.min(W-1,x1);x++){
    const v=-4*g[y*W+x]+g[y*W+x-1]+g[y*W+x+1]+g[(y-1)*W+x]+g[(y+1)*W+x];s+=v;s2+=v*v;n++}
  if(!n)return null;const m=s/n;return s2/n-m*m}
window.rmsDiff=async(a,b)=>{const A=data(toCanvas(await loadImg(a),160,90)),B=data(toCanvas(await loadImg(b),160,90));
  let s=0,n=A.width*A.height;for(let j=0;j<n*4;j+=4){for(let k=0;k<3;k++){const d=(A.data[j+k]-B.data[j+k])/255;s+=d*d}}
  return Math.sqrt(s/(n*3))}
window.countMagenta=async(b64)=>{const d=data(toCanvas(await loadImg(b64)));let n=0;
  for(let j=0;j<d.data.length;j+=4)if(d.data[j]>235&&d.data[j+1]<40&&d.data[j+2]>235)n++;return n}
window.meanLumDisk=(g,W,H,cx,cy,r)=>{let s=0,n=0;for(let y=Math.max(0,cy-r);y<=Math.min(H-1,cy+r);y++)
  for(let x=Math.max(0,cx-r);x<=Math.min(W-1,cx+r);x++){if((x-cx)**2+(y-cy)**2<=r*r){s+=g[y*W+x];n++}}
  return n?s/n:null}
window.boundaryStep=async(b64,pairs,r)=>{const d=data(toCanvas(await loadImg(b64)));const g=gray(d);
  const out=[];for(const[ax,ay,bx,by]of pairs){const A=meanLumDisk(g,d.width,d.height,ax|0,ay|0,r),B=meanLumDisk(g,d.width,d.height,bx|0,by|0,r);
    if(A!=null&&B!=null)out.push(Math.abs(A-B)/255)}return out}
window.ncc=async(a,b,cx,cy,sz,maxShift)=>{const A=data(toCanvas(await loadImg(a))),B=data(toCanvas(await loadImg(b)));
  const gA=gray(A),gB=gray(B),W=A.width;const h=sz>>1;
  const inW=sz-2*maxShift;const ax0=cx-(inW>>1),ay0=cy-(inW>>1);
  function win(g,x0,y0,w){const o=new Float32Array(w*w);let s=0;for(let y=0;y<w;y++)for(let x=0;x<w;x++){const v=g[(y0+y)*W+x0+x];o[y*w+x]=v;s+=v}
    const m=s/(w*w);let e=0;for(let i=0;i<o.length;i++){o[i]-=m;e+=o[i]*o[i]}return{o,e:Math.sqrt(e)||1}}
  const P=win(gA,ax0,ay0,inW);let best={c:-2,dx:0,dy:0};
  for(let dy=-maxShift;dy<=maxShift;dy++)for(let dx=-maxShift;dx<=maxShift;dx++){
    const Q=win(gB,ax0+dx,ay0+dy,inW);let dot=0;for(let i=0;i<P.o.length;i++)dot+=P.o[i]*Q.o[i];
    const c=dot/(P.e*Q.e);if(c>best.c)best={c,dx,dy}}
  return best}
function rgb2lab(r,g,b){function f(t){return t>0.008856?Math.cbrt(t):7.787*t+16/116}
  function inv(u){u/=255;return u<=0.04045?u/12.92:Math.pow((u+0.055)/1.055,2.4)}
  const R=inv(r),G=inv(g),Bl=inv(b);
  const X=(0.4124*R+0.3576*G+0.1805*Bl)/0.95047,Y=0.2126*R+0.7152*G+0.0722*Bl,Z=(0.0193*R+0.1192*G+0.9505*Bl)/1.08883;
  return[116*f(Y)-16,500*(f(X)-f(Y)),200*(f(Y)-f(Z))]}
window.flatCount=async(b64,y0,colors,dE)=>{const d=data(toCanvas(await loadImg(b64)));const W=d.width,H=d.height;
  const labs=colors.map(c=>rgb2lab(c[0],c[1],c[2]));
  // auto-detect flat 8x8 blocks and pool their colors
  const flatCols=new Map();
  for(let by=y0;by+8<=H;by+=8)for(let bx=0;bx+8<=W;bx+=8){let mn=[255,255,255],mx=[0,0,0],sm=[0,0,0];
    for(let y=0;y<8;y++)for(let x=0;x<8;x++){const j=((by+y)*W+bx+x)*4;for(let k=0;k<3;k++){const v=d.data[j+k];
      if(v<mn[k])mn[k]=v;if(v>mx[k])mx[k]=v;sm[k]+=v}}
    if(mx[0]-mn[0]<3&&mx[1]-mn[1]<3&&mx[2]-mn[2]<3){const key=(sm[0]>>8)+','+(sm[1]>>8)+','+(sm[2]>>8);
      flatCols.set(key,(flatCols.get(key)||0)+64)}}
  const total=(H-y0)*W;let auto=0,autoCol=null;for(const[k,v]of flatCols)if(v>auto){auto=v;autoCol=k}
  let cnt=0;if(labs.length){for(let y=y0;y<H;y++)for(let x=0;x<W;x++){const j=(y*W+x)*4;
    const L=rgb2lab(d.data[j],d.data[j+1],d.data[j+2]);
    for(const lb of labs){const dd=(L[0]-lb[0])**2+(L[1]-lb[1])**2+(L[2]-lb[2])**2;if(dd<dE*dE){cnt++;break}}}}
  return{declared:cnt,declaredFrac:cnt/total,autoMax:auto,autoMaxFrac:auto/total,autoCol,total}}
window.makeSheet=async(cells,cols,cw,ch,title)=>{const rows=Math.ceil(cells.length/cols);
  const LB=16,HD=22;const c=document.createElement('canvas');c.width=cols*cw;c.height=HD+rows*(ch+LB);
  const g=c.getContext('2d');g.fillStyle='#101418';g.fillRect(0,0,c.width,c.height);
  g.fillStyle='#9fb3c8';g.font='12px monospace';g.fillText(title,6,15);
  for(let i=0;i<cells.length;i++){const x=(i%cols)*cw,y=HD+((i/cols)|0)*(ch+LB);
    if(cells[i].b64){const im=await loadImg(cells[i].b64);g.drawImage(im,x,y,cw,ch)}
    else{g.fillStyle='#301020';g.fillRect(x,y,cw,ch);g.fillStyle='#ff5577';g.fillText('MISSING',x+8,y+20)}
    g.fillStyle='#0a0d10';g.fillRect(x,y+ch,cw,LB);g.fillStyle='#cfe2f3';g.font='11px monospace';
    g.fillText(cells[i].label,x+4,y+ch+12);g.strokeStyle='#000';g.strokeRect(x+.5,y+.5,cw,ch)}
  return c.toDataURL('image/png').split(',')[1]}
window.cropPng=async(b64,x,y,w,h,scale)=>{const im=await loadImg(b64);const c=document.createElement('canvas');
  c.width=w*(scale||1);c.height=h*(scale||1);const g=c.getContext('2d');g.imageSmoothingEnabled=false;
  g.drawImage(im,x,y,w,h,0,0,c.width,c.height);return c.toDataURL('image/png').split(',')[1]}
window.annotate=async(b64,marks)=>{const im=await loadImg(b64);const c=toCanvas(im);const g=c.getContext('2d');
  for(const m of marks){g.strokeStyle=m.col||'#ff0';g.fillStyle=m.col||'#ff0';g.lineWidth=2;
    if(m.t==='circle'){g.beginPath();g.arc(m.x,m.y,m.r,0,7);g.stroke()}
    if(m.t==='rect'){g.strokeRect(m.x,m.y,m.w,m.h)}
    if(m.t==='line'){g.beginPath();g.moveTo(m.x,m.y);g.lineTo(m.x2,m.y2);g.stroke()}
    if(m.t==='text'){g.font='13px monospace';g.fillText(m.s,m.x,m.y)}}
  return c.toDataURL('image/png').split(',')[1]}
<\/script>`

// ------------------------------------------------------- world<->screen math
function viewProject (pos, look) {
  const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
  const crs = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
  const nrm = a => { const l = Math.hypot(...a) || 1; return [a[0] / l, a[1] / l, a[2] / l] }
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
  const f = nrm(sub(look, pos))
  let up = Math.abs(f[1]) > 0.999 ? [0, 0, -1] : [0, 1, 0]
  const r = nrm(crs(f, up)); up = crs(r, f)
  const tanF = Math.tan(FOV_Y * Math.PI / 360), aspect = VIEW_W / VIEW_H
  return world => {
    const d = sub(world, pos)
    const z = dot(d, f); if (z <= 0.01) return null
    const x = dot(d, r) / z / (tanF * aspect), y = dot(d, up) / z / tanF
    return [(x * 0.5 + 0.5) * VIEW_W, (0.5 - y * 0.5) * VIEW_H, z]
  }
}
function horizonRow (camY, lookDist) {
  const pitch = Math.atan2(camY, lookDist)
  return VIEW_H / 2 - (VIEW_H / 2) * Math.tan(pitch) / Math.tan(FOV_Y * Math.PI / 360)
}

// --------------------------------------------------------------------- main
async function main () {
  const outDir = path.resolve(ROOT, OPT.out)
  fs.mkdirSync(outDir, { recursive: true })
  let passN = 0
  for (const f of fs.readdirSync(outDir)) {
    const m = f.match(/^pass-(\d+)-gates\.txt$/)
    if (m) passN = Math.max(passN, +m[1])
  }
  passN += 1
  const tag = OPT.scratch ? 'dev' : `pass-${passN}`
  if (OPT.scratch) fs.mkdirSync(path.join(outDir, 'dev'), { recursive: true })
  const fileOf = n => OPT.scratch ? path.join(outDir, 'dev', n) : path.join(outDir, `${tag}-${n}`)

  if (OPT.build) {
    log('building app (vite build)...')
    execFileSync(process.execPath, [path.join(ROOT, 'node_modules/vite/bin/vite.js'), 'build', '--logLevel', 'error'], { cwd: ROOT, stdio: 'inherit' })
  }
  const { srv, port } = await serve(path.join(ROOT, 'dist'))
  const browser = await launchBrowser()

  const consoleErrors = []
  const pageErrors = []

  // WebGPU availability probe (for backend auto + limitation note)
  const probePage = await browser.newPage()
  const gpuProbe = await probePage.evaluate(async () => {
    if (!navigator.gpu) return { available: false, why: 'navigator.gpu undefined' }
    const a = await navigator.gpu.requestAdapter().catch(e => null)
    if (!a) return { available: false, why: 'requestAdapter -> null' }
    const d = await a.requestDevice().catch(e => null)
    return { available: !!d, why: d ? 'ok' : 'requestDevice failed' }
  })
  await probePage.close()
  let backend = OPT.backend
  if (backend === 'auto') backend = gpuProbe.available ? 'webgpu' : 'webgl'
  const limitation = gpuProbe.available ? null
    : `ENVIRONMENT LIMITATION: WebGPU unavailable in this container's Chromium (${gpuProbe.why}); ` +
      'confirmed for headless AND headed system Chrome + CfT builds. Gates run on webgl per VERIFY.md; ' +
      'the required single webgpu matrix capture is impossible here and is logged each pass.'
  log('webgpu probe:', JSON.stringify(gpuProbe), '→ backend:', backend)

  const lab = await browser.newPage({ viewport: { width: 200, height: 100 } })
  await lab.setContent(LAB_HTML.replace('<\\/script>', '</script>'))

  // ------------------------------------------------ per-preset capture pass
  const shots = {}    // shots[preset][camId] = b64
  const stats = {}    // stats[preset] = getStats() result
  const consts = {}
  const g5data = {}   // {pairsPng:[b64,b64], boundaryPng, samplePairs, flow, camPose, causticInfo}
  const sweepShots = []
  const sweepPreset = PRESETS[(passN - 1) % PRESETS.length]
  const failures = []  // structural failures worth surfacing in the table

  async function newAppPage (preset) {
    const page = await browser.newPage({ viewport: { width: VIEW_W, height: VIEW_H }, deviceScaleFactor: 1 })
    page.on('console', m => { if (m.type() === 'error') consoleErrors.push(`[${preset}] ${m.text().slice(0, 300)}`) })
    page.on('pageerror', e => pageErrors.push(`[${preset}] ${String(e).slice(0, 400)}`))
    const cdp = await page.context().newCDPSession(page)
    await page.goto(`http://127.0.0.1:${port}/?verify=1&backend=${backend}&preset=${preset}`, { waitUntil: 'load', timeout: 30000 })
    const ok = await page.waitForFunction(() => window.__oo && (window.__oo.ready || window.__oo.failed), null, { timeout: 45000 })
      .then(() => page.evaluate(() => window.__oo.failed ? 'failed:' + window.__oo.failed : 'ok'))
      .catch(e => 'timeout waiting for __oo.ready')
    if (ok !== 'ok') failures.push(`[${preset}] app did not become ready: ${ok}`)
    return { page, cdp }
  }
  const capture = async (cdp) => (await cdp.send('Page.captureScreenshot', { format: 'png' })).data
  const pump = (page, dt) => page.evaluate(d => window.__oo?.pump ? window.__oo.pump(d) : null, dt)
  const setCam = (page, pose) => page.evaluate(([p, l]) => window.__oo?.setCamera?.(p, l), pose)

  for (const preset of RUN_PRESETS) {
    log(`preset ${preset}: loading (backend=${backend})...`)
    const { page, cdp } = await newAppPage(preset)
    shots[preset] = {}
    // advance to t>=10s in chunks
    const t0 = Date.now()
    let simT = 0
    for (let i = 0; i < 40 && simT < 10; i++) {
      await pump(page, 1.0)
      simT = await page.evaluate(() => window.__oo?.time ? window.__oo.time() : NaN)
      if (!isFinite(simT)) break
    }
    log(`preset ${preset}: sim t=${fmt(simT, 2)}s after ${((Date.now() - t0) / 1000).toFixed(1)}s wall`)
    if (!(simT >= 10)) failures.push(`[${preset}] sim failed to reach t>=10s (t=${simT})`)
    consts[preset] = await page.evaluate(() => window.__oo?.getConstants ? window.__oo.getConstants() : null)

    for (const id of CAM_IDS) {
      await setCam(page, CAMS[id](preset))
      await pump(page, 0.05)
      shots[preset][id] = await capture(cdp)
    }
    stats[preset] = await page.evaluate(() => window.__oo?.getStats ? window.__oo.getStats() : null)

    // G5 material: boundary framing + two-frame flow pair (0.5 s apart)
    const ci = await page.evaluate(() => window.__oo?.getCausticInfo ? window.__oo.getCausticInfo() : null)
    if (ci) {
      const pose = CAMS.M9(preset)
      await setCam(page, pose)
      await pump(page, 0.05)
      const f1 = await capture(cdp)
      // re-read region (it may follow the camera; pose is already set)
      const ci2 = await page.evaluate(() => window.__oo.getCausticInfo())
      const seabedAt = await page.evaluate(([x, z]) => window.__oo?.getSeabedAt ? window.__oo.getSeabedAt(x, z) : null, [ci2.cx + ci2.r, pose[0][2]])
      const flow = await page.evaluate(([x, z]) => window.__oo?.getFlowAt ? window.__oo.getFlowAt(x, z) : null, [ci2.cx + ci2.r * 0.6, pose[0][2]])
      await pump(page, 0.5)
      const f2 = await capture(cdp)
      g5data[preset] = { f1, f2, ci: ci2, seabedAt, flow, pose }
    } else {
      g5data[preset] = null
    }

    // sweep on the designated preset
    if (preset === sweepPreset && RUN_PRESETS.includes(sweepPreset)) {
      log(`sweep on ${preset} (24 frames / 25 s)...`)
      for (let i = 0; i < SWEEP_N; i++) {
        const t = SWEEP_T * i / (SWEEP_N - 1)
        const { pos, look } = sweepPose(t)
        await setCam(page, [pos, look])
        await pump(page, i === 0 ? 0.05 : SWEEP_T / (SWEEP_N - 1))
        const b64 = await capture(cdp)
        sweepShots.push({ b64, label: `t=${t.toFixed(1)}s pos(${pos.map(v => v.toFixed(0)).join(',')})`, t, pos })
      }
    }
    await page.close()
  }

  // ------------------------------------------------------------ gate engine
  const gates = []  // {id, preset, value, threshold, pass, note}
  const addGate = (id, preset, pass, value, threshold, note = '') =>
    gates.push({ id, preset, pass: !!pass, value, threshold, note })
  async function safeGate (id, preset, fn) {
    try { await fn() } catch (e) {
      addGate(id, preset, false, 'ERROR', '', String(e).slice(0, 160))
    }
  }

  // G1 FAR DETAIL
  for (const p of RUN_PRESETS) {
    await safeGate('G1', p, async () => {
      const b64 = shots[p]?.M1
      if (!b64) return addGate('G1', p, false, 'no shot', '')
      const margin = p === 'storm' ? 18 : 12
      const hr = Math.round(horizonRow(M1Y[p], 300)) + margin
      const waterH = VIEW_H - hr
      const third = Math.floor(waterH / 3)
      const far = await lab.evaluate(([b, y0, y1]) => window.lapVarBand(b, 0, y0, 1280, y1), [b64, hr, hr + third])
      const near = await lab.evaluate(([b, y0, y1]) => window.lapVarBand(b, 0, y0, 1280, y1), [b64, VIEW_H - third, VIEW_H])
      const ratio = near > 0 ? far / near : 0
      addGate('G1', p, ratio >= 0.25 && near > 1, ratio, '>=0.25', `lapVar far=${fmt(far, 1)} near=${fmt(near, 1)} rows ${hr}..${hr + third} vs ${VIEW_H - third}..${VIEW_H}`)
      const crop = await lab.evaluate(([b, x, y, w, h]) => window.cropPng(b, x, y, w, h, 1), [b64, 480, hr, 320, third])
      const crop2 = await lab.evaluate(([b, x, y, w, h]) => window.cropPng(b, x, y, w, h, 1), [b64, 480, VIEW_H - third, 320, third])
      const sheet = await lab.evaluate(([cells, t]) => window.makeSheet(cells, 2, 320, Math.min(180, 200), t),
        [[{ b64: crop, label: `far band lapVar=${fmt(far, 1)}` }, { b64: crop2, label: `near band lapVar=${fmt(near, 1)}` }], `G1 ${p} ratio=${fmt(ratio)}`])
      fs.writeFileSync(fileOf(`g1-${p}.png`), Buffer.from(sheet, 'base64'))
    })
  }

  // G2 PRESET DISTANCE
  await safeGate('G2', 'all', async () => {
    if (RUN_PRESETS.length < 3) return addGate('G2', 'all', false, 'needs all presets', '>=0.12', 'partial run')
    for (const cam of ['M1', 'M4']) {
      const vals = []
      for (let i = 0; i < 3; i++) for (let j = i + 1; j < 3; j++) {
        const a = shots[PRESETS[i]]?.[cam]; const b = shots[PRESETS[j]]?.[cam]
        if (!a || !b) { vals.push(0); continue }
        vals.push(await lab.evaluate(([x, y]) => window.rmsDiff(x, y), [a, b]))
      }
      const mean = vals.reduce((s, v) => s + v, 0) / vals.length
      addGate('G2', cam, mean >= 0.12, mean, '>=0.12', `pairs ${vals.map(v => fmt(v)).join(' ')}`)
    }
  })

  // G3 NO VOID
  for (const p of RUN_PRESETS) {
    await safeGate('G3', p, async () => {
      let total = 0; const bad = []
      for (const id of CAM_IDS) {
        const b64 = shots[p]?.[id]
        if (!b64) { bad.push(id + ':noshot'); continue }
        const n = await lab.evaluate(b => window.countMagenta(b), b64)
        total += n
        if (n > 0) bad.push(`${id}:${n}px`)
      }
      addGate('G3', p, total === 0 && bad.length === 0, total, '=0', bad.join(' ') || 'clean')
    })
  }

  // G4 PHYSICS ASSERTS (storm readbacks + shafts + constants match)
  await safeGate('G4', 'storm', async () => {
    const st = stats.storm
    const cs = consts.storm
    const constOk = cs && Math.abs(cs.seaLevel - EXPECT_CONST.seaLevel) < 1e-3 &&
      Math.abs(cs.seabedBaseY - EXPECT_CONST.seabedBaseY) < 1e-3 &&
      Math.abs(cs.causticRadius - EXPECT_CONST.causticRadius) < 1e-3
    if (!st) {
      addGate('G4a', 'storm', false, 'no readback', '>2m', 'getStats() null/absent')
      addGate('G4b', 'storm', false, 'no readback', '<10deg', 'getStats() null/absent')
      addGate('G4c', 'storm', false, 'no readback', '>=4m', 'getStats() null/absent')
      return
    }
    const clr = st.minSurfaceY - st.maxSeabedTop
    addGate('G4a', 'storm', constOk && clr > 2, clr, '>2m', `minSurf=${fmt(st.minSurfaceY, 2)} maxSeabed=${fmt(st.maxSeabedTop, 2)}${constOk ? '' : ' CONSTANTS MISMATCH'}`)
    // shafts vs refracted sun
    const s = st.sunDir
    if (!Array.isArray(st.shafts) || !st.shafts.length || !s) {
      addGate('G4b', 'storm', false, st.shafts ? st.shafts.length : 'none', '>=1 shaft, <10deg', 'no shafts/sunDir reported')
    } else {
      const L = Math.hypot(...s); const d = [s[0] / L, s[1] / L, s[2] / L] // sun -> scene dir (downward)
      const cosI = -d[1]; const sinI = Math.hypot(d[0], d[2])
      const sinT = sinI / 1.333, cosT = Math.sqrt(1 - sinT * sinT)
      const hx = sinI > 1e-6 ? d[0] / sinI : 0, hz = sinI > 1e-6 ? d[2] / sinI : 0
      const refr = [hx * sinT, -cosT, hz * sinT]
      let worst = 0; let floorFails = 0
      for (const sh of st.shafts) {
        const a = sh.axis; const al = Math.hypot(...a)
        const dotv = (a[0] * refr[0] + a[1] * refr[1] + a[2] * refr[2]) / (al || 1)
        const ang = Math.acos(Math.min(1, Math.abs(dotv))) * 180 / Math.PI
        worst = Math.max(worst, ang)
        if (!(sh.bottomY <= sh.floorY + 0.5)) floorFails++
      }
      addGate('G4b', 'storm', worst < 10 && floorFails === 0, worst, '<10deg', `${st.shafts.length} shafts, floorFails=${floorFails}`)
    }
    addGate('G4c', 'storm', st.hs >= 4, st.hs, '>=4m', 'Hs=4*std(surface)')
  })

  // G5 CAUSTIC INTEGRITY
  await safeGate('G5', 'blackflag', async () => {
    const d = g5data.blackflag
    if (!d) return addGate('G5', 'blackflag', false, 'no caustic info', '', 'getCausticInfo() absent')
    const [camPos, camLook] = d.pose
    const proj = viewProject(camPos, camLook)
    // sample the boundary circle where it faces the camera
    const pairs = []; const marks = []
    for (let i = 0; i < 96; i++) {
      const a = i / 96 * Math.PI * 2
      const bx = d.ci.cx + Math.cos(a) * d.ci.r, bz = d.ci.cz + Math.sin(a) * d.ci.r
      const by = (d.seabedAt ?? -28) + 0.02
      const P = proj([bx, by, bz]); if (!P || P[2] > 90) continue
      // inward/outward offset in world space toward/away from region center
      const inx = d.ci.cx - bx, inz = d.ci.cz - bz; const il = Math.hypot(inx, inz)
      const o = 2.2
      const Pi = proj([bx + inx / il * o, by, bz + inz / il * o])
      const Po = proj([bx - inx / il * o, by, bz - inz / il * o])
      if (!Pi || !Po) continue
      if (Pi[0] < 20 || Pi[0] > VIEW_W - 20 || Pi[1] < 20 || Pi[1] > VIEW_H - 20) continue
      if (Po[0] < 20 || Po[0] > VIEW_W - 20 || Po[1] < 20 || Po[1] > VIEW_H - 20) continue
      pairs.push([Pi[0], Pi[1], Po[0], Po[1]])
      marks.push({ t: 'circle', x: P[0], y: P[1], r: 4, col: '#ff0' })
    }
    if (pairs.length < 8) {
      addGate('G5a', 'blackflag', false, pairs.length, '>=8 samples', 'boundary not sufficiently in frame')
    } else {
      const steps = await lab.evaluate(([b, pr]) => window.boundaryStep(b, pr, 7), [d.f1, pairs])
      const mean = steps.reduce((s, v) => s + v, 0) / steps.length
      addGate('G5a', 'blackflag', mean < 0.08, mean, '<0.08', `${steps.length} boundary samples`)
      const ann = await lab.evaluate(([b, m]) => window.annotate(b, m), [d.f1, marks])
      fs.writeFileSync(fileOf('g5-boundary.png'), Buffer.from(ann, 'base64'))
    }
    // flow correlation on a seabed point inside the region
    const target = [d.ci.cx + d.ci.r * 0.6, (d.seabedAt ?? -28), camPos[2]]
    const T = proj(target)
    if (!T) {
      addGate('G5b', 'blackflag', false, 'target offscreen', '', '')
    } else {
      const best = await lab.evaluate(([a, b, cx, cy]) => window.ncc(a, b, cx | 0, cy | 0, 168, 20), [d.f1, d.f2, T[0], T[1]])
      // pixel offset -> world direction on the seabed plane
      const invAt = (px, py) => { // intersect view ray with plane y=target[1]
        const tanF = Math.tan(FOV_Y * Math.PI / 360), aspect = VIEW_W / VIEW_H
        const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
        const crs = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
        const nrm = v => { const l = Math.hypot(...v) || 1; return v.map(u => u / l) }
        const f = nrm(sub(camLook, camPos))
        let up = Math.abs(f[1]) > 0.999 ? [0, 0, -1] : [0, 1, 0]
        const r = nrm(crs(f, up)); up = crs(r, f)
        const ndx = (px / VIEW_W * 2 - 1) * tanF * aspect, ndy = (1 - py / VIEW_H * 2) * tanF
        const dir = nrm([f[0] + r[0] * ndx + up[0] * ndy, f[1] + r[1] * ndx + up[1] * ndy, f[2] + r[2] * ndx + up[2] * ndy])
        const t = (target[1] - camPos[1]) / dir[1]
        return [camPos[0] + dir[0] * t, camPos[2] + dir[2] * t]
      }
      const w0 = invAt(T[0], T[1]); const w1 = invAt(T[0] + best.dx, T[1] + best.dy)
      const disp = [w1[0] - w0[0], w1[1] - w0[1]]
      const mag = Math.hypot(...disp)
      const flow = d.flow
      let angle = null
      if (flow && Math.hypot(...flow) > 1e-6 && mag > 1e-6) {
        const dot = (disp[0] * flow[0] + disp[1] * flow[1]) / (mag * Math.hypot(...flow))
        angle = Math.acos(Math.max(-1, Math.min(1, dot))) * 180 / Math.PI
      }
      const shifted = (Math.abs(best.dx) + Math.abs(best.dy)) > 0
      const pass = shifted && angle !== null && angle < 25 && best.c > 0.2
      addGate('G5b', 'blackflag', pass, angle === null ? 'n/a' : angle, '<25deg & offset!=0',
        `ncc=${fmt(best.c, 2)} px(${best.dx},${best.dy}) world(${fmt(disp[0], 2)},${fmt(disp[1], 2)}) flow=${flow ? flow.map(v => fmt(v, 2)).join(',') : 'null'}`)
      const cropA = await lab.evaluate(([b, x, y]) => window.cropPng(b, x - 84, y - 84, 168, 168, 1.5), [d.f1, T[0] | 0, T[1] | 0])
      const cropB = await lab.evaluate(([b, x, y]) => window.cropPng(b, x - 84, y - 84, 168, 168, 1.5), [d.f2, T[0] | 0, T[1] | 0])
      const sheet = await lab.evaluate(([cells, t]) => window.makeSheet(cells, 2, 252, 252, t),
        [[{ b64: cropA, label: 't' }, { b64: cropB, label: 't+0.5s' }], `G5b flow corr: px(${best.dx},${best.dy}) ncc=${fmt(best.c, 2)} angle=${angle === null ? 'n/a' : fmt(angle, 1)}`])
      fs.writeFileSync(fileOf('g5-flow.png'), Buffer.from(sheet, 'base64'))
    }
  })

  // G6 FOLD SANITY (storm M1/M4)
  await safeGate('G6', 'storm', async () => {
    const flat = (stats.storm && stats.storm.flatConstants) || []
    for (const cam of ['M1', 'M4']) {
      const b64 = shots.storm?.[cam]
      if (!b64) { addGate('G6', 'storm ' + cam, false, 'no shot', '<0.3%'); continue }
      const y0 = cam === 'M1' ? Math.round(horizonRow(M1Y.storm, 300)) + 18 : 0
      const r = await lab.evaluate(([b, y, cols]) => window.flatCount(b, y, cols, 10), [b64, y0, flat])
      const frac = Math.max(r.declaredFrac, r.autoMaxFrac)
      addGate('G6', `storm ${cam}`, frac < 0.003, frac, '<0.003',
        `declared=${(r.declaredFrac * 100).toFixed(3)}% autoFlat=${(r.autoMaxFrac * 100).toFixed(3)}% (rgb bucket ${r.autoCol}) flatConsts=${flat.length}`)
    }
  })

  // -------------------------------------------------------------- sheets
  log('assembling sheets...')
  const matrixCells = []
  for (const p of PRESETS) {
    for (const id of CAM_IDS) {
      matrixCells.push({ b64: shots[p]?.[id] || null, label: `${id} ${p}` })
    }
  }
  const matrixB64 = await lab.evaluate(([cells, t]) => window.makeSheet(cells, 10, 320, 180, t),
    [matrixCells, `${tag} matrix — backend=${backend} — ${new Date().toISOString()}`])
  fs.writeFileSync(fileOf('matrix.png'), Buffer.from(matrixB64, 'base64'))

  if (sweepShots.length) {
    const sweepB64 = await lab.evaluate(([cells, t]) => window.makeSheet(cells, 6, 320, 180, t),
      [sweepShots.map(s => ({ b64: s.b64, label: s.label })), `${tag} sweep — preset=${sweepPreset} — 25s spiral, 24 frames`])
    fs.writeFileSync(fileOf('sweep.png'), Buffer.from(sweepB64, 'base64'))
  } else {
    failures.push(`sweep not captured (sweep preset ${sweepPreset} not in run set)`)
  }

  // ------------------------------------------------------------ gate table
  const lines = []
  lines.push(`OpenOcean v2 — gate table — ${tag} — ${new Date().toISOString()}`)
  lines.push(`backend=${backend} presets=${RUN_PRESETS.join(',')} sweepPreset=${sweepPreset} viewport=${VIEW_W}x${VIEW_H}`)
  if (limitation) lines.push(limitation)
  if (failures.length) lines.push('STRUCTURAL FAILURES: ' + failures.join(' | '))
  lines.push('')
  lines.push('gate | scope         | value        | threshold        | verdict | note')
  lines.push('-----+---------------+--------------+------------------+---------+-----')
  for (const g of gates) {
    lines.push([
      g.id.padEnd(4), String(g.preset).padEnd(13),
      (typeof g.value === 'number' ? fmt(g.value, 4) : String(g.value)).padEnd(12),
      String(g.threshold).padEnd(16),
      (g.pass ? 'PASS' : 'FAIL').padEnd(7), g.note,
    ].join(' | '))
  }
  lines.push('')
  const gateFail = gates.filter(g => !g.pass).length
  lines.push(`SUMMARY: ${gates.length - gateFail}/${gates.length} gate rows pass; consoleErrors=${consoleErrors.length}; pageErrors=${pageErrors.length}`)
  if (consoleErrors.length) lines.push('console errors (first 5):', ...consoleErrors.slice(0, 5).map(s => '  ' + s))
  if (pageErrors.length) lines.push('PAGE ERRORS (run FAILS):', ...pageErrors.slice(0, 5).map(s => '  ' + s))
  const table = lines.join('\n')
  fs.writeFileSync(fileOf('gates.txt'), table + '\n')
  console.log('\n' + table + '\n')
  log(`evidence written: ${fileOf('matrix.png')} ${sweepShots.length ? fileOf('sweep.png') : '(no sweep)'} ${fileOf('gates.txt')}`)

  await browser.close()
  srv.close()
  if (pageErrors.length) process.exit(1)
}

main().catch(e => { console.error(e); process.exit(2) })
