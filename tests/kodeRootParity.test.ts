// kode2 PR-006 对拍门禁(ROOT-010):用 TS 现有 workspaceDiscovery 实现
// (scanWorkspaceAnchors)复算 Rust 侧生成的 golden
// (crates/kode-root/tests/golden/root-parity.json),逐树逐字段比对。
// 本文件只读 fixture 与 golden,不改 src/(对拍语义 = 双实现同输入同输出)。
import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { scanWorkspaceAnchors } from '../src/workspaceDiscovery';

const REPO_ROOT = path.resolve(__dirname, '..');
const GOLDEN_PATH = path.join(REPO_ROOT, 'crates/kode-root/tests/golden/root-parity.json');
const FIXTURES_DIR = path.join(REPO_ROOT, 'crates/kode-root/tests/fixtures');

interface GoldenTree {
  name: string;
  entityDefs: string[];
  entitiesXml: string[];
  typesXml: string[];
  kbeSourceRoots: string[];
  messagesXml: string[];
  configRoots: string[];
  scanVisited: number;
  scanTruncated: boolean;
}

const loadGolden = (): GoldenTree[] => {
  const raw = JSON.parse(fs.readFileSync(GOLDEN_PATH, 'utf8')) as { trees: GoldenTree[] };
  return raw.trees;
};

// 与 Rust sorted_view 同口径:排序 + 去重 + 相对化 + `/` 分隔
const normalize = (treeAbs: string, hits: string[]): string[] => {
  const rel = hits.map(hit => path.relative(treeAbs, hit).split(path.sep).join('/'));
  return [...new Set(rel)].sort();
};

interface FieldCompare {
  field: string;
  expected: string[];
  actual: string[];
}

const compareTree = (tree: GoldenTree): FieldCompare[] => {
  const treeAbs = path.join(FIXTURES_DIR, tree.name);
  const scan = scanWorkspaceAnchors(treeAbs);
  const pairs: Array<[string, string[]]> = [
    ['entityDefs', scan.entityDefs],
    ['entitiesXml', scan.entitiesXml],
    ['typesXml', scan.typesXml],
    ['kbeSourceRoots', scan.kbeSourceRoots],
    ['messagesXml', scan.messagesXml],
    ['configRoots', scan.configRoots]
  ];
  const mismatches: FieldCompare[] = [];
  for (const [field, hits] of pairs) {
    const expected = tree[field as keyof GoldenTree] as string[];
    const actual = normalize(treeAbs, hits);
    if (JSON.stringify(expected) !== JSON.stringify(actual)) {
      mismatches.push({ field, expected, actual });
    }
  }
  if (tree.scanVisited !== scan.scanVisited) {
    mismatches.push({
      field: 'scanVisited',
      expected: [String(tree.scanVisited)],
      actual: [String(scan.scanVisited)]
    });
  }
  if (tree.scanTruncated !== scan.scanTruncated) {
    mismatches.push({
      field: 'scanTruncated',
      expected: [String(tree.scanTruncated)],
      actual: [String(scan.scanTruncated)]
    });
  }
  return mismatches;
};

describe('kodeRootParity (PR-006 ROOT-010: TS discovery ↔ kode-root scan)', () => {
  const trees = loadGolden();

  it('golden 覆盖全部六棵对拍树', () => {
    expect(trees.map(t => t.name).sort()).toEqual(
      [
        'linux_assets',
        'engine_repo',
        'multi_ambiguous',
        'submodule_vendor',
        'sensitive_dirs',
        'deep_nest'
      ].sort()
    );
  });

  for (const tree of trees) {
    it(`对拍 ${tree.name}: 锚点集/visited/截断逐字段一致`, () => {
      const mismatches = compareTree(tree);
      expect(mismatches, JSON.stringify(mismatches, null, 2)).toEqual([]);
    });
  }

  it('对拍一致率 = 100%(6 树 × 8 字段全对齐)', () => {
    const fieldsPerTree = 8;
    const total = trees.length * fieldsPerTree;
    let matched = 0;
    for (const tree of trees) {
      matched += fieldsPerTree - compareTree(tree).length;
    }
    expect(matched).toBe(total);
  });
});
