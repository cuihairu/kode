// defParamInlayHints 决策核对拍门禁(RUST-144 批 1):读 Rust 侧生成的
// golden(crates/kode-server/tests/golden/def-param-hints-parity.json)的
// corpus+probes 驱动**生产**函数逐探测复算,逐条对拍 outcomes——两面:
// 定义点站点提取(findDefParamSites)/inlay 配对
// (buildDefParamInlayItems,workspaceRoot='' 走生产内建直查链,与 Rust
// resolve_annotation_direct 同链零注入)。语义真值源是生产函数,镜像红 =
// Rust 移植错,按 src/ 源码重推(本文件只读 golden,不改 src/)。
import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { buildDefParamInlayItems, findDefParamSites } from '../src/defParamInlayHints';

const REPO_ROOT = path.resolve(__dirname, '..');
const GOLDEN_PATH = path.join(REPO_ROOT, 'crates/kode-server/tests/golden/def-param-hints-parity.json');

/** golden 探测面(Rust Probe serde 形态;tag = "face",变体字段 snake_case) */
type GoldenProbe =
  | { face: 'sites'; corpus: string }
  | { face: 'items'; corpus: string; site_index: number; declared_args: string[] | null; declared_return_type: string | null };

/** golden 产出面(与 Probe 一一对应;tag 同形,字段 camelCase) */
type GoldenOutcome =
  | { face: 'sites'; sites: unknown[] }
  | { face: 'items'; items: unknown[] };

interface Golden {
  generator: string;
  corpus: Array<{ name: string; path: string; text: string }>;
  probes: GoldenProbe[];
  outcomes: GoldenOutcome[];
}

const golden: Golden = JSON.parse(fs.readFileSync(GOLDEN_PATH, 'utf8'));

/** 语料表(name → entry) */
const corpus = new Map(golden.corpus.map(entry => [entry.name, entry]));

/** 单探测复算(生产函数);返回与 outcome 同形的值 */
function replay(probe: GoldenProbe): unknown {
  const entry = corpus.get(probe.corpus);
  if (!entry) {
    throw new Error(`corpus 缺失: ${probe.corpus}`);
  }
  if (probe.face === 'sites') {
    return findDefParamSites(entry.text, entry.path);
  }
  const sites = findDefParamSites(entry.text, entry.path);
  const site = sites[probe.site_index];
  if (!site) {
    return [];
  }
  return buildDefParamInlayItems(
    site,
    {
      declaredArgs: probe.declared_args ?? undefined,
      declaredReturnType: probe.declared_return_type ?? undefined
    },
    ''
  );
}

describe('kode def param hints parity (RUST-144 golden replay)', () => {
  it('golden 自含:corpus 覆盖边界形态族,probes 与 outcomes 一一对应', () => {
    expect(golden.generator).toBe('dump-def-param-hints-golden');
    expect(golden.corpus.length).toBeGreaterThanOrEqual(10);
    expect(golden.probes.length).toBe(golden.outcomes.length);
    expect(golden.probes.length).toBeGreaterThanOrEqual(30);
    for (const entry of golden.corpus) {
      expect(typeof entry.name).toBe('string');
      expect(typeof entry.path).toBe('string');
      expect(typeof entry.text).toBe('string');
    }
  });

  it('逐探测复算对拍 outcomes(两面全覆盖)', () => {
    const mismatches: string[] = [];
    const covered = new Set<string>();
    for (let index = 0; index < golden.probes.length; index += 1) {
      const probe = golden.probes[index];
      const outcome = golden.outcomes[index];
      covered.add(probe.face);
      const actual = replay(probe);
      const expected = outcome.face === 'sites' ? outcome.sites : outcome.items;
      if (JSON.stringify(actual) !== JSON.stringify(expected)) {
        mismatches.push(
          `#${index} ${probe.face} probe=${JSON.stringify(probe)}\n  ts=${JSON.stringify(actual)}\n  rust=${JSON.stringify(expected)}`
        );
      }
    }
    expect([...covered], '两面未全覆盖').toEqual(expect.arrayContaining(['sites', 'items']));
    expect(mismatches, `对拍红 ${mismatches.length} 条:\n${mismatches.slice(0, 20).join('\n')}`).toEqual([]);
  });

  it('非空产出分布:两面都有命中(防全空对拍空转)', () => {
    const counts: Record<string, number> = {};
    for (let index = 0; index < golden.probes.length; index += 1) {
      const probe = golden.probes[index];
      const outcome = golden.outcomes[index];
      const values = outcome.face === 'sites' ? outcome.sites : outcome.items;
      if (values.length > 0) {
        counts[probe.face] = (counts[probe.face] ?? 0) + 1;
      }
    }
    expect(counts.sites).toBeGreaterThan(0);
    expect(counts.items).toBeGreaterThan(0);
  });
});
