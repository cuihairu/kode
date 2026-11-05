// KODE-CFG-002 对拍门禁:用 TS 现有 parseConfigXml 实现复算 Rust 侧生成的
// golden(crates/kode-parser/tests/golden/config-parity.json),逐文件逐字段比对。
// 与 kodeParserParity.test.ts 同构:Rust 是 golden 生成器,TS 用既有实现复算,
// 形成双向对拍——任何一侧语义漂移都红。本文件只读 fixture 与 golden,
// 不改 src/(对拍语义 = 双实现同输入同输出)。
import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { parseConfigXml, type ConfigXmlNode } from '../src/serverConfigMerge';

const REPO_ROOT = path.resolve(__dirname, '..');
const GOLDEN_PATH = path.join(REPO_ROOT, 'crates/kode-parser/tests/golden/config-parity.json');
const CONFIG_CORPUS = path.join(REPO_ROOT, 'tests/fixtures/config');

interface GoldenFile {
  file: string;
  record: Record<string, unknown> | null;
}

const loadGolden = (): GoldenFile[] => {
  const raw = JSON.parse(fs.readFileSync(GOLDEN_PATH, 'utf8')) as { files: GoldenFile[] };
  return raw.files;
};

/** 递归收集 `.xml`,路径以 corpus 相对仓库根的形态输出(码元序排序,与 Rust BTreeMap 字节序一致) */
const collectXml = (dir: string, relPrefix: string): string[] => {
  const out: string[] = [];
  for (const entry of fs
    .readdirSync(dir, { withFileTypes: true })
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
    const rel = `${relPrefix}/${entry.name}`;
    if (entry.isDirectory()) {
      out.push(...collectXml(path.join(dir, entry.name), rel));
    } else if (entry.name.endsWith('.xml')) {
      out.push(rel);
    }
  }
  return out;
};

/** 序列化 TS 树为 golden 记录形状(sourceComments 缺失按空数组) */
const serialize = (node: ConfigXmlNode): Record<string, unknown> => ({
  name: node.name,
  text: node.text,
  children: (node.children ?? []).map(serialize),
  sourceComments: node.sourceComments ?? []
});

describe('config parse 对拍:TS parseConfigXml 复算 Rust golden', () => {
  it('语料文件清单与 golden 一致', () => {
    const golden = loadGolden();
    const actual = collectXml(CONFIG_CORPUS, 'tests/fixtures/config');
    expect(actual).toEqual(golden.map(f => f.file));
  });

  it('逐文件逐字段与 golden 一致(含注释归属/容错/None 路径)', () => {
    const golden = loadGolden();
    for (const { file, record } of golden) {
      const text = fs.readFileSync(path.join(REPO_ROOT, file), 'utf8');
      const parsed = parseConfigXml(text);
      const actualRecord = parsed === null ? null : serialize(parsed);
      expect(actualRecord, `文件 ${file} 的解析树与 golden 不一致`).toEqual(record);
    }
  });

  it('golden 结构完整性(generator 标识与 fileCount)', () => {
    const raw = JSON.parse(fs.readFileSync(GOLDEN_PATH, 'utf8')) as { generator: string; fileCount: number };
    expect(raw.generator).toBe('kode-parser dump-config-golden');
    expect(raw.fileCount).toBeGreaterThanOrEqual(11);
  });
});
