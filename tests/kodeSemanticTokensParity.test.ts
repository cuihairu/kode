// SemanticTokens 决策核对拍门禁(RUST-144 批 3):读 Rust 侧生成的
// golden(crates/kode-server/tests/golden/semantic-tokens-parity.json)的
// corpus+probes 驱动**生产** buildSemanticTokenSpans/encodeSemanticTokens
// 逐语料复算对拍 outcomes——两面:span 提取 / LSP 相对编码。语义真值源
// 是生产函数,镜像红 = Rust 移植错,按 src/ 源码重推(本文件只读
// golden,不改 src/)。
import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import {
  buildSemanticTokenSpans,
  encodeSemanticTokens
} from '../src/backend/semanticTokens';

const REPO_ROOT = path.resolve(__dirname, '..');
const GOLDEN_PATH = path.join(REPO_ROOT, 'crates/kode-server/tests/golden/semantic-tokens-parity.json');

/** golden 探测面(Rust Probe serde 形态;tag = "face") */
type GoldenProbe = { face: 'spans'; corpus: string } | { face: 'encoded'; corpus: string };

/** golden 产出面(与 Probe 一一对应) */
type GoldenOutcome =
  | { face: 'spans'; spans: unknown[] }
  | { face: 'encoded'; data: number[] };

interface Golden {
  generator: string;
  corpus: Array<{ name: string; text: string }>;
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
  const spans = buildSemanticTokenSpans(entry.text);
  if (probe.face === 'spans') {
    return spans;
  }
  return encodeSemanticTokens(spans);
}

describe('kode semantic tokens parity (RUST-144 golden replay)', () => {
  it('golden 自含:corpus 覆盖边界形态族,probes 与 outcomes 一一对应', () => {
    expect(golden.generator).toBe('dump-semantic-tokens-golden');
    expect(golden.corpus.length).toBeGreaterThanOrEqual(8);
    expect(golden.probes.length).toBe(golden.outcomes.length);
    expect(golden.probes.length).toBeGreaterThanOrEqual(16);
    for (const entry of golden.corpus) {
      expect(typeof entry.name).toBe('string');
      expect(typeof entry.text).toBe('string');
    }
  });

  it('逐语料复算对拍 outcomes(spans/encoded 两面全覆盖)', () => {
    const mismatches: string[] = [];
    const covered = new Set<string>();
    for (let index = 0; index < golden.probes.length; index += 1) {
      const probe = golden.probes[index];
      const outcome = golden.outcomes[index];
      covered.add(probe.face);
      const actual = replay(probe);
      const expected = outcome.face === 'spans' ? outcome.spans : outcome.data;
      if (JSON.stringify(actual) !== JSON.stringify(expected)) {
        mismatches.push(
          `#${index} ${probe.face} corpus=${probe.corpus}\n  ts=${JSON.stringify(actual)}\n  rust=${JSON.stringify(expected)}`
        );
      }
    }
    expect([...covered], '两面未全覆盖').toEqual(expect.arrayContaining(['spans', 'encoded']));
    expect(mismatches, `对拍红 ${mismatches.length} 条:\n${mismatches.slice(0, 20).join('\n')}`).toEqual([]);
  });

  it('非空产出分布:两面都有命中(防全空对拍空转)', () => {
    const counts: Record<string, number> = {};
    for (const outcome of golden.outcomes) {
      const hit =
        outcome.face === 'spans'
          ? outcome.spans.length > 0
          : outcome.data.length > 0;
      if (hit) {
        counts[outcome.face] = (counts[outcome.face] ?? 0) + 1;
      }
    }
    expect(counts.spans).toBeGreaterThan(0);
    expect(counts.encoded).toBeGreaterThan(0);
  });
});
