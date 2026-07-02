// Evidence composer: pack image panels horizontally (time strips,
// ours|reference side-by-sides) with pngjs only.
// usage: node scripts/compose.mjs out.png "img.png[:crop=x,y,w,h][:h=H]" ...
// Panels are optionally cropped, then scaled (nearest) to the max panel
// height (or H if given on all), and packed with a light gutter.
import fs from 'node:fs';
import { PNG } from 'pngjs';

const [out, ...specs] = process.argv.slice(2);
if (!out || specs.length === 0) {
  console.error('usage: node scripts/compose.mjs out.png "img[:crop=x,y,w,h][:h=H]" ...');
  process.exit(2);
}

const GAP = 6;
const panels = specs.map((spec) => {
  const parts = spec.split(':');
  const file = parts[0];
  let png = PNG.sync.read(fs.readFileSync(file));
  let targetH = null;
  for (const p of parts.slice(1)) {
    if (p.startsWith('crop=')) {
      const [x, y, w, h] = p.slice(5).split(',').map(Number);
      const cut = new PNG({ width: w, height: h });
      PNG.bitblt(png, cut, x, y, w, h, 0, 0);
      png = cut;
    } else if (p.startsWith('h=')) {
      targetH = Number(p.slice(2));
    }
  }
  return { png, targetH };
});

const H = Math.max(...panels.map((p) => p.targetH ?? p.png.height));
const scaled = panels.map(({ png, targetH }) => {
  const h = targetH ?? H;
  const s = h / png.height;
  const w = Math.round(png.width * s);
  const outP = new PNG({ width: w, height: h });
  for (let y = 0; y < h; y++) {
    const sy = Math.min(png.height - 1, Math.floor(y / s));
    for (let x = 0; x < w; x++) {
      const sx = Math.min(png.width - 1, Math.floor(x / s));
      const si = (sy * png.width + sx) * 4;
      const di = (y * w + x) * 4;
      outP.data[di] = png.data[si];
      outP.data[di + 1] = png.data[si + 1];
      outP.data[di + 2] = png.data[si + 2];
      outP.data[di + 3] = 255;
    }
  }
  return outP;
});

const totalW = scaled.reduce((a, p) => a + p.width, 0) + GAP * (scaled.length - 1);
const maxH = Math.max(...scaled.map((p) => p.height));
const canvas = new PNG({ width: totalW, height: maxH });
canvas.data.fill(235);
for (let i = 3; i < canvas.data.length; i += 4) canvas.data[i] = 255;
let ox = 0;
for (const p of scaled) {
  PNG.bitblt(p, canvas, 0, 0, p.width, p.height, ox, 0);
  ox += p.width + GAP;
}
fs.writeFileSync(out, PNG.sync.write(canvas));
console.log(`${out}: ${totalW}x${maxH} (${scaled.length} panels)`);
