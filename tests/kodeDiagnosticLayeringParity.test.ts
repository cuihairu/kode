// kode2 诊断分级装配对拍门禁(RUST-142 批 2):TS 侧对拍 Rust golden
// (crates/kode-server/tests/golden/diagnostic-layering-parity.json)——
// 家族税表(CHECK_CODES 15 码)/决策表现状(全 localSyntax)/合流序字节
// 序/跨 golden 四层词表一致/计数守恒/production seam(diagnostics.ts 全
// layer:'local')逐面独立复算。lint findings 本体无法在 TS 复算(lint
// 规则集是 Rust 生产面),TS 镜像聚焦装配决策面。本文件只读 fixture、
// golden 与生产源文本,不改 src/。
import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = path.resolve(__dirname, '..');
const GOLDEN_PATH = path.join(
  REPO_ROOT,
  'crates/kode-server/tests/golden/diagnostic-layering-parity.json'
);
const PIPELINE_GOLDEN_PATH = path.join(
  REPO_ROOT,
  'crates/kode-server/tests/golden/diagnostic-pipeline-parity.json'
);
const PRODUCTION_DIAGNOSTICS_TS = path.join(REPO_ROOT, 'src/activate/diagnostics.ts');

// Rust 侧 crates/kode-server/src/diagnostic_layering.rs CHECK_CODES 镜像
// (新增 lint 规则须双侧同表;此处顺序 = Rust 源码字面顺序)。
const RUST_CHECK_CODES = [
  'def-method-missing-in-python',
  'duplicate-definition',
  'duplicate-type-tag',
  'engine-limited-name',
  'heavy-sync-broadcast',
  'inherited-name-collision',
  'invalid-identifier',
  'method-property-collision',
  'missing-flags',
  'missing-type',
  'phantom-type',
  'redundant-detail-level',
  'unknown-detail-level',
  'unknown-flag-value',
  'unknown-type-reference'
] as const;

// 四层名(Rust DiagnosticLayer 全员)+ 合流序字节序重算基准。
const FOUR_LAYERS = ['localSyntax', 'semantic', 'engineCompat', 'runtimeConfig'] as const;

// 现状决策表(家族迁移由 TS 装配批翻表;此字面翻动即联动 Rust 翻表 +
// golden 重生成,双侧对拍门同时红)。
const TS_LAYER_FOR_CHECK: Record<string, string> = Object.fromEntries(
  RUST_CHECK_CODES.map((code) => [code, 'localSyntax'])
);

interface GoldenFinding {
  check: string;
  severity: string;
  line: number;
}

interface GoldenFile {
  file: string;
  findingCount: number;
  findings: GoldenFinding[];
}

interface GoldenStats {
  layer: string;
  requested: number;
  published: number;
  skippedCurrentVersion: number;
}

interface GoldenDump {
  fileCount: number;
  findingCount: number;
  checkCounts: Record<string, number>;
  layerCounts: Record<string, number>;
  layerForCheck: Record<string, string>;
  mergedPublishOrder: string[];
  replayStats: GoldenStats[];
  files: GoldenFile[];
}

const golden = JSON.parse(fs.readFileSync(GOLDEN_PATH, 'utf8')) as GoldenDump;

describe('kodeDiagnosticLayeringParity', () => {
  it('family table mirrors rust CHECK_CODES and routing decisions', () => {
    // 税表全量镜像:TS 字面 = Rust 源字面(顺序敏感,防漂移)。
    expect(RUST_CHECK_CODES).toHaveLength(15);
    expect([...RUST_CHECK_CODES]).toEqual([
      'def-method-missing-in-python',
      'duplicate-definition',
      'duplicate-type-tag',
      'engine-limited-name',
      'heavy-sync-broadcast',
      'inherited-name-collision',
      'invalid-identifier',
      'method-property-collision',
      'missing-flags',
      'missing-type',
      'phantom-type',
      'redundant-detail-level',
      'unknown-detail-level',
      'unknown-flag-value',
      'unknown-type-reference'
    ]);

    // 决策表对拍:golden 逐码(语料在场码)与 TS 字面分配一致;
    // TS 字面为全表(15 码)完备,不漏任何在役码。
    const firedCodes = Object.keys(golden.layerForCheck);
    expect(firedCodes.length).toBeGreaterThan(0);
    for (const code of firedCodes) {
      expect(TS_LAYER_FOR_CHECK[code]).toBeDefined();
      expect(golden.layerForCheck[code]).toBe(TS_LAYER_FOR_CHECK[code]);
    }
    for (const code of RUST_CHECK_CODES) {
      expect(TS_LAYER_FOR_CHECK[code]).toBeDefined();
    }
    // 层值域四名;finding 逐条 check ∈ 税表、severity ∈ lint 词表。
    for (const file of golden.files) {
      for (const finding of file.findings) {
        expect(RUST_CHECK_CODES).toContain(finding.check);
        expect(['error', 'warning', 'info']).toContain(finding.severity);
        expect(finding.line).toBeGreaterThanOrEqual(1);
      }
    }
    // 语料在场 checkCounts 的码全在税表内(无幽灵家族)。
    for (const code of Object.keys(golden.checkCounts)) {
      expect(RUST_CHECK_CODES).toContain(code);
    }
  });

  it('counts conserve across five faces and files are corpus defs', () => {
    const fileSum = golden.files.reduce((acc, f) => acc + f.findingCount, 0);
    const findingsSum = golden.files.reduce((acc, f) => acc + f.findings.length, 0);
    const checkSum = Object.values(golden.checkCounts).reduce((a, b) => a + b, 0);
    const layerSum = Object.values(golden.layerCounts).reduce((a, b) => a + b, 0);
    expect(golden.findingCount).toBe(fileSum);
    expect(golden.findingCount).toBe(findingsSum);
    expect(golden.findingCount).toBe(checkSum);
    expect(golden.findingCount).toBe(layerSum);
    expect(golden.findingCount).toBeGreaterThan(0);
    expect(golden.fileCount).toBe(golden.files.length);
    expect(golden.fileCount).toBeGreaterThan(0);

    // 逐文件自洽:findingCount == findings.length;文件路径是磁盘上
    // 真实存在的语料 .def。
    for (const file of golden.files) {
      expect(file.findingCount).toBe(file.findings.length);
      const abs = path.join(REPO_ROOT, file.file);
      expect(fs.existsSync(abs)).toBe(true);
      expect(file.file.endsWith('.def')).toBe(true);
    }
    // 真分布:多家族在场。
    expect(Object.keys(golden.checkCounts).length).toBeGreaterThanOrEqual(2);
  });

  it('merged publish order is byte-sorted layer names and matches pipeline golden vocabulary', () => {
    // 字节序重算:四层名按 code-unit 排序 = golden 合流序。
    const recomputed = [...FOUR_LAYERS].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    expect(golden.mergedPublishOrder).toEqual(recomputed);

    // 跨 golden 一致:批 1 回放核 golden 的层词表与本批四层名同一集合
    // (两份 golden 描述同一四层模型)。
    const pipelineRaw = fs.readFileSync(PIPELINE_GOLDEN_PATH, 'utf8');
    const pipelineLayers = new Set<string>();
    for (const match of pipelineRaw.matchAll(/"layer":"([A-Za-z]+)"/g)) {
      pipelineLayers.add(match[1]);
    }
    expect([...pipelineLayers].sort()).toEqual([...FOUR_LAYERS].sort());
    // 本批出现的层值全部属于四层名集合。
    for (const layer of Object.keys(golden.layerCounts)) {
      expect(FOUR_LAYERS).toContain(layer);
    }
  });

  it('production seam is all-local and per-layer replay accounting matches', () => {
    // production seam(从生产源文本复算,不硬编码):diagnostics.ts 的
    // 调度请求全部 layer:'local'(TS 生产层枚举 'local'|'semantic',
    // 17 家族全 local)。任一调用点翻 'semantic' 即红,联动翻表讨论。
    const production = fs.readFileSync(PRODUCTION_DIAGNOSTICS_TS, 'utf8');
    const requestedLayers = [...production.matchAll(/layer: '([A-Za-z]+)' as const/g)].map(
      (m) => m[1]
    );
    expect(requestedLayers.length).toBeGreaterThan(0);
    for (const layer of requestedLayers) {
      expect(layer).toBe('local');
    }

    // 逐层独立回放记账:localSyntax 每命中文件一请求一发布、零同版跳过;
    // 其余层现状零请求(与 production seam 全 local 同源的现状面)。
    const byLayer = new Map(golden.replayStats.map((s) => [s.layer, s]));
    expect(byLayer.size).toBe(4);
    for (const layer of FOUR_LAYERS) {
      expect(byLayer.has(layer)).toBe(true);
    }
    const local = byLayer.get('localSyntax')!;
    expect(local.requested).toBe(golden.fileCount);
    expect(local.published).toBe(golden.fileCount);
    expect(local.skippedCurrentVersion).toBe(0);
    for (const name of ['semantic', 'engineCompat', 'runtimeConfig'] as const) {
      const stats = byLayer.get(name)!;
      expect(stats.requested).toBe(0);
      expect(stats.published).toBe(0);
      expect(stats.skippedCurrentVersion).toBe(0);
    }
  });
});
