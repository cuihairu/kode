// RUST-430(旧 HR-QA-018):安全与功能完成矩阵按 target、engine profile、文件类型、
// 触发方式逐项签收。
//
// 签收形态=frozen matrix fixture(tests/fixtures/hot-reload-completion-matrix.json)
// + 本门的**fixture↔现实一致性**校验:
//   * 每一维(target / engineProfile / fileType / trigger)的每个取值都必须被至少一个
//     已签收 cell 覆盖——漏签收的维度取值即红(矩阵不得空转);
//   * 每个 cell 的签收结论(covered-test / covered-src / out-of-scope)必须自洽:
//     covered-test 的 evidence 必须是**真实存在**的测试文件,covered-src 必须是
//     **真实存在**的 src 文件——签收不得凭印象指;
//   * out-of-scope 必须带理由(不静默吞缺口);
//   * 安全面含一条由**本门直接实证**的性质:HTTP 发送链不引 child_process
//     (纯传输),引即红——签收不是自我声明,是本门跑的性质。
//
// 诚实边界:本门钉「矩阵与现实一致」,不重跑各 cell 背后的既有套件(它们各自是
// 独立车道);新增/改动维度取值须同时补 cell 或补 out-of-scope 理由,否则本门红。

import { readFileSync } from 'fs';
import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it } from 'vitest';

const FIXTURE_PATH = path.join(__dirname, 'fixtures', 'hot-reload-completion-matrix.json');

interface MatrixCell {
  id: string;
  axis: string;
  value: string;
  function: string;
  security: string;
  verdict: string;
  evidence: string[];
  note?: string;
}
interface SecurityCell {
  id: string;
  invariant: string;
  verdict: string;
  evidence: string[];
  verifier?: string;
  note?: string;
}
interface OutOfScopeCell {
  id: string;
  axis: string;
  value: string;
  reason: string;
  verdict: string;
}
interface Matrix {
  family: string;
  version: number;
  dimensions: Record<string, string[]>;
  cells: MatrixCell[];
  security: SecurityCell[];
  'out-of-scope': OutOfScopeCell[];
}

const ROOT = path.resolve(__dirname, '..');
const READ = () => JSON.parse(readFileSync(FIXTURE_PATH, 'utf8')) as Matrix;

const exists = (relative: string): boolean => fs.existsSync(path.join(ROOT, relative));

const VERDICTS = new Set(['covered-test', 'covered-src', 'out-of-scope']);

/** evidence 逐条必须真实存在;covered-test 只许指测试文件,covered-src 只许指 src */
const assertEvidence = (id: string, verdict: string, evidence: string[]): void => {
  expect(evidence.length, `${id} 签收须指证据`).toBeGreaterThan(0);
  for (const relative of evidence) {
    expect(exists(relative), `${id}:证据不存在 ${relative}`).toBe(true);
  }
  if (verdict === 'covered-test') {
    for (const relative of evidence) {
      expect(relative.startsWith('tests/'), `${id}:covered-test 证据须为测试文件 (${relative})`).toBe(true);
    }
  }
  if (verdict === 'covered-src') {
    for (const relative of evidence) {
      expect(relative.startsWith('src/'), `${id}:covered-src 证据须为 src 文件 (${relative})`).toBe(true);
    }
  }
};

describe('RUST-430 完成矩阵:fixture↔现实一致性', () => {
  it('维度与 cell 形状自洽:四轴齐全,结论合法', () => {
    const matrix = READ();
    expect(matrix.family).toBe('hot-reload-completion-matrix');
    expect(matrix.version).toBeGreaterThan(0);
    for (const axis of ['target', 'engineProfile', 'fileType', 'trigger']) {
      const values = matrix.dimensions[axis];
      expect(Array.isArray(values), `${axis} 维度须非空`).toBe(true);
      expect(values.length).toBeGreaterThan(0);
      expect(new Set(values).size).toBe(values.length); // 取值不重复
    }
    expect(matrix.cells.length).toBeGreaterThan(0);
    const ids = new Set<string>();
    for (const cell of matrix.cells) {
      expect(ids.has(cell.id), `cell id 重复: ${cell.id}`).toBe(false);
      ids.add(cell.id);
      expect(VERDICTS.has(cell.verdict), `${cell.id}:结论须为 ${[...VERDICTS].join('/')}`).toBe(true);
      expect(cell.function.trim().length, `${cell.id}:功能签收文案`).toBeGreaterThan(0);
      expect(cell.security.trim().length, `${cell.id}:安全签收文案`).toBeGreaterThan(0);
      if (cell.axis === 'e2e') {
        continue; // 复合轴:e2e,不绑单维取值
      }
      const values = matrix.dimensions[cell.axis];
      expect(values?.length, `${cell.id}:轴 ${cell.axis} 须已声明`).toBeGreaterThan(0);
      expect(values, `${cell.id}:取值 ${cell.value} 未在维度声明`).toContain(cell.value);
    }
  });

  it('每一维的每个取值都被签收(矩阵不空转):维度值漏签收即红', () => {
    const matrix = READ();
    for (const [axis, values] of Object.entries(matrix.dimensions)) {
      const signed = new Set(matrix.cells.filter(cell => cell.axis === axis).map(cell => cell.value));
      for (const value of values) {
        expect(signed.has(value), `${axis}/${value} 未签收(cell 或 out-of-scope 其一)`).toBe(true);
      }
    }
  });

  it('签收证据逐条真实存在,且按结论分面(covered-test→测试文件 / covered-src→src)', () => {
    const matrix = READ();
    for (const cell of matrix.cells) {
      assertEvidence(cell.id, cell.verdict, cell.evidence);
    }
    for (const sec of matrix.security) {
      assertEvidence(sec.id, sec.verdict, sec.evidence);
      expect(VERDICTS.has(sec.verdict), `${sec.id}:结论须合法`).toBe(true);
    }
  });

  it('安全面性质直接实证:HTTP 发送链不引 child_process(纯传输)', () => {
    const matrix = READ();
    const noExec = matrix.security.filter(sec => sec.verifier === 'no-child-process');
    expect(noExec.length, '须有一条 no-child-process 性质').toBeGreaterThan(0);
    const forbidden = [/from\s+['"]child_process['"]/, /require\(\s*['"]child_process['"]\s*\)/, /import\(\s*['"]child_process['"]\s*\)/];
    for (const sec of noExec) {
      for (const relative of sec.evidence) {
        const text = readFileSync(path.join(ROOT, relative), 'utf8');
        for (const pattern of forbidden) {
          expect(pattern.test(text), `${relative} 引入 child_process:${pattern}`).toBe(false);
        }
      }
    }
  });

  it('out-of-scope 必须带理由(缺口不静默吞),且轴/取值合法', () => {
    const matrix = READ();
    expect(matrix['out-of-scope'].length, '缺口须显式登记').toBeGreaterThan(0);
    for (const cell of matrix['out-of-scope']) {
      expect(cell.verdict).toBe('out-of-scope');
      expect(cell.reason.trim().length, `${cell.id}:缺口须带理由`).toBeGreaterThan(0);
      const values = matrix.dimensions[cell.axis];
      expect(values?.length, `${cell.id}:轴 ${cell.axis} 须已声明`).toBeGreaterThan(0);
      expect(values, `${cell.id}:取值 ${cell.value} 未在维度声明`).toContain(cell.value);
    }
  });
});
