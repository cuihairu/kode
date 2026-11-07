import { describe, expect, it } from 'vitest';

import {
  analyzeDestroyedEntityCaptures,
  DESTROYED_ENTITY_REFERENCE_DIAGNOSTIC_CODE
} from '../src/destroyedEntityCaptureDiagnostics';

// C-23 交付②第二条规则:已销毁实体引用滞留(KBE-PY-016,数据源=KB-001
// 生命周期/内存专题)。KB-001 事实:真正的引用隐患不是定时器(引擎 destroy
// 即 cancelAll,定时器不持强引用),而是脚本侧闭包/容器把实体(或 self)
// 存进生命周期长于实体的模块级容器——引擎 3600 s 后打 garbages 泄漏告警。
// 判定保守面:模块级(顶格)list/dict/set 容器 + 类体内语句把 `self` 存入
// (append/add/extend/update/下标赋值);局部容器、非 self 实参、同形注释
// 不报——不分析闭包逃逸,不冒充全量分析。

describe('analyzeDestroyedEntityCaptures(KBE-PY-016)', () => {
  it('正例:模块级容器收 self(append/add/extend/下标赋值)都报', () => {
    const text = [
      'REGISTRY = []',
      'INDEX = {}',
      'WATCH = set()',
      '',
      'class Avatar:',
      '    def register(self):',
      '        REGISTRY.append(self)',
      '        WATCH.add(self)',
      '        INDEX[self.id] = self',
      '        REGISTRY.extend([self])',
      ''
    ].join('\n');
    const findings = analyzeDestroyedEntityCaptures(text);
    expect(findings.map(f => [f.line, f.container, f.method])).toEqual([
      [6, 'REGISTRY', 'append'],
      [7, 'WATCH', 'add'],
      [8, 'INDEX', 'subscript'],
      [9, 'REGISTRY', 'extend']
    ]);
    expect(findings[0].message).toContain('onDestroy');
    expect(DESTROYED_ENTITY_REFERENCE_DIAGNOSTIC_CODE).toBe('kbengine.destroyedEntityReference');
  });

  it('反例:局部容器/非 self 实参/读操作不报(误报=0)', () => {
    const text = [
      'REGISTRY = []',
      '',
      'class Avatar:',
      '    def work(self):',
      '        local = []',
      '        local.append(self)',
      '        REGISTRY.append(self.id)',
      '        found = self in REGISTRY',
      '        # REGISTRY.append(self)',
      ''
    ].join('\n');
    expect(analyzeDestroyedEntityCaptures(text)).toEqual([]);
  });

  it('非容器全局(标量)赋 self 不在容器面;lambda 捕捉不在本规则面(不冒充)', () => {
    const text = [
      'FACTORY = None',
      '',
      'class Avatar:',
      '    def make(self):',
      '        FACTORY = lambda: self',
      ''
    ].join('\n');
    expect(analyzeDestroyedEntityCaptures(text)).toEqual([]);
  });
});
