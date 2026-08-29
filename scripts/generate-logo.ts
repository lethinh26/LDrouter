// One-off: extract the embedded PNG from latedev.svg and emit small favicon + logo.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SVG_PATH = path.join(ROOT, 'latedev.svg');
const PUBLIC_DIR = path.join(ROOT, 'src/web/public');

function extractPngFromSvg(svgPath: string): Buffer {
  const svg = fs.readFileSync(svgPath, 'utf8');
  const match = svg.match(/href="data:image\/png;base64,([A-Za-z0-9+/=]+)"/);
  if (!match) throw new Error('No embedded PNG found in latedev.svg');
  return Buffer.from(match[1]!, 'base64');
}

function boxDownsample(src: PNG.PNG, targetSize: number): PNG.PNG {
  const dst = new PNG({ width: targetSize, height: targetSize });
  const scale = src.width / targetSize; // source pixels per output pixel
  for (let y = 0; y < targetSize; y++) {
    for (let x = 0; x < targetSize; x++) {
      let r = 0, g = 0, b = 0, a = 0, n = 0;
      const x0 = Math.floor(x * scale), x1 = Math.min(Math.ceil((x + 1) * scale), src.width);
      const y0 = Math.floor(y * scale), y1 = Math.min(Math.ceil((y + 1) * scale), src.height);
      for (let sy = y0; sy < y1; sy++) {
        for (let sx = x0; sx < x1; sx++) {
          const i = (sy * src.width + sx) * 4;
          r += src.data[i]; g += src.data[i + 1]; b += src.data[i + 2]; a += src.data[i + 3];
          n++;
        }
      }
      const o = (y * targetSize + x) * 4;
      dst.data[o] = r / n; dst.data[o + 1] = g / n; dst.data[o + 2] = b / n; dst.data[o + 3] = a / n;
    }
  }
  return dst;
}

const pngData = extractPngFromSvg(SVG_PATH);
const src = PNG.sync.read(pngData);
fs.mkdirSync(PUBLIC_DIR, { recursive: true });
fs.writeFileSync(path.join(PUBLIC_DIR, 'favicon.png'), PNG.sync.write(boxDownsample(src, 48)));
fs.writeFileSync(path.join(PUBLIC_DIR, 'logo.png'), PNG.sync.write(boxDownsample(src, 128)));
console.log('Generated favicon.png (48x48) and logo.png (128x128)');
