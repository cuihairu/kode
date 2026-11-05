#!/usr/bin/env node
// 校准 src/hooks.ts 的 hook sourceLocation 锚点到本地引擎源码真实调用行。
//
// 背景:KBEngine 引擎源(entity.cpp 等)改动会位移回调调用行,导致
// tests/hooks.test.ts「KBEngine hooks vs engine source」本地红——
// 这不是 kode 缺陷,是锚点相对引擎树漂移。本脚本按「每 ref 文件分组 →
// 取该文件含 "hookname" 的真调用行 → 旧行配最近未用真行」重算并写回。
// 幂等:已校准时第二次运行零改动。
//
// 引擎根解析与 tests/helpers/engineRoot.ts 一致:
//   KBENGINE_ROOT 环境变量,否则仓库同级 ../kbengine 检出;
//   KBENGINE_ROOT=off 显式禁用(本脚本无引擎可校,直接退出)。
//
// 用法:node scripts/recalibrate-hook-anchors.mjs
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');

// ---- 引擎根解析 ----
function resolveEngineRoot() {
  if (process.env.KBENGINE_ROOT === 'off') {
    return null;
  }
  const candidates = [
    process.env.KBENGINE_ROOT,
    path.resolve(repoRoot, '..', 'kbengine')
  ].filter(Boolean);
  for (const c of candidates) {
    if (fs.existsSync(path.join(c, 'kbe', 'src', 'lib', 'entitydef'))) {
      return c;
    }
  }
  return null;
}

const engineRoot = resolveEngineRoot();
if (!engineRoot) {
  console.log('no engine root (KBENGINE_ROOT=off or missing checkout); nothing to calibrate');
  process.exit(0);
}

// ---- 读 hooks.ts ----
const hooksPath = path.join(repoRoot, 'src', 'hooks.ts');
let src = fs.readFileSync(hooksPath, 'utf8');

const locRe = /sourceLocation:\s*['"]([^'"]+)['"]/g;
const nameRe = /(?:^|\n)\s*name:\s*['"](\w+)['"]/g;
const matches = [];
let m;
while ((m = locRe.exec(src))) {
  const before = src.slice(0, m.index);
  const nm = [...before.matchAll(nameRe)].pop();
  matches.push({ name: nm ? nm[1] : '?', raw: m[1], start: m.index, end: locRe.lastIndex });
}

const fileCache = new Map();
const linesOf = (rel) => {
  if (!fileCache.has(rel)) {
    fileCache.set(rel, fs.readFileSync(path.join(engineRoot, rel), 'utf8').split('\n'));
  }
  return fileCache.get(rel);
};

const edits = [];
const log = [];
for (const { name, raw, start, end } of matches) {
  const refs = raw.split(';').map((s) => s.trim());
  const byFile = new Map();
  for (const ref of refs) {
    const mm = /^(.+):(\d+)$/.exec(ref);
    if (!mm) continue;
    if (!byFile.has(mm[1])) byFile.set(mm[1], []);
    byFile.get(mm[1]).push(Number(mm[2]));
  }
  const newRefs = [];
  let changed = false;
  for (const [file, oldLines] of byFile) {
    const lines = linesOf(file);
    const trueLines = [];
    lines.forEach((ln, i) => { if (ln.includes('"' + name + '"')) trueLines.push(i + 1); });
    const used = new Set();
    for (const ol of oldLines) {
      let best = null;
      let bestD = Infinity;
      for (const tl of trueLines) {
        if (used.has(tl)) continue;
        const d = Math.abs(tl - ol);
        if (d < bestD) { bestD = d; best = tl; }
      }
      const chosen = best !== null ? best : ol;
      used.add(chosen);
      newRefs.push(`${file}:${chosen}`);
      if (chosen !== ol) {
        changed = true;
        log.push(`${name}\t${file}:${ol} -> ${file}:${chosen}`);
      }
    }
  }
  if (changed) edits.push({ start, end, newStr: newRefs.join('; ') });
}

if (edits.length === 0) {
  console.log('anchors already match engine tree (0 changes)');
  process.exit(0);
}

edits.sort((a, b) => b.start - a.start);
for (const e of edits) {
  src = src.slice(0, e.start) + `sourceLocation: '${e.newStr}'` + src.slice(e.end);
}
fs.writeFileSync(hooksPath, src, 'utf8');
console.log(`calibrated ${edits.length} sourceLocation(s):`);
for (const line of log) console.log('  ' + line);
