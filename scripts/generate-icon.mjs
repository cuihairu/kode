// 扩展图标生成器(批89):零依赖纯 Node 脚本,同源几何常量一次性产出
// assets/icon.svg(矢量真源)与 assets/icon.png(自渲染光栅,替代缺失的
// SVG 光栅化工具链;rsvg-convert/inkscape/magick/cairosvg 均不在位,
// ffmpeg 的 SVG 解码对渐变/描边/圆角覆盖不明,故 PNG 由本脚本直接渲染)。
//
// 设计假设(批89 注明):K 字标 + 靛青竖向渐变圆角方块;字形只用几何
// (圆帽描边),不含 <text> 元素,保证渲染与字体环境无关、脚本可复现。
// 运行:node scripts/generate-icon.mjs
import * as fs from 'fs';
import * as path from 'path';
import * as zlib from 'zlib';
import { fileURLToPath } from 'url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(root, 'assets');

// ---- 同源几何常量(SVG 与 PNG 均由它们派生)----
const SIZE = 256; // ≥128,VSCode Marketplace 最低要求
const RADIUS = 56; // 背景圆角半径
const STROKE = 30; // K 字描边宽度
const TOP_RGB = [0x63, 0x66, 0xf1]; // #6366F1 靛
const BOTTOM_RGB = [0x06, 0xb6, 0xd4]; // #06B6D4 青
// K 字三笔:竖干 + 上斜 + 下斜(圆帽线段,坐标以 256 画布为准)
const SEGMENTS = [
  [84, 64, 84, 192], // 竖干
  [102, 128, 176, 62], // 上斜臂
  [102, 128, 176, 194] // 下斜臂
];

// ---- SVG 真源 ----
const svg = [
  `<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${SIZE}" viewBox="0 0 ${SIZE} ${SIZE}">`,
  '  <defs>',
  `    <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1">`,
  `      <stop offset="0" stop-color="#${TOP_RGB.map(c => c.toString(16).padStart(2, '0')).join('')}"/>`,
  `      <stop offset="1" stop-color="#${BOTTOM_RGB.map(c => c.toString(16).padStart(2, '0')).join('')}"/>`,
  '    </linearGradient>',
  '  </defs>',
  `  <rect width="${SIZE}" height="${SIZE}" rx="${RADIUS}" fill="url(#bg)"/>`,
  `  <path d="${SEGMENTS.map(seg => `M${seg[0]} ${seg[1]} L${seg[2]} ${seg[3]}`).join(' ')}"`,
  '        fill="none" stroke="#ffffff"',
  `        stroke-width="${STROKE}" stroke-linecap="round"/>`,
  '</svg>',
  ''
].join('\n');

// ---- 光栅化(SDF 覆盖 + 3×3 超采样抗锯齿)----
const half = SIZE / 2;
const roundedRectSDF = (x, y) => {
  // 圆角矩形有向距离:负值在内部(中心 half、角半径 RADIUS)
  const qx = Math.abs(x - half) - (half - RADIUS);
  const qy = Math.abs(y - half) - (half - RADIUS);
  return (
    Math.min(Math.max(qx, qy), 0) +
    Math.hypot(Math.max(qx, 0), Math.max(qy, 0))
  );
};

const distToSegment = (px, py, seg) => {
  const [x1, y1, x2, y2] = seg;
  const dx = x2 - x1;
  const dy = y2 - y1;
  const lengthSq = dx * dx + dy * dy;
  const t = Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / lengthSq));
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
};

const insideGlyph = (x, y) =>
  SEGMENTS.some(seg => distToSegment(x, y, seg) <= STROKE / 2);

const SUB = 3; // 每像素 3×3 子采样
const SUB_STEP = 1 / SUB;
const SUB_OFFSET = (SUB - 1) / (2 * SUB);

const raw = Buffer.alloc(SIZE * (SIZE * 4 + 1)); // 每行前置 filter 字节 0
for (let py = 0; py < SIZE; py++) {
  const rowStart = py * (SIZE * 4 + 1);
  raw[rowStart] = 0;
  for (let px = 0; px < SIZE; px++) {
    let coverage = 0;
    let rSum = 0;
    let gSum = 0;
    let bSum = 0;
    for (let sy = 0; sy < SUB; sy++) {
      for (let sx = 0; sx < SUB; sx++) {
        const x = px + SUB_OFFSET + sx * SUB_STEP;
        const y = py + SUB_OFFSET + sy * SUB_STEP;
        if (roundedRectSDF(x, y) >= 0) {
          continue;
        }
        coverage += 1;
        if (insideGlyph(x, y)) {
          rSum += 255;
          gSum += 255;
          bSum += 255;
        } else {
          // 竖向线性渐变:按子采样 y 在整幅高度插值
          const t = y / (SIZE - 1);
          rSum += TOP_RGB[0] + (BOTTOM_RGB[0] - TOP_RGB[0]) * t;
          gSum += TOP_RGB[1] + (BOTTOM_RGB[1] - TOP_RGB[1]) * t;
          bSum += TOP_RGB[2] + (BOTTOM_RGB[2] - TOP_RGB[2]) * t;
        }
      }
    }
    const n = SUB * SUB;
    const alpha = Math.round((coverage / n) * 255);
    const o = rowStart + 1 + px * 4;
    raw[o] = coverage ? Math.round(rSum / coverage) : 0;
    raw[o + 1] = coverage ? Math.round(gSum / coverage) : 0;
    raw[o + 2] = coverage ? Math.round(bSum / coverage) : 0;
    raw[o + 3] = alpha;
  }
}

// ---- PNG 编码(IHDR/IDAT/IEND + CRC32)----
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

const crc32 = buf => {
  let c = 0xffffffff;
  for (const byte of buf) {
    c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
};

const chunk = (type, data) => {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'ascii');
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
};

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(SIZE, 0);
ihdr.writeUInt32BE(SIZE, 4);
ihdr[8] = 8; // 位深
ihdr[9] = 6; // RGBA
const idat = zlib.deflateSync(raw, { level: 9 });

const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', idat),
  chunk('IEND', Buffer.alloc(0))
]);

// ---- 落盘 ----
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, 'icon.svg'), svg);
fs.writeFileSync(path.join(outDir, 'icon.png'), png);
console.log(
  `icon.svg ${svg.length}B, icon.png ${png.length}B (${SIZE}x${SIZE} RGBA)`
);
