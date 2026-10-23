#!/usr/bin/env node
// parser 级 head-to-head 的「大文件/吞吐」语料生成器(docs/perf/2026-parser-head2head.md)。
//
// 与 docs/kode2/pr-005.md §bench 的合成大样本同构(同 gen_def 文本形状,便于与
// PR-005 的 2001 文件 / 10.5MB / 19.9MB/s 口径对账):
//   N 个 Def*.def(每文件 P 个属性)+ 1 个 MEGA.def(M 个属性)
//
// 运行:node scripts/gen-parser-h2h-corpus.mjs --out /tmp/kode-h2h/synth [--files 2000] [--props 64] [--mega 20000]
// 输出确定性(文件名/内容固定),同参数任意机器可复现同 bytes 数。

import fs from 'node:fs';
import path from 'node:path';

const argValue = (name, fallback) => {
  const idx = process.argv.indexOf(`--${name}`);
  return idx >= 0 && idx + 1 < process.argv.length ? process.argv[idx + 1] : fallback;
};

const outDir = path.resolve(argValue('out', '/tmp/kode-h2h/synth'));
const copyFrom = argValue('unique-copy', null);
const fileCount = Number(argValue('files', '2000'));
const propCount = Number(argValue('props', '64'));
const megaProps = Number(argValue('mega', '20000'));

// 模式二:--unique-copy <src> 复制既有语料,给每份 .def/alias.xml 追加一行唯一头注释。
// 用途:真实资产集里存在成百份逐字节相同的 .def,会让 TS 侧 parseDefDocument 的全文文本缓存
// (src/defParser.ts:69)整份命中,FULL/单文件口径测到的就不是解析成本。唯一化只改注释,
// 不改变解析面(props/methods 计数不变,由 SURFACE 行两侧对拍)。
if (copyFrom) {
  const src = path.resolve(copyFrom);
  const walk = (dir, rel) => {
    fs.mkdirSync(path.join(outDir, rel), { recursive: true });
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const from = path.join(dir, entry.name);
      const relPath = path.join(rel, entry.name);
      if (entry.isDirectory()) { walk(from, relPath); continue; }
      const unique = entry.name.endsWith('.def') || entry.name === 'alias.xml';
      const body = fs.readFileSync(from, 'utf8');
      const text = unique ? `<!-- h2h ${relPath.split(path.sep).join('/')} -->\n${body}` : body;
      fs.writeFileSync(path.join(outDir, relPath), text);
      copied += Buffer.byteLength(text, 'utf8');
    }
  };
  let copied = 0;
  fs.mkdirSync(outDir, { recursive: true });
  walk(src, '');
  console.log(`unique-copy src=${src} out=${outDir} bytes=${copied}`);
  process.exit(0);
}

// 与 crates/kode-parser/examples/bench_parse.rs::gen_def 逐字节同形状,但每文件加一行唯一
// 头注释:TS 侧 parseDefDocument 有「按全文文本」键的 8 条文档缓存(src/defParser.ts:69),
// 内容完全相同的 N 个文件会让 TS 侧退化成缓存命中,测不到解析成本。真实 DEF 每份都不同,
// 头注释(真实 DEF 也常有)只是让语料具备这一点。
function genDef(props, id) {
  let s = `<!-- Def${id} -->\n<root>\n\t<Properties>\n`;
  for (let i = 0; i < props; i += 1) {
    s += `\t<p${i}>\n\t\t<Type> UINT32 </Type>\n\t\t<Flags> ALL_CLIENTS </Flags>\n\t</p${i}>\n`;
  }
  return `${s}\t</Properties>\n</root>\n`;
}

fs.mkdirSync(outDir, { recursive: true });
let bytes = 0;
const small = genDef(propCount, 0);
for (let i = 0; i < fileCount; i += 1) {
  const name = `Def${String(i).padStart(4, '0')}.def`;
  const body = i === 0 ? small : genDef(propCount, i);
  fs.writeFileSync(path.join(outDir, name), body);
  bytes += Buffer.byteLength(body, 'utf8');
}
const mega = genDef(megaProps, 'MEGA');
fs.writeFileSync(path.join(outDir, 'MEGA.def'), mega);
bytes += Buffer.byteLength(mega, 'utf8');

console.log(
  `generated dir=${outDir} files=${fileCount + 1} bytes=${bytes}`
  + ` (small=${fileCount}x${propCount}props mega=1x${megaProps}props)`
);
