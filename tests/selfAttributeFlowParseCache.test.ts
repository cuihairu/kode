import { describe, expect, it, beforeEach } from 'vitest';
import { computeSelfAttributeNoneFindings } from '../src/backend/selfAttributeNoneDiagnostics';
import {
  inferSelfAttributeFlow,
  resetSelfAttributeFlowParseCacheForTests,
  selfAttributeFlowParseCountForTests
} from '../src/backend/selfAttributeFlowTypes';

// KODE-PERF-001 流敏感分析按文档版本建缓存:同文档版本(键=uri|version)的
// 多次流查询——诊断/inlay 同版本共享——只解析一次 AST;版本递增/换文档
// 自然换键;无键调用(纯函数/测试)每次现解析,行为与纯函数一致。验收:
// 访问点增多不重复解析 + 万行级性能测试。prove-red=旧码无缓存导出(测试
// 加载红),证明「不重复解析」是新行为。

const DOC = [
  'class Talent:',
  '    def __init__(self):',
  '        self.TalentTree = None',
  '        self.Hp = None',
  '',
  '    def levelup(self):',
  '        self.TalentTree.add("x")',
  '        self.TalentTree.add("y")',
  '        self.Hp.value = 1',
  '',
  '    def reset(self):',
  '        self.TalentTree.clear()',
  ''
].join('\n');

describe('KODE-PERF-001 流敏感分析按文档版本建缓存', () => {
  beforeEach(() => resetSelfAttributeFlowParseCacheForTests());

  it('同版本一次诊断扫描(多访问点)→ 只解析一次;同版本再查复用', () => {
    const key = 'file:///a.py|3';
    const findings = computeSelfAttributeNoneFindings(DOC, undefined, key);
    // 4 个访问点(line 6/7/8/11,不同 (行,属性))→ 各触发流查询
    expect(findings.length).toBeGreaterThan(0);
    expect(selfAttributeFlowParseCountForTests()).toBe(1);
    // 同版本再查(inlay/后续诊断同版本)→ 复用缓存,不新增解析
    computeSelfAttributeNoneFindings(DOC, undefined, key);
    expect(selfAttributeFlowParseCountForTests()).toBe(1);
  });

  it('版本递增 → 重新解析;无键 → 每访问点现解析(纯函数回退)', () => {
    computeSelfAttributeNoneFindings(DOC, undefined, 'file:///a.py|3');
    expect(selfAttributeFlowParseCountForTests()).toBe(1);
    computeSelfAttributeNoneFindings(DOC, undefined, 'file:///a.py|4');
    expect(selfAttributeFlowParseCountForTests()).toBe(2);
    // 无键:纯函数回退,不读写缓存——每访问点现解析(DOC 有 4 个
    // (行,属性) 访问点 → 每次整扫描 4 次解析),行为与既有纯函数一致。
    computeSelfAttributeNoneFindings(DOC);
    expect(selfAttributeFlowParseCountForTests()).toBe(2 + 4);
    computeSelfAttributeNoneFindings(DOC);
    expect(selfAttributeFlowParseCountForTests()).toBe(2 + 8);
  });

  it('缓存有界:超 8 版本淘汰最旧,旧键重查重新解析(不无限增长)', () => {
    for (let v = 0; v < 20; v += 1) {
      computeSelfAttributeNoneFindings(DOC, undefined, `file:///a.py|${v}`);
    }
    expect(selfAttributeFlowParseCountForTests()).toBe(20);
    // 最旧版本(v=0)已被有界淘汰 → 重查重新解析
    computeSelfAttributeNoneFindings(DOC, undefined, 'file:///a.py|0');
    expect(selfAttributeFlowParseCountForTests()).toBe(21);
  });

  it('inferSelfAttributeFlow 直调:同键复用、异键重解、无键现算', () => {
    const lines = DOC.split('\n');
    const queryLine = 6; // self.TalentTree.add("x")
    inferSelfAttributeFlow(lines, queryLine, 'TalentTree', undefined, 'file:///a.py|9');
    expect(selfAttributeFlowParseCountForTests()).toBe(1);
    inferSelfAttributeFlow(lines, queryLine, 'TalentTree', undefined, 'file:///a.py|9');
    expect(selfAttributeFlowParseCountForTests()).toBe(1); // 命中复用
    inferSelfAttributeFlow(lines, queryLine, 'TalentTree', undefined, 'file:///a.py|10');
    expect(selfAttributeFlowParseCountForTests()).toBe(2);
    inferSelfAttributeFlow(lines, queryLine, 'TalentTree');
    expect(selfAttributeFlowParseCountForTests()).toBe(3);
  });

  it('万行级:10k+ 行文档数千访问点,同版本单次解析(访问点增多不重复解析)', () => {
    const lines: string[] = [
      'class Talent:',
      '    def __init__(self):',
      '        self.TalentTree = None',
      '        self.Hp = None'
    ];
    // 1000 方法 × 11 行(1 def + 3 自属性访问点 + 7 非 self 填充行)= 11k+
    // 行(万行级),访问点 3000(非 self 填充行不触发流查询)。访问点增多是
    // 验收核心:数千访问点同一版本,缓存令其只 1 次解析;旧码无缓存每访问点
    // 现解析(数千次重解析,万行级必超时)。
    for (let i = 0; i < 1000; i += 1) {
      lines.push(`    def method_${i}(self):`);
      for (let j = 0; j < 3; j += 1) {
        lines.push(`        self.TalentTree.add(${j})`);
      }
      for (let k = 0; k < 7; k += 1) {
        lines.push(`        x${k} = ${k}`);
      }
    }
    const bigDoc = lines.join('\n');
    expect(bigDoc.split('\n').length).toBeGreaterThan(10000); // 万行级
    const startedAt = performance.now();
    const findings = computeSelfAttributeNoneFindings(bigDoc, undefined, 'file:///big.py|1');
    const elapsedMs = performance.now() - startedAt;
    expect(findings.length).toBeGreaterThan(0);
    // 核心断言:数千访问点只 1 次解析(缓存生效)。耗时主面是流计算
    // (每查询全类基线扫描,非解析;KODE-PERF-001 面是解析缓存),界放宽防抖。
    expect(selfAttributeFlowParseCountForTests()).toBe(1);
    expect(elapsedMs).toBeLessThan(8000);
  });
});
