import { describe, expect, it } from 'vitest';
import { computeSelfAttributeNoneFindings } from '../src/backend/selfAttributeNoneDiagnostics';

// KODE-PERF-002:消除流诊断平方级行号计算——旧码每匹配
// `source.slice(0, match.index).split('\n').length - 1` 是 O(匹配数 × 文件长)
// 平方级;新码一次行起始偏移表 + 双指针(匹配 index 单调递增)整体 O(n)。
// 验收:10 万行文件诊断耗时实测对比。prove-red=旧码平方级(100k 行 5 万
// 访问点实测 >180s 不可用),新码线性毫秒级。

/** 匹配位 → 行号(旧公式口径,与实现等值验证用) */
function oldStyleLine(source: string, index: number): number {
  return source.slice(0, index).split('\n').length - 1;
}

describe('KODE-PERF-002 流诊断平方级行号计算消除', () => {
  it('行号口径与旧公式等值(CRLF/LF/无尾换行/空行穿插)', () => {
    const cases = [
      'class T:\n    def __init__(self):\n        self.a = None\n    def m(self):\n        self.a.foo()\n',
      'class T:\r\n    def __init__(self):\r\n        self.a = None\r\n    def m(self):\r\n        self.a.foo()\r\n',
      'class T:\n    def __init__(self):\n        self.a = None\n\n\n    def m(self):\n        self.a.foo()',
      'class T:\n    def __init__(self):\n        self.a = None\n    def m(self):\n        self.a.foo()\n    def n(self):\n        self.a.bar()\n    def p(self):\n        self.a.baz()\n',
      'class T:\n    def __init__(self):\n        self.a = None\n    def m(self):\n        self.a.foo()\n        self.a.bar()\n        self.a.baz()\n'
    ];
    for (const source of cases) {
      const findings = computeSelfAttributeNoneFindings(source);
      const re = /\bself\.([A-Za-z_]\w*)\.([A-Za-z_]\w*)/g;
      const oldLines: number[] = [];
      let match: RegExpExecArray | null;
      while ((match = re.exec(source)) !== null) {
        oldLines.push(oldStyleLine(source, match.index));
      }
      // 全部自管访问有 None 证据 → 每条访问都出 finding,行号应与旧公式一致
      expect(findings.map(f => f.line)).toEqual(oldLines);
    }
  });

  it('10 万行文件诊断耗时:线性完成(旧码平方级同规模 >180s 不可用)', () => {
    const lines: string[] = [];
    // 100k 行:200 条访问行 × 250 访问点 = 5 万访问点,散布全文件(高 index
    // 处触发旧码平方);无类 → 流引擎无上下文返回 null,纯扫描隔离行号成本。
    for (let i = 0; i < 100000; i += 1) {
      if (i % 500 === 0) {
        const accesses = Array.from({ length: 250 }, (_, j) => `self.bag.m${j}`).join('; ');
        lines.push(`        ${accesses}`);
      } else {
        lines.push('        x = 1');
      }
    }
    const doc = lines.join('\n');
    expect(doc.split('\n').length).toBe(100000);
    const matches = (doc.match(/\bself\.\w+\.\w+/g) ?? []).length;
    expect(matches).toBe(50000);
    const startedAt = performance.now();
    // 真实诊断路径(extension.ts)传 versionKey → KODE-PERF-001 缓存解析一次;
    // 这样耗时主面是行号计算(KODE-PERF-002 面),不被重复解析掩盖。
    const findings = computeSelfAttributeNoneFindings(doc, undefined, 'file:///perf.py|1');
    const elapsedMs = performance.now() - startedAt;
    expect(findings).toEqual([]); // 无类 → 流 null,零 finding
    // 旧码平方级:5 万匹配 × 均 index 5 万 = 25 亿字符切片/分裂 → 数分钟;
    // 新码线性:行起始表 + 双指针,应毫秒级。界留 CI 抖动裕度。
    expect(elapsedMs).toBeLessThan(5000);
  });
});
