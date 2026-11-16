// defPropsInlayHints 决策核对拍门禁(RUST-144 批 2):读 Rust 侧生成的
// golden(crates/kode-server/tests/golden/def-props-parity.json)的
// corpus+probes 驱动**生产**函数逐探测复算,逐条对拍 outcomes——两面:
// 注释锚提取(findDefPropsAnchorSites)/单锚点组装
// (buildDefPropsInlayItems,workspaceRoot='' 走生产内建直查链,与 Rust
// 空根链同链零注入)。语义真值源是生产函数,镜像红 = Rust 移植错,按
// src/ 源码重推(本文件只读 golden,不改 src/)。
import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import {
  buildDefPropsInlayItems,
  findDefPropsAnchorSites,
  type DefPropsAnchorSite
} from '../src/defPropsInlayHints';
import type { PropertyDefinitionInfo } from '../src/entityMapping';

const REPO_ROOT = path.resolve(__dirname, '..');
const GOLDEN_PATH = path.join(REPO_ROOT, 'crates/kode-server/tests/golden/def-props-parity.json');

/** golden 探测面(Rust Probe serde 形态;tag = "face") */
type GoldenProbe =
  | { face: 'anchors'; corpus: string }
  | { face: 'items'; corpus: string; anchor_index: number };

/** golden 产出面(与 Probe 一一对应) */
type GoldenOutcome =
  | { face: 'anchors'; sites: Array<{ line: number; character: number }> }
  | { face: 'items'; item: unknown };

interface GoldenPropertyFace {
  defFile: string;
  line: number;
  typeName?: string;
  domains: string[];
  persistent: boolean;
  propertyPath?: string;
  symbolName: string;
  componentSlotName?: string;
}

interface Golden {
  generator: string;
  corpus: Array<{ name: string; text: string; properties: GoldenPropertyFace[] }>;
  probes: GoldenProbe[];
  outcomes: GoldenOutcome[];
}

const golden: Golden = JSON.parse(fs.readFileSync(GOLDEN_PATH, 'utf8'));

/** 语料表(name → entry) */
const corpus = new Map(golden.corpus.map(entry => [entry.name, entry]));

/** golden 属性面 → 生产 PropertyDefinitionInfo 形状(缺键=undefined 同形) */
function toProductionProperty(face: GoldenPropertyFace): PropertyDefinitionInfo {
  return {
    defFile: face.defFile,
    line: face.line,
    typeName: face.typeName,
    identity: {
      propertyPath: face.propertyPath,
      symbolName: face.symbolName,
      componentSlotName: face.componentSlotName
    },
    domains: face.domains as PropertyDefinitionInfo['domains'],
    persistent: face.persistent
  } as PropertyDefinitionInfo;
}

/** 单探测复算(生产函数);返回与 outcome 同形的值 */
function replay(probe: GoldenProbe): unknown {
  const entry = corpus.get(probe.corpus);
  if (!entry) {
    throw new Error(`corpus 缺失: ${probe.corpus}`);
  }
  if (probe.face === 'anchors') {
    return findDefPropsAnchorSites(entry.text);
  }
  const sites: DefPropsAnchorSite[] = findDefPropsAnchorSites(entry.text);
  const site = sites[probe.anchor_index];
  if (!site) {
    return null;
  }
  return buildDefPropsInlayItems(
    site,
    entry.properties.map(toProductionProperty),
    ''
  );
}

describe('kode def props parity (RUST-144 golden replay)', () => {
  it('golden 自含:corpus 覆盖边界形态族,probes 与 outcomes 一一对应', () => {
    expect(golden.generator).toBe('dump-def-props-golden');
    expect(golden.corpus.length).toBeGreaterThanOrEqual(8);
    expect(golden.probes.length).toBe(golden.outcomes.length);
    expect(golden.probes.length).toBeGreaterThanOrEqual(14);
    for (const entry of golden.corpus) {
      expect(typeof entry.name).toBe('string');
      expect(typeof entry.text).toBe('string');
      expect(Array.isArray(entry.properties)).toBe(true);
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
      const expected = outcome.face === 'anchors' ? outcome.sites : outcome.item;
      if (JSON.stringify(actual) !== JSON.stringify(expected)) {
        mismatches.push(
          `#${index} ${probe.face} probe=${JSON.stringify(probe)}\n  ts=${JSON.stringify(actual)}\n  rust=${JSON.stringify(expected)}`
        );
      }
    }
    expect([...covered], '两面未全覆盖').toEqual(expect.arrayContaining(['anchors', 'items']));
    expect(mismatches, `对拍红 ${mismatches.length} 条:\n${mismatches.slice(0, 20).join('\n')}`).toEqual([]);
  });

  it('非空产出分布:两面都有命中(防全空对拍空转)', () => {
    const counts: Record<string, number> = {};
    for (let index = 0; index < golden.probes.length; index += 1) {
      const probe = golden.probes[index];
      const outcome = golden.outcomes[index];
      const hit =
        outcome.face === 'anchors'
          ? outcome.sites.length > 0
          : outcome.item !== null;
      if (hit) {
        counts[probe.face] = (counts[probe.face] ?? 0) + 1;
      }
    }
    expect(counts.anchors).toBeGreaterThan(0);
    expect(counts.items).toBeGreaterThan(0);
  });
});
