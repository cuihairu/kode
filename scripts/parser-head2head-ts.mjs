#!/usr/bin/env node
// parser 级 TS↔Rust head-to-head 基准 TS 侧(docs/perf/2026-parser-head2head.md)。
//
// 与 crates/kode-parser/examples/head2head.rs 同语料同口径:全量/单文件/增量三口径 + VmHWM。
// 运行(经 esbuild 打包后以纯 node 进程跑,不含 vitest/vscode 桩开销):
//   pnpm exec esbuild scripts/parser-head2head-ts.mjs --bundle --platform=node \
//     --format=cjs --outfile=/tmp/kode-h2h-ts.cjs
//   /usr/bin/time -v node --expose-gc /tmp/kode-h2h-ts.cjs <corpus_dir> [<corpus_dir>...]
// 语料收集规则与 kode-parser json::collect_corpus 一致(*.def + entities/types/alias.xml)。
//
// 口径说明:
//  - .def 文件测两遍:parse(仅 src/defParser.parseDefDocument)与
//    parse+extract(parseDefDocument + 主要提取面:properties/methods/parent/行号,
//    对称 Rust 侧 parse_def 自带的同级语义提取;对拍语义以
//    tests/kodeParserParity.test.ts extractDef 为准)。
//  - entities/types 用产品入口 compositionRoots.parseEntityNames / parseTypesXml;
//    alias 无专用 TS 入口,用 parseDefDocument(Rust 侧 parse_alias,差面已在报告声明)。
//  - 增量口径为 harness 等价模拟:与 kode-vfs content_fingerprint 完全同式的 FNV-1a
//    指纹 + Map 复用(TS 产品侧暂无解析器级增量注册表)。

import { parseDefDocument } from '../src/defParser';
import { parseEntityNames, parseTypesXml } from '../src/compositionRoots';
import fs from 'node:fs';
import path from 'node:path';

const KIND_DEF = 'def';
const KIND_ENTITIES = 'entities';
const KIND_TYPES = 'types';
const KIND_ALIAS = 'alias';

const kindOf = (name) => {
  if (name.endsWith('.def')) return KIND_DEF;
  if (name === 'entities.xml') return KIND_ENTITIES;
  if (name === 'types.xml') return KIND_TYPES;
  if (name === 'alias.xml') return KIND_ALIAS;
  return null;
};

// 与 kode_parser::json::collect_corpus 同规则:排序遍历、种类按文件名、读为 UTF-8 文本。
function collect(dir, relPrefix, out) {
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  entries.sort((a, b) => (a.name < b.name ? -1 : 1));
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    const rel = `${relPrefix}/${entry.name}`;
    if (entry.isDirectory()) {
      collect(full, rel, out);
      continue;
    }
    const kind = kindOf(entry.name);
    if (!kind) continue;
    out.set(rel, { kind, text: fs.readFileSync(full, 'utf8') });
  }
}

// —— golden 对拍提取面(.def,与 tests/kodeParserParity.test.ts extractDef 同语义,计时用途) ——
const canonicalTag = (name) => name.toLowerCase().replace(/[\s_-]/g, '');

const firstTextToken = (node) => {
  const token = getElementTextSafe(node).trim().split(/\s+/)[0];
  return token ? token : undefined;
};

function getElementTextSafe(node) {
  let out = '';
  for (const child of node.children) {
    if (child.kind === 'text') out += child.text;
  }
  return out;
}

const scalarChildByCanon = (node, canon) => {
  for (const child of node.children) {
    if (child.kind === 'element' && canonicalTag(child.name) === canon) {
      const value = getElementTextSafe(child).trim();
      if (value) return value;
    }
  }
  return undefined;
};

const hasTruthyChildByCanon = (node, canon) => {
  for (const child of node.children) {
    if (child.kind !== 'element' || canonicalTag(child.name) !== canon) continue;
    if (child.selfClosing) return true;
    const value = getElementTextSafe(child).trim().toLowerCase();
    if (value === '' || value === 'true' || value === '1' || value === 'yes') return true;
  }
  return false;
};

const elements = (node) => node.children.filter(c => c.kind === 'element');

function extractDefSurface(document) {
  const root = document.root;
  if (!root) return null;
  let props = 0;
  let methods = 0;
  const propertiesNode = elements(root).find(n => canonicalTag(n.name) === 'properties');
  if (propertiesNode) {
    for (const prop of elements(propertiesNode)) {
      for (const child of elements(prop)) {
        if (canonicalTag(child.name) === 'type') { void firstTextToken(child); }
        if (canonicalTag(child.name) === 'flags' || canonicalTag(child.name) === 'clientflags') {
          void getElementTextSafe(child).trim();
        }
        if (canonicalTag(child.name) === 'persistent' || canonicalTag(child.name) === 'sensitive') {
          void hasTruthyChildByCanon(prop, canonicalTag(child.name));
        }
      }
      void getLineNumberAtSafe(document, prop.tagStart);
      props += 1;
    }
  }
  for (const canon of ['basemethods', 'cellmethods', 'clientmethods']) {
    const section = elements(root).find(n => canonicalTag(n.name) === canon);
    if (!section) continue;
    for (const method of elements(section)) {
      for (const arg of elements(method)) {
        if (canonicalTag(arg.name) === 'arg') void getElementTextSafe(arg).trim();
      }
      void hasTruthyChildByCanon(method, 'exposed');
      void getLineNumberAtSafe(document, method.tagStart);
      methods += 1;
    }
  }
  void scalarChildByCanon(root, 'parent');
  return { props, methods };
}

function getLineNumberAtSafe(document, offset) {
  // 与 defParser.getLineNumberAt 同式:lineStarts 二分。
  const starts = document.lineStarts;
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid] <= offset) lo = mid; else hi = mid - 1;
  }
  return lo + 1;
}

// —— 与 kode-vfs content_fingerprint 完全同式的 FNV-1a(64 位,尾部长度旋入) ——
const FNV_OFFSET = 0xcbf29ce484222325n;
const FNV_PRIME = 0x100000001b3n;
const MASK64 = 0xffffffffffffffffn;

function contentFingerprint(text) {
  let hash = FNV_OFFSET;
  const bytes = Buffer.from(text, 'utf8');
  for (const byte of bytes) {
    hash ^= BigInt(byte);
    hash = (hash * FNV_PRIME) & MASK64;
  }
  const len = BigInt(bytes.length);
  const rotated = ((len << 32n) & MASK64) | (len >> 32n);
  return hash ^ rotated;
}

function parseOnce(kind, text) {
  switch (kind) {
    case KIND_DEF: return parseDefDocument(text);
    case KIND_ENTITIES: return parseEntityNames(text);
    case KIND_TYPES: return parseTypesXml(text);
    case KIND_ALIAS: return parseDefDocument(text);
    default: throw new Error(`unknown kind: ${kind}`);
  }
}

function parseDefWithExtract(text) {
  const document = parseDefDocument(text);
  return extractDefSurface(document);
}

function median(sorted) {
  return sorted[Math.floor(sorted.length / 2)];
}

function percentile(samples, p) {
  if (samples.length === 0) return 0;
  const sorted = [...samples].sort((a, b) => a - b);
  const idx = Math.min(Math.max(Math.ceil(sorted.length * p) - 1, 0), sorted.length - 1);
  return sorted[idx];
}

function medianOf(list) {
  if (list.length === 0) return 0;
  return [...list].sort((a, b) => a - b)[Math.floor(list.length / 2)];
}

function vmHwmKib() {
  try {
    const status = fs.readFileSync('/proc/self/status', 'utf8');
    const m = status.split('\n').find(l => l.startsWith('VmHWM:'));
    return m ? Number(m.split(/\s+/)[1]) : 0;
  } catch {
    return 0;
  }
}

// —— main ——
const corpora = process.argv.slice(2);
if (corpora.length === 0) {
  console.error('usage: node kode-h2h-ts.cjs <corpus_dir> [...]');
  process.exit(2);
}
const files = new Map();
for (const dir of corpora) {
  const label = path.basename(path.resolve(dir));
  collect(dir, label, files);
}
let totalBytes = 0;
for (const { text } of files.values()) totalBytes += Buffer.byteLength(text, 'utf8');
console.log(`H2H files=${files.size} bytes=${totalBytes} corpora=${corpora.join(',')}`);
if (files.size === 0) {
  console.error('H2H: empty corpus (no *.def / entities.xml / types.xml / alias.xml)');
  process.exit(2);
}

// ① 全量口径:两种 .def 面逐轮交替(抵消 JIT/顺序效应),20 轮,前 2 轮预热,吞吐取中位轮。
const FULL_MODES = ['parse-only', 'parse+extract'];
const fullRounds = new Map(FULL_MODES.map(m => [m, []]));
for (let round = 0; round < 20; round += 1) {
  for (const mode of FULL_MODES) {
    const withExtract = mode === 'parse+extract';
    if (global.gc) global.gc();
    const t0 = process.hrtime.bigint();
    for (const { kind, text } of files.values()) {
      if (withExtract && kind === KIND_DEF) parseDefWithExtract(text);
      else parseOnce(kind, text);
    }
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    if (round >= 2) fullRounds.get(mode).push(ms);
  }
}
for (const mode of FULL_MODES) {
  const rounds = fullRounds.get(mode);
  const sorted = [...rounds].sort((a, b) => a - b);
  const med = median(sorted);
  console.log(
    `FULL mode=${mode} rounds=${rounds.length} median_ms=${med.toFixed(3)}`
    + ` min_ms=${sorted[0].toFixed(3)} max_ms=${sorted[sorted.length - 1].toFixed(3)}`
    + ` throughput_MBps=${(totalBytes / 1024 / 1024 * 1000 / med).toFixed(2)}`
  );
}

// ② 单文件口径:30 轮(前 3 轮预热),逐文件样本;两模式同样逐轮交替。
for (const mode of FULL_MODES) {
  const withExtract = mode === 'parse+extract';
  const all = [];
  const perFileMin = new Map();
  for (let round = 0; round < 30; round += 1) {
    if (global.gc) global.gc();
    for (const [rel, { kind, text }] of files) {
      const t0 = process.hrtime.bigint();
      if (withExtract && kind === KIND_DEF) parseDefWithExtract(text);
      else parseOnce(kind, text);
      const us = Number(process.hrtime.bigint() - t0) / 1e3;
      if (round >= 3) {
        all.push(us);
        const prev = perFileMin.get(rel);
        perFileMin.set(rel, prev === undefined || us < prev ? us : prev);
      }
    }
  }
  console.log(
    `SINGLE mode=${mode} n=${all.length} P50_us=${percentile(all, 0.5).toFixed(1)}`
    + ` P95_us=${percentile(all, 0.95).toFixed(1)} P99_us=${percentile(all, 0.99).toFixed(1)}`
    + ` max_us=${Math.max(...all).toFixed(1)}`
  );
  const worst = [...perFileMin.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3);
  for (const [rel, us] of worst) console.log(`SLOWEST mode=${mode} min_us=${us.toFixed(1)} file=${rel}`);
  if (withExtract) {
    // 语义面校验:必须与 Rust 侧 SURFACE 同值。
    let props = 0;
    let methods = 0;
    for (const { kind, text } of files.values()) {
      if (kind !== KIND_DEF) continue;
      const surface = extractDefSurface(parseDefDocument(text));
      if (surface) { props += surface.props; methods += surface.methods; }
    }
    console.log(`SURFACE mode=${mode} props=${props} methods=${methods}`);
  }
}

// ③ 增量口径:指纹 + Map 复用两扫 × 5 次重复,首扫全 rebuild,二扫零 rebuild(harness 等价模拟);
//    fp_only 只跑内容指纹(不解析),把指纹成本与解析成本拆开。
{
  const scan1s = [];
  const scan2s = [];
  const fponly = [];
  for (let repeat = 0; repeat < 5; repeat += 1) {
    const t0 = process.hrtime.bigint();
    let checksum = 0n;
    for (const { text } of files.values()) checksum ^= contentFingerprint(text);
    fponly.push(Number(process.hrtime.bigint() - t0) / 1e6);
    if (checksum === 1n) console.error('unreachable fingerprint guard');

    const cache = new Map();
    let scan1Rebuilds = 0;
    let scan2CacheHits = 0;
    const t1 = process.hrtime.bigint();
    for (const [rel, { kind, text }] of files) {
      const fp = contentFingerprint(text);
      cache.set(rel, { fp, kind, unit: parseOnce(kind, text) });
      scan1Rebuilds += 1;
    }
    scan1s.push(Number(process.hrtime.bigint() - t1) / 1e6);
    const t2 = process.hrtime.bigint();
    for (const [rel, { kind, text }] of files) {
      const fp = contentFingerprint(text);
      const hit = cache.get(rel);
      if (hit !== undefined && hit.fp === fp) {
        scan2CacheHits += 1;
        continue;
      }
      cache.set(rel, { fp, kind, unit: parseOnce(kind, text) });
    }
    scan2s.push(Number(process.hrtime.bigint() - t2) / 1e6);
    if (scan1Rebuilds !== files.size || scan2CacheHits !== files.size) {
      console.error(`INCR invariant broken: rebuilds=${scan1Rebuilds} hits=${scan2CacheHits}`);
      process.exit(1);
    }
  }
  console.log(
    `INCR repeats=5 scan1_rebuilds=${files.size} scan2_rebuilds=0 scan2_cache_hits=${files.size}`
    + ` scan1_ms=${medianOf(scan1s).toFixed(3)} scan2_ms=${medianOf(scan2s).toFixed(3)}`
    + ` fp_only_ms=${medianOf(fponly).toFixed(3)}`
  );
}

console.log(`MEM vmhwm_kib=${vmHwmKib()}`);
console.log('bench ok');
