import { readFileSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from 'vitest';

// IDE-RST-010:Python R2b 继续或暂缓决策记录锁。范围评审定的闸门是
// 「只有当解析成本被证实为主要、用户可感知瓶颈后,再做 Rust Python 解析
// 原型」——本测试锁住决策文档的证据面与结论形态:四阶段实测数字在档、
// 单轮免责口径、暂缓结论与复评触发,防止后续改动悄悄把「暂缓」改成
// 「已采纳」或把单轮实测写成普适结论。

const root = join(__dirname, '..');
const docPath = join(root, 'docs', 'review', '2026-10-29-python-r2b-decision.md');

const doc = (): string => readFileSync(docPath, 'utf8');

describe('IDE-RST-010:Python R2b 决策记录', () => {
  it('决策文档在档且四节齐备', () => {
    const text = doc();
    for (const heading of [
      '## 1. 判据回顾',
      '## 2. 修复后分层实测数据',
      '## 3. 判定',
      '## 4. 复评触发',
      '## 5. 若触发的采纳顺序'
    ]) {
      expect(text, `缺章节 ${heading}`).toContain(heading);
    }
  });

  it('四阶段实测数字在档(编辑面三档+MRO+注解查询)', () => {
    const text = doc();
    // 编辑面三档 parse/commit p50(S 0.70 / M 21.00 / L 213.00;commit 0.10 / 0.50 / 4.20)
    for (const number of ['0.70ms', '21.00ms', '213.00ms', '0.10ms', '0.50ms', '4.20ms', '1,549,607']) {
      expect(text, `实测数字缺席: ${number}`).toContain(number);
    }
    // MRO 与注解查询面
    for (const number of ['1.40ms', '3.10ms']) {
      expect(text, `查询面数字缺席: ${number}`).toContain(number);
    }
    // 真机验收数字(ACC-001/002)
    for (const token of ['9ms', '1ms', '0.001ms', '194']) {
      expect(text, `真机数字缺席: ${token}`).toContain(token);
    }
  });

  it('单轮免责与 PERF-015 口径在档', () => {
    const text = doc();
    expect(text).toContain('本机单轮');
    expect(text).toContain('PERF-015');
    expect(text).toContain('合成语料');
    // 波动如实记录:L 档两轮 213↔331.6,只作方向判据
    expect(text).toContain('331.6');
    expect(text).toContain('方向判据');
  });

  it('worker 阈值代码锚点真实存在(暂缓理由的架构事实)', () => {
    const hostSource = readFileSync(
      join(root, 'src', 'pythonParserWorkerHost.ts'), 'utf8'
    );
    expect(hostSource).toContain('PYTHON_WORKER_PARSE_THRESHOLD = 256 * 1024');
    const text = doc();
    expect(text).toContain('PYTHON_WORKER_PARSE_THRESHOLD = 256×1024');
    expect(text).toContain('pythonParserWorkerHost.ts:6');
    // 暂缓核心理由:超阈值解析不在主线程,主线程实付是 commit 段
    expect(text).toContain('不在扩展宿主主线程');
  });

  it('结论形态:暂缓 + 解析未被证明为主要成本 + 不含已采纳表述', () => {
    const text = doc();
    expect(text).toContain('**暂缓**');
    expect(text).toContain('未被证明为修复后用户可感知的主要成本');
    // 判据回顾必须引用范围评审闸门原文语义
    expect(text).toContain('只有当解析成本被证实为主要、用户可感知瓶颈后');
    // 暂缓不得同时声称已推进原型/已迁移
    expect(text).not.toMatch(/已(推进|完成)原型/);
    expect(text).not.toContain('R2b 已完成');
  });

  it('复评触发三条齐备且采纳顺序在档', () => {
    const text = doc();
    for (const trigger of ['document-parse p95', 'worker', '超阈值']) {
      expect(text, `复评触发缺面: ${trigger}`).toContain(trigger);
    }
    expect(text).toContain('parser-head2head');
    expect(text).toContain('pr-012');
  });
});
