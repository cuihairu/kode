// python 方法调用层次决策核对拍门禁(RUST-145 批 1):读 Rust 侧生成的
// golden(crates/kode-server/tests/golden/python-method-calls-parity.json)
// 的 corpus+probes 驱动**生产** parsePythonMethodBlocks/
// resolveOutgoingPythonMethodCalls/resolveIncomingPythonMethodCalls 复算
// 对拍 outcomes——三面:方法块解析(索引构建)/ outgoing 绑定+dedup /
// incoming 覆盖+作用域过滤。语义真值源是生产函数,镜像红 = Rust 移植错,
// 按 src/ 源码重推(本文件只读 golden,不改 src/)。
import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import {
  parsePythonMethodBlocks,
  resolveIncomingPythonMethodCalls,
  resolveOutgoingPythonMethodCalls
} from '../src/backend/pythonMethodCallQueries';

const REPO_ROOT = path.resolve(__dirname, '..');
const GOLDEN_PATH = path.join(REPO_ROOT, 'crates/kode-server/tests/golden/python-method-calls-parity.json');

/** golden 打开文档引用(corpus 条目作覆盖文本) */
interface GoldenOpenTextRef {
  corpus: string;
  fsPath: string;
}

/** golden 探测面(Rust Probe serde 形态;tag = "face") */
type GoldenProbe =
  | { face: 'outgoing'; targetFile: string; targetMethod: string }
  | { face: 'incoming'; targetFile: string; targetMethod: string; openTexts: GoldenOpenTextRef[] };

/** golden 产出面(与 Probe 一一对应) */
type GoldenOutcome =
  | { face: 'outgoing'; references: unknown[] }
  | { face: 'incoming'; incoming: unknown[] };

interface Golden {
  generator: string;
  corpus: Array<{ name: string; text: string; inIndex: boolean; fsPath: string }>;
  probes: GoldenProbe[];
  outcomes: GoldenOutcome[];
}

const golden: Golden = JSON.parse(fs.readFileSync(GOLDEN_PATH, 'utf8'));

/** 语料表(name → entry) */
const corpus = new Map(golden.corpus.map(entry => [entry.name, entry]));

/** 索引 = inIndex 条目按序解析(与 Rust build_index_from_corpus 同构) */
function buildIndex() {
  const methods = [];
  for (const entry of golden.corpus) {
    if (!entry.inIndex) {
      continue;
    }
    methods.push(...parsePythonMethodBlocks(entry.text, entry.fsPath));
  }
  return methods;
}

/** 单探测复算(生产函数);返回与 outcome 同形的值 */
function replay(probe: GoldenProbe): unknown {
  const index = buildIndex();
  if (probe.face === 'outgoing') {
    return {
      face: 'outgoing',
      references: resolveOutgoingPythonMethodCalls(index, probe.targetFile, probe.targetMethod)
    };
  }
  const openTexts = probe.openTexts.map(reference => {
    const entry = corpus.get(reference.corpus);
    if (!entry) {
      throw new Error(`corpus 缺失: ${reference.corpus}`);
    }
    return { fsPath: reference.fsPath, content: entry.text };
  });
  return {
    face: 'incoming',
    incoming: resolveIncomingPythonMethodCalls(index, openTexts, probe.targetFile, probe.targetMethod)
  };
}

describe('kode python method calls parity (RUST-145 golden replay)', () => {
  it('golden 自含:corpus 覆盖三进程/盲区/边界族,probes 与 outcomes 一一对应', () => {
    expect(golden.generator).toBe('dump-python-method-calls-golden');
    expect(golden.corpus.length).toBeGreaterThanOrEqual(8);
    expect(golden.corpus.filter(entry => entry.inIndex).length).toBeGreaterThanOrEqual(6);
    expect(golden.probes.length).toBe(golden.outcomes.length);
    expect(golden.probes.length).toBeGreaterThanOrEqual(12);
    const faces = new Set(golden.probes.map(probe => probe.face));
    expect(faces.has('outgoing')).toBe(true);
    expect(faces.has('incoming')).toBe(true);
    for (const entry of golden.corpus) {
      expect(typeof entry.name).toBe('string');
      expect(typeof entry.text).toBe('string');
      expect(typeof entry.fsPath).toBe('string');
      expect(typeof entry.inIndex).toBe('boolean');
    }
  });

  it('逐探测复算深等:outgoing 绑定/dedup 与 incoming 过滤/覆盖全对拍', () => {
    for (let index = 0; index < golden.probes.length; index += 1) {
      const probe = golden.probes[index];
      const outcome = golden.outcomes[index];
      const replayed = replay(probe);
      expect(replayed).toEqual(outcome);
    }
  });

  it('关键语义抽查:进程过滤保留未知区块,覆盖文本改变 incoming', () => {
    // 找到「incoming base prepare 无覆盖」探测:base 调用方留,cell 过滤,
    // common(未知区块)保守保留
    const probeIndex = golden.probes.findIndex(
      probe => probe.face === 'incoming'
        && probe.targetFile === 'ws/scripts/base/avatar.py'
        && probe.targetMethod === 'prepare'
        && probe.openTexts.length === 0
    );
    expect(probeIndex).toBeGreaterThanOrEqual(0);
    const outcome = golden.outcomes[probeIndex] as { face: 'incoming'; incoming: Array<{ caller: { filePath: string } }> };
    const callers = outcome.incoming.map(hit => hit.caller.filePath);
    expect(callers).toContain('ws/scripts/base/avatar.py');
    expect(callers).toContain('ws/scripts/common/util.py');
    expect(callers).not.toContain('ws/scripts/cell/avatar.py');
    // 同目标的覆盖探测:base 调用方随缓冲区消失
    const overrideIndex = golden.probes.findIndex(
      probe => probe.face === 'incoming'
        && probe.targetFile === 'ws/scripts/base/avatar.py'
        && probe.openTexts.length > 0
    );
    expect(overrideIndex).toBeGreaterThanOrEqual(0);
    const overrideOutcome = golden.outcomes[overrideIndex] as { face: 'incoming'; incoming: Array<{ caller: { filePath: string } }> };
    expect(overrideOutcome.incoming.map(hit => hit.caller.filePath)).not.toContain('ws/scripts/base/avatar.py');
  });
});
