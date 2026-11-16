// CodeAction 决策核对拍门禁(RUST-143 批 1):读 Rust 侧生成的 golden
// (crates/kode-server/tests/golden/code-action-parity.json)的 corpus+probes
// 驱动**生产**函数逐探测复算,逐条对拍 outcomes——七面:类块插入点
// (findPythonClassInsertionPoint)/方法骨架(buildMethodStubCode)/类型替换
// 候选(findRegisteredTypeSuggestions)/接收者区间归属
// (receiverFromDiagnosticLine)/早退守卫编辑(buildReceiverNoneGuardEdit)/
// 包裹式守卫编辑(buildReceiverNoneWrapEdit)/整体重赋编辑
// (buildFixedDictWholeReassignEdit)。语义真值源是生产函数,镜像红 =
// Rust 移植错,按 src/ 源码重推(本文件只读 golden,不改 src/)。
import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { findPythonClassInsertionPoint, receiverFromDiagnosticLine } from '../src/languageProviders/codeAction';
import { findRegisteredTypeSuggestions } from '../src/languageProviders/completion';
import { buildMethodStubCode } from '../src/backend/defMethodConsistency';
import { buildReceiverNoneGuardEdit, buildReceiverNoneWrapEdit } from '../src/backend/receiverNoneDiagnostics';
import { buildFixedDictWholeReassignEdit } from '../src/backend/behaviorLints';

const REPO_ROOT = path.resolve(__dirname, '..');
const GOLDEN_PATH = path.join(REPO_ROOT, 'crates/kode-server/tests/golden/code-action-parity.json');

/** golden 探测面(Rust Probe serde 形态;tag = "face",变体字段 snake_case) */
type GoldenProbe =
  | { face: 'insertion'; corpus: string; class_name: string }
  | { face: 'stub'; method_name: string; arg_types: string[]; body: 'pass' | 'raise' }
  | { face: 'suggestions'; unknown: string; registered: string[] }
  | { face: 'receiverFace'; corpus: string; line: number; start_char: number; end_char: number }
  | { face: 'guardEdit'; corpus: string; line: number; receiver: string }
  | { face: 'wrapEdit'; corpus: string; line: number; receiver: string }
  | { face: 'fdEdit'; corpus: string; line: number };

/** golden 产出面(与 Probe 一一对应;tag 同形,字段 camelCase) */
type GoldenOutcome =
  | { face: 'insertion'; result: { line: number; blankPrefix: boolean } | null }
  | { face: 'stub'; code: string }
  | { face: 'suggestions'; hits: string[] }
  | { face: 'receiverFace'; receiver: string | null }
  | { face: 'guardEdit'; edit: { line: number; text: string } | null }
  | { face: 'wrapEdit'; edit: { startLine: number; endLine: number; text: string } | null }
  | { face: 'fdEdit'; edit: { startLine: number; endLine: number; text: string } | null };

interface Golden {
  generator: string;
  corpus: Array<{ name: string; text: string }>;
  probes: GoldenProbe[];
  outcomes: GoldenOutcome[];
}

const golden: Golden = JSON.parse(fs.readFileSync(GOLDEN_PATH, 'utf8'));

/** 语料正文表(name → text) */
const corpus = new Map<string, string>(golden.corpus.map(entry => [entry.name, entry.text]));

/** TS split(/\r?\n/) 行取(越界空串,镜像 Rust run_probe 的 lines.get(..).unwrap_or("")) */
function lineAt(text: string, line: number): string {
  const lines = text.split(/\r?\n/);
  return lines[line] ?? '';
}

/** 单探测复算(生产函数);返回与 outcome 同形的值 */
function replay(probe: GoldenProbe): unknown {
  switch (probe.face) {
    case 'insertion':
      return findPythonClassInsertionPoint(corpus.get(probe.corpus) ?? '', probe.class_name);
    case 'stub':
      return buildMethodStubCode(probe.method_name, probe.arg_types, probe.body);
    case 'suggestions':
      return findRegisteredTypeSuggestions(probe.unknown, probe.registered);
    case 'receiverFace':
      return receiverFromDiagnosticLine(lineAt(corpus.get(probe.corpus) ?? '', probe.line), probe.start_char, probe.end_char);
    case 'guardEdit':
      return buildReceiverNoneGuardEdit(corpus.get(probe.corpus) ?? '', probe.line, probe.receiver as 'cell' | 'base' | 'client');
    case 'wrapEdit':
      return buildReceiverNoneWrapEdit(corpus.get(probe.corpus) ?? '', probe.line, probe.receiver as 'cell' | 'base' | 'client');
    case 'fdEdit':
      return buildFixedDictWholeReassignEdit(corpus.get(probe.corpus) ?? '', probe.line);
  }
}

describe('kode code action parity (RUST-143 golden replay)', () => {
  it('golden 自含:corpus 覆盖边界形态族,probes 与 outcomes 一一对应', () => {
    expect(golden.generator).toBe('dump-code-action-golden');
    expect(golden.corpus.length).toBeGreaterThanOrEqual(10);
    expect(golden.probes.length).toBe(golden.outcomes.length);
    expect(golden.probes.length).toBeGreaterThanOrEqual(300);
    for (const entry of golden.corpus) {
      expect(typeof entry.name).toBe('string');
      expect(typeof entry.text).toBe('string');
    }
  });

  it('逐探测复算对拍 outcomes(七面全覆盖)', () => {
    const mismatches: string[] = [];
    const covered = new Set<string>();
    for (let index = 0; index < golden.probes.length; index += 1) {
      const probe = golden.probes[index];
      const outcome = golden.outcomes[index];
      covered.add(probe.face);
      const actual = replay(probe);
      const expected = (() => {
        switch (outcome.face) {
          case 'insertion': return outcome.result;
          case 'stub': return outcome.code;
          case 'suggestions': return outcome.hits;
          case 'receiverFace': return outcome.receiver;
          case 'guardEdit': return outcome.edit;
          case 'wrapEdit': return outcome.edit;
          case 'fdEdit': return outcome.edit;
        }
      })();
      // 对拍:falsy(null)两侧都 falsy 即平;否则深等
      const flat = (actual === null || actual === undefined) && (expected === null || expected === undefined);
      if (!flat && JSON.stringify(actual) !== JSON.stringify(expected)) {
        mismatches.push(
          `#${index} ${probe.face} probe=${JSON.stringify(probe)}\n  ts=${JSON.stringify(actual)}\n  rust=${JSON.stringify(expected)}`
        );
      }
    }
    expect([...covered], '七面未全覆盖').toEqual(
      expect.arrayContaining(['insertion', 'stub', 'suggestions', 'receiverFace', 'guardEdit', 'wrapEdit', 'fdEdit'])
    );
    expect(mismatches, `对拍红 ${mismatches.length} 条:\n${mismatches.slice(0, 20).join('\n')}`).toEqual([]);
  });

  it('非空产出分布:各面都有命中(防全 null 空转)', () => {
    const counts: Record<string, number> = {};
    for (let index = 0; index < golden.probes.length; index += 1) {
      const probe = golden.probes[index];
      const outcome = golden.outcomes[index];
      const hit = (() => {
        switch (outcome.face) {
          case 'insertion': return outcome.result !== null;
          case 'suggestions': return outcome.hits.length > 0;
          case 'receiverFace': return outcome.receiver !== null;
          case 'stub': return true;
          default: return outcome.edit !== null;
        }
      })();
      if (hit) {
        counts[probe.face] = (counts[probe.face] ?? 0) + 1;
      }
    }
    expect(counts.insertion).toBeGreaterThan(0);
    expect(counts.stub).toBeGreaterThan(0);
    expect(counts.suggestions).toBeGreaterThan(0);
    expect(counts.receiverFace).toBeGreaterThan(0);
    expect(counts.guardEdit).toBeGreaterThan(0);
    expect(counts.wrapEdit).toBeGreaterThan(0);
    expect(counts.fdEdit).toBeGreaterThan(0);
  });
});
