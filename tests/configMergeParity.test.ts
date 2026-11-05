// KODE-CFG-003 对拍门禁:用 TS 现有 parseConfigXml+mergeConfigXml 复算 Rust 侧
// 生成的 golden(crates/kode-parser/tests/golden/config-merge-parity.json),
// 逐对逐字段比对。与 configParity.test.ts 同构:Rust 是 golden 生成器,TS 用
// 既有实现复算,形成双向对拍。语料对覆盖覆盖规则/注释合并/名字序/深层递归。
import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { mergeConfigXml, parseConfigXml, type ConfigXmlNode } from '../src/serverConfigMerge';

const REPO_ROOT = path.resolve(__dirname, '..');
const GOLDEN_PATH = path.join(
  REPO_ROOT,
  'crates/kode-parser/tests/golden/config-merge-parity.json'
);

interface GoldenPair {
  base: string;
  override: string;
  record: Record<string, unknown> | null;
}

const loadGolden = (): GoldenPair[] => {
  const raw = JSON.parse(fs.readFileSync(GOLDEN_PATH, 'utf8')) as { pairs: GoldenPair[] };
  return raw.pairs;
};

/** 序列化 TS 树为 golden 记录形状(与 configParity 同构) */
const serialize = (node: ConfigXmlNode): Record<string, unknown> => ({
  name: node.name,
  text: node.text,
  children: (node.children ?? []).map(serialize),
  sourceComments: node.sourceComments ?? []
});

describe('config merge 对拍:TS parseConfigXml+mergeConfigXml 复算 Rust golden', () => {
  it('pairCount 与 golden 一致且含真实 defaults×custom', () => {
    const golden = loadGolden();
    expect(golden.length).toBeGreaterThanOrEqual(12);
    expect(golden.some(pair => pair.base.endsWith('kbengine_defaults.xml'))).toBe(true);
  });

  it('逐对逐字段与 golden 一致(覆盖规则/注释/名字序/递归)', () => {
    const golden = loadGolden();
    for (const { base, override, record } of golden) {
      const baseText = fs.readFileSync(path.join(REPO_ROOT, base), 'utf8');
      const overrideText = fs.readFileSync(path.join(REPO_ROOT, override), 'utf8');
      const baseTree = parseConfigXml(baseText);
      const overrideTree = parseConfigXml(overrideText);
      const merged = baseTree !== null && overrideTree !== null
        ? mergeConfigXml(baseTree, overrideTree)
        : null;
      const actualRecord = merged === null ? null : serialize(merged);
      expect(actualRecord, `对 ${override} 的合并结果与 golden 不一致`).toEqual(record);
    }
  });

  it('golden 结构完整性(generator 标识与 pairCount)', () => {
    const raw = JSON.parse(fs.readFileSync(GOLDEN_PATH, 'utf8')) as {
      generator: string;
      pairCount: number;
    };
    expect(raw.generator).toBe('kode-parser dump-config-merge-golden');
    expect(raw.pairCount).toBeGreaterThanOrEqual(12);
  });
});
