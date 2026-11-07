import { describe, expect, it } from 'vitest';

import {
  PROPERTY_DIRECTION_VIOLATION_DIAGNOSTIC_CODE,
  PROPERTY_DIRECTION_SCOPE_UNKNOWN_DIAGNOSTIC_CODE,
  inferProcessScopeFromPythonFile,
  findPropertyDirectionFindings,
  findPropertyDirectionFindingsAsync,
  propertyDirectionDiagnosticItems,
  propertyDirectionDiagnosticItemsAsync,
  type PropertyDirectionHit
} from '../src/propertyDirectionDiagnostics';

// GEN-DEF-1e ④:方向违规诊断(属性面)。纯函数,resolve 以 stub 替身注入
// (与 provider 层的 resolvePropertyDefinitionInfo 回包同形),锁三态:
// ① 接收者段不在属性域位 → Warning;② 裸 self.<prop> 文件作用域不在域位 →
// Warning;③ 文件作用域不足 → Information(降级,不标 Error)。
// 非 def 属性 / Flags 未配置 / getter-only(self.cell 无属性)一律不诊断。

const BASE_FILE = '/ws/scripts/base/Hero.py';
const CELL_FILE = '/ws/scripts/cell/Hero.py';
const CLIENT_FILE = '/ws/scripts/client/Hero.py';
const AMBIGUOUS_FILE = '/ws/scripts/common/Hero.py';

const hit = (domains: Array<'base' | 'cell' | 'client'>): PropertyDirectionHit => ({
  propertyName: 'hp',
  domains,
  defFile: '/ws/scripts/entity_defs/Hero.def',
  defLine: 10
});

/** resolve 替身:按 propertyPath 命中,未命中回退 rootSymbol(镜像
 * findIndexedPropertyIn 的「完整路径 或 根段」双查口径;rootSymbol 为
 * FIXED_DICT 嵌套路径的首段) */
const resolver =
  (spec: Record<string, PropertyDirectionHit | null | undefined> = {}) =>
  (propertyPath: string, rootSymbol: string): PropertyDirectionHit | null | undefined =>
    spec[propertyPath] ?? spec[rootSymbol] ?? null;

describe('inferProcessScopeFromPythonFile', () => {
  it('按 scripts/base|cell|client 段推断进程作用域', () => {
    expect(inferProcessScopeFromPythonFile(BASE_FILE)).toBe('base');
    expect(inferProcessScopeFromPythonFile(CELL_FILE)).toBe('cell');
    expect(inferProcessScopeFromPythonFile(CLIENT_FILE)).toBe('client');
  });

  it('非角色目录(scripts/common)作用域不足 → undefined', () => {
    expect(inferProcessScopeFromPythonFile(AMBIGUOUS_FILE)).toBeUndefined();
  });
});

describe('findPropertyDirectionFindings 属性方向违规', () => {
  it('接收者段在属性域位内 → 不诊断(self.cell.hp,hp=cell 域)', () => {
    const findings = findPropertyDirectionFindings(
      'x = self.cell.hp',
      CELL_FILE,
      resolver({ hp: hit(['cell']) })
    );
    expect(findings).toEqual([]);
  });

  it('接收者段不在属性域位内 → Warning(self.base.hp,hp=cell 域)', () => {
    const findings = findPropertyDirectionFindings(
      'x = self.base.hp',
      BASE_FILE,
      resolver({ hp: hit(['cell']) })
    );
    expect(findings).toHaveLength(1);
    expect(findings[0].severity).toBe('Warning');
    expect(findings[0].code).toBe(PROPERTY_DIRECTION_VIOLATION_DIAGNOSTIC_CODE);
    expect(findings[0].receiver).toBe('base');
    expect(findings[0].message).toContain('hp');
    expect(findings[0].message).toContain('cell');
    expect(findings[0].message).toContain('base');
  });

  it('裸 self.hp 文件作用域不在域位内 → Warning(base 文件访问 cell 域属性)', () => {
    const findings = findPropertyDirectionFindings(
      'x = self.hp',
      BASE_FILE,
      resolver({ hp: hit(['cell']) })
    );
    expect(findings).toHaveLength(1);
    expect(findings[0].severity).toBe('Warning');
    expect(findings[0].fileScope).toBe('base');
  });

  it('裸 self.hp 文件作用域在域位内 → 不诊断(cell 文件访问 cell 域属性)', () => {
    const findings = findPropertyDirectionFindings(
      'x = self.hp',
      CELL_FILE,
      resolver({ hp: hit(['cell']) })
    );
    expect(findings).toEqual([]);
  });

  it('多域属性(BASE_AND_CLIENT):base/client 裸访问放行,cell 接收者取不到', () => {
    const both = hit(['base', 'client']);
    expect(findPropertyDirectionFindings('x = self.hp', BASE_FILE, resolver({ hp: both }))).toEqual([]);
    expect(findPropertyDirectionFindings('x = self.hp', CLIENT_FILE, resolver({ hp: both }))).toEqual([]);
    // cell ∉ [base, client] → 经 cell 侧取不到
    const cellHit = findPropertyDirectionFindings('x = self.cell.hp', CELL_FILE, resolver({ hp: both }));
    expect(cellHit).toHaveLength(1);
    expect(cellHit[0].severity).toBe('Warning');
  });

  it('文件作用域不足 → Information 降级(不标 Error)', () => {
    const findings = findPropertyDirectionFindings(
      'x = self.hp',
      AMBIGUOUS_FILE,
      resolver({ hp: hit(['cell']) })
    );
    expect(findings).toHaveLength(1);
    expect(findings[0].severity).toBe('Information');
    expect(findings[0].code).toBe(PROPERTY_DIRECTION_SCOPE_UNKNOWN_DIAGNOSTIC_CODE);
    expect(findings[0].message).toContain('process scope');
  });

  it('接收者限定不受文件作用域影响(self.cell.hp 在 base 文件仍按接收者判)', () => {
    const findings = findPropertyDirectionFindings(
      'x = self.cell.hp',
      BASE_FILE,
      resolver({ hp: hit(['cell']) })
    );
    expect(findings).toEqual([]);
  });

  it('非 def 属性(resolve 未命中)不诊断', () => {
    const findings = findPropertyDirectionFindings(
      'x = self.some_plain_attr',
      BASE_FILE,
      resolver({})
    );
    expect(findings).toEqual([]);
  });

  it('Flags 未配置(空域位)不诊断,不发明方向', () => {
    const findings = findPropertyDirectionFindings(
      'x = self.hp',
      BASE_FILE,
      resolver({ hp: hit([]) })
    );
    expect(findings).toEqual([]);
  });

  it('getter-only self.cell(无属性路径)不诊断:解析器对 getter 名未命中', () => {
    const findings = findPropertyDirectionFindings(
      'x = self.cell',
      BASE_FILE,
      resolver({})
    );
    expect(findings).toEqual([]);
  });

  it('嵌套 FIXED_DICT 属性路径按根段判(self.inventory.items)', () => {
    const findings = findPropertyDirectionFindings(
      'x = self.inventory.items',
      CELL_FILE,
      resolver({ inventory: hit(['cell']) })
    );
    expect(findings).toEqual([]);
    const bad = findPropertyDirectionFindings(
      'x = self.inventory.items',
      BASE_FILE,
      resolver({ inventory: hit(['cell']) })
    );
    expect(bad).toHaveLength(1);
    expect(bad[0].severity).toBe('Warning');
    expect(bad[0].propertyPath).toBe('inventory.items');
  });

  it('多处访问各出一finding,位置口径(0 起行/列)正确', () => {
    const text = ['x = self.base.hp', 'y = self.hp'].join('\n');
    const findings = findPropertyDirectionFindings(text, BASE_FILE, resolver({ hp: hit(['cell']) }));
    expect(findings).toHaveLength(2);
    expect(findings[0].line).toBe(0);
    expect(findings[1].line).toBe(1);
    // self.base.hp:属性名 hp 起点 = index('hp')
    expect(findings[0].character).toBe(text.split('\n')[0].indexOf('hp'));
    expect(findings[0].length).toBe(2);
  });
});

describe('propertyDirectionDiagnosticItems 入口', () => {
  it('enabled=false 零产出', () => {
    const items = propertyDirectionDiagnosticItems(
      'x = self.base.hp',
      BASE_FILE,
      resolver({ hp: hit(['cell']) }),
      false
    );
    expect(items).toEqual([]);
  });

  it('Warning 项带 code/severity/source/range', () => {
    const items = propertyDirectionDiagnosticItems(
      'x = self.base.hp',
      BASE_FILE,
      resolver({ hp: hit(['cell']) }),
      true
    );
    expect(items).toHaveLength(1);
    expect(items[0].severity).toBe('Warning');
    expect(items[0].source).toBe('kbengine');
    expect(items[0].code).toBe(PROPERTY_DIRECTION_VIOLATION_DIAGNOSTIC_CODE);
    expect(items[0].range.start.character).toBe('x = self.base.'.length);
    expect(items[0].range.end.character).toBe('x = self.base.'.length + 2);
  });
});

describe('propertyDirectionDiagnosticItemsAsync 异步入口', () => {
  it('异步解析器预解析去重后产出与同步同口径(同属性多处访问只解析一次)', async () => {
    const text = ['x = self.cell.hp', 'y = self.hp', 'z = self.hp'].join('\n');
    let resolveCalls = 0;
    const items = await propertyDirectionDiagnosticItemsAsync(
      text,
      BASE_FILE,
      async (propertyPath, _rootSymbol) => {
        resolveCalls += 1;
        return propertyPath === 'hp' ? hit(['cell']) : null;
      },
      true
    );
    // 三处访问同一属性 hp(self.cell.hp 剥接收者 → hp;两处裸 self.hp),按
    // (hp,hp) 去重为一次解析;self.cell.hp 在 cell 域内不违规,两处裸
    // self.hp 在 base 文件访问 cell 域属性 → 各一 Warning,共 2 finding
    expect(resolveCalls).toBe(1);
    expect(items).toHaveLength(2);
    expect(items[0].severity).toBe('Warning');
    expect(items[1].severity).toBe('Warning');
  });

  it('enabled=false 零产出(异步面同开关)', async () => {
    const items = await propertyDirectionDiagnosticItemsAsync(
      'x = self.base.hp',
      BASE_FILE,
      async () => hit(['cell']),
      false
    );
    expect(items).toEqual([]);
  });

  it('异步面与同步面同一输入同产出口径', async () => {
    const text = 'x = self.base.hp';
    const sync = propertyDirectionDiagnosticItems(text, BASE_FILE, resolver({ hp: hit(['cell']) }), true);
    const asyncItems = await propertyDirectionDiagnosticItemsAsync(
      text,
      BASE_FILE,
      async () => hit(['cell']),
      true
    );
    expect(asyncItems).toEqual(sync);
  });

  it('findPropertyDirectionFindingsAsync 直接可用(测试面)', async () => {
    const findings = await findPropertyDirectionFindingsAsync(
      'x = self.base.hp',
      BASE_FILE,
      async () => hit(['cell'])
    );
    expect(findings).toHaveLength(1);
    expect(findings[0].severity).toBe('Warning');
  });
});
