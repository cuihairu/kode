import { describe, expect, it } from 'vitest';

import {
  PROPERTY_DIRECTION_VIOLATION_DIAGNOSTIC_CODE,
  PROPERTY_DIRECTION_SCOPE_UNKNOWN_DIAGNOSTIC_CODE,
  PROPERTY_DIRECTION_SHADOW_DIAGNOSTIC_CODE,
  PROPERTY_DIRECTION_CELL_DATA_COPY_DIAGNOSTIC_CODE,
  PROPERTY_DIRECTION_CELL_DATA_KEY_DIAGNOSTIC_CODE,
  inferProcessScopeFromPythonFile,
  findInitAssignedSelfProperties,
  findPropertyDirectionFindings,
  findPropertyDirectionFindingsAsync,
  propertyDirectionDiagnosticItems,
  propertyDirectionDiagnosticItemsAsync,
  propertyDirectionShadowHintItems,
  propertyDirectionShadowHintItemsAsync,
  type PropertyDirectionHit
} from '../src/backend/propertyDirectionDiagnostics';

// GEN-DEF-1e ④:方向违规诊断(属性面)。纯函数,resolve 以 stub 替身注入
// (与 provider 层的 resolvePropertyDefinitionInfo 回包同形),锁三态:
// ① 接收者段不在属性域位 → Warning;② 裸 self.<prop> 文件作用域不在域位 →
// Warning;③ 文件作用域不足 → Information(降级,不标 Error)。
// 非 def 属性 / Flags 未配置 / getter-only(self.cell 无属性)一律不诊断。
// cellData 通道(2026-11-10 用户报障收编):__init__ 里 self.y =
// self.cellData["x"] 的 y 是 cell 字段副本——裸访问不再报 Warning,改出
// 淡色 inlay「复制属性 x: 类型 · 域位」(提示流);cellData["key"] 出 key
// 的 def 面(域位不含 cell 追加「不在 cellData」);右侧非 cellData 的
// __init__ 赋值暂不展示也不报错(用户令「暂时复制属性吧」)。

const BASE_FILE = '/ws/scripts/base/Hero.py';
const CELL_FILE = '/ws/scripts/cell/Hero.py';
const CLIENT_FILE = '/ws/scripts/client/Hero.py';
const AMBIGUOUS_FILE = '/ws/scripts/common/Hero.py';

const hit = (
  domains: Array<'base' | 'cell' | 'client'>,
  extra: Partial<PropertyDirectionHit> = {}
): PropertyDirectionHit => ({
  propertyName: 'hp',
  domains,
  defFile: '/ws/scripts/entity_defs/Hero.def',
  defLine: 10,
  ...extra
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

// cellData 通道(2026-11-10 用户报障收编):__init__ 影子属性降级 + 复制属性
// 提示流 + cellData 键 def 面提示流。用户令:不下划线(不像错误)、就提示
// 「复制属性」开头、颜色淡(inlay 通道)、cellData["x"] 处显示 x。

const COPY_FIXTURE = [
  'class Hero:',
  '    def __init__(self):',
  '        self.spaceUType = self.cellData["spaceUType"]',
  '',
  '    def onTick(self):',
  '        return self.spaceUType',
  ''
].join('\n');

const SPACE_U_TYPE = hit(['cell', 'client'], {
  propertyName: 'spaceUType',
  typeName: 'UINT32'
});

describe('findInitAssignedSelfProperties __init__ 赋值扫描', () => {
  it('收名字/位置/cellData 键三面', () => {
    const result = findInitAssignedSelfProperties(COPY_FIXTURE);
    expect(result.names.has('spaceUType')).toBe(true);
    const site = result.sites.get('spaceUType');
    expect(site?.line).toBe(2);
    // 锚在 self.spaceUType token 之后(赋值行缩进 8 + 'self.' 5 + 名 10)
    expect(site?.character).toBe('        self.spaceUType'.length);
    expect(result.cellDataCopyKeys.get('spaceUType')).toBe('spaceUType');
  });

  it('== / += / 注解赋值不计(保守,宁漏勿错)', () => {
    const text = [
      'class Hero:',
      '    def __init__(self):',
      '        self.a == self.cellData["x"]',
      '        self.b += 1',
      '        self.c: int = 1',
      ''
    ].join('\n');
    const result = findInitAssignedSelfProperties(text);
    expect(result.names.size).toBe(0);
    expect(result.cellDataCopyKeys.size).toBe(0);
  });

  it('出块(缩进回落)收手,下一类 __init__ 重新进入', () => {
    const text = [
      'class A:',
      '    def __init__(self):',
      '        self.x = 1',
      '    def tick(self):',
      '        self.y = 2',
      '',
      'class B:',
      '    def __init__(self):',
      '        self.z = self.cellData["z"]',
      ''
    ].join('\n');
    const result = findInitAssignedSelfProperties(text);
    expect(result.names.has('x')).toBe(true);
    expect(result.names.has('y')).toBe(false); // 出块后不属于 __init__
    expect(result.names.has('z')).toBe(true);
    expect(result.cellDataCopyKeys.get('z')).toBe('z');
  });

  it('RHS .get("key") 形态同样收键', () => {
    const text = [
      'class Hero:',
      '    def __init__(self):',
      '        self.hp = self.cellData.get("hp")',
      ''
    ].join('\n');
    expect(findInitAssignedSelfProperties(text).cellDataCopyKeys.get('hp')).toBe('hp');
  });
});

describe('影子属性降级(__init__ 赋值 → 不再报 Warning)', () => {
  it('cellData 取值副本:裸访问出复制属性提示,诊断流零产出', () => {
    const findings = findPropertyDirectionFindings(
      COPY_FIXTURE,
      BASE_FILE,
      resolver({ spaceUType: SPACE_U_TYPE })
    );
    // 裸访问降级为复制属性提示(不再 Warning)
    const copies = findings.filter(f => f.code === PROPERTY_DIRECTION_CELL_DATA_COPY_DIAGNOSTIC_CODE);
    expect(copies.length).toBeGreaterThanOrEqual(2); // 赋值行 + 裸访问行
    for (const copy of copies) {
      expect(copy.severity).toBe('Information');
      expect(copy.cellDataKey).toBe('spaceUType');
      expect(copy.typeName).toBe('UINT32');
      expect(copy.message).toContain('copy');
    }
    expect(copies.some(copy => copy.line === 5)).toBe(true);
    const diagnostics = propertyDirectionDiagnosticItems(
      COPY_FIXTURE, BASE_FILE, resolver({ spaceUType: SPACE_U_TYPE }), true
    );
    expect(diagnostics).toEqual([]); // 诊断流(下划线)零产出
  });

  it('右侧非 cellData 的 __init__ 赋值:不报 Warning,暂不出提示(用户令「暂时复制属性」)', () => {
    const text = [
      'class Hero:',
      '    def __init__(self):',
      '        self.hp = 100',
      '',
      '    def onTick(self):',
      '        return self.hp',
      ''
    ].join('\n');
    const findings = findPropertyDirectionFindings(
      text, BASE_FILE, resolver({ hp: hit(['cell']) })
    );
    expect(findings.length).toBeGreaterThanOrEqual(1);
    for (const finding of findings) {
      expect(finding.code).toBe(PROPERTY_DIRECTION_SHADOW_DIAGNOSTIC_CODE);
      expect(finding.severity).toBe('Information');
    }
    expect(propertyDirectionDiagnosticItems(text, BASE_FILE, resolver({ hp: hit(['cell']) }), true)).toEqual([]);
    expect(propertyDirectionShadowHintItems(text, BASE_FILE, resolver({ hp: hit(['cell']) }), true)).toEqual([]);
  });

  it('__init__ 未赋值的裸访问维持 Warning(真失效引用)', () => {
    const findings = findPropertyDirectionFindings(
      'x = self.hp', BASE_FILE, resolver({ hp: hit(['cell']) })
    );
    expect(findings).toHaveLength(1);
    expect(findings[0].severity).toBe('Warning');
    expect(findings[0].code).toBe(PROPERTY_DIRECTION_VIOLATION_DIAGNOSTIC_CODE);
  });

  it('接收者限定形式不受影子影响(self.base.hp 仍 Warning)', () => {
    const text = [
      'class Hero:',
      '    def __init__(self):',
      '        self.hp = self.cellData["hp"]',
      '',
      'x = self.base.hp',
      ''
    ].join('\n');
    const findings = findPropertyDirectionFindings(
      text, BASE_FILE, resolver({ hp: hit(['cell']) })
    );
    // 赋值行另有复制属性提示与 cellData 键 def 面提示(合法产出);接收者
    // 限定访问不受影子影响,违规 Warning 必须仍在
    const violations = findings.filter(f => f.code === PROPERTY_DIRECTION_VIOLATION_DIAGNOSTIC_CODE);
    expect(violations).toHaveLength(1);
    expect(violations[0].severity).toBe('Warning');
    expect(violations[0].receiver).toBe('base');
  });
});

describe('propertyDirectionShadowHintItems 提示流(inlay 淡色小字)', () => {
  it('复制属性提示:label 带 key/类型/域位,锚在 self.<名> token 后', () => {
    const hints = propertyDirectionShadowHintItems(
      COPY_FIXTURE, BASE_FILE, resolver({ spaceUType: SPACE_U_TYPE }), true
    );
    const copies = hints.filter(hint => hint.code === PROPERTY_DIRECTION_CELL_DATA_COPY_DIAGNOSTIC_CODE);
    expect(copies).toHaveLength(2); // 赋值行一行一条,裸访问行一条
    for (const copy of copies) {
      expect(copy.label).toBe('copied property spaceUType: UINT32 · cell|client');
      expect(copy.tooltip).toContain('copy');
    }
    // 裸访问行锚在 self.spaceUType 之后
    const bare = copies.find(copy => copy.position.line === 5);
    expect(bare?.position.character).toBe('        return self.spaceUType'.length);
  });

  it('cellData["key"] 提示:key 是 def 属性带 def 面;域位含 cell 无后缀', () => {
    const hints = propertyDirectionShadowHintItems(
      COPY_FIXTURE, BASE_FILE, resolver({ spaceUType: SPACE_U_TYPE }), true
    );
    const keys = hints.filter(hint => hint.code === PROPERTY_DIRECTION_CELL_DATA_KEY_DIAGNOSTIC_CODE);
    expect(keys).toHaveLength(1);
    expect(keys[0].position.line).toBe(2);
    expect(keys[0].label).toBe('spaceUType: UINT32 · cell|client');
    expect(keys[0].tooltip).toContain('carries');
  });

  it('key 是 def 属性但域位不含 cell:追加「不在 cellData」', () => {
    const text = 'x = self.cellData["mana"]';
    const hints = propertyDirectionShadowHintItems(
      text, BASE_FILE, resolver({ mana: hit(['base'], { typeName: 'UINT8' }) }), true
    );
    expect(hints).toHaveLength(1);
    expect(hints[0].label).toBe('mana: UINT8 · base · not in cellData');
    expect(hints[0].tooltip).toContain('never carries');
  });

  it('非 def 键(position/direction/脚本自塞键)跳过,不发明', () => {
    const text = 'x = self.cellData["position"]\ny = self.cellData["whatever"]';
    const hints = propertyDirectionShadowHintItems(
      text, BASE_FILE, resolver({}), true
    );
    expect(hints).toEqual([]);
  });

  it('解析未带类型时 label 不带类型段', () => {
    const text = 'x = self.cellData["mana"]';
    const hints = propertyDirectionShadowHintItems(
      text, BASE_FILE, resolver({ mana: hit(['base']) }), true
    );
    expect(hints).toHaveLength(1);
    expect(hints[0].label).toBe('mana · base · not in cellData');
  });

  it('Flags 未配置(空域位)键跳过,不发明是否在 cellData', () => {
    const text = 'x = self.cellData["mana"]';
    const hints = propertyDirectionShadowHintItems(
      text, BASE_FILE, resolver({ mana: hit([]) }), true
    );
    expect(hints).toEqual([]);
  });

  it('enabled=false 零产出', () => {
    expect(propertyDirectionShadowHintItems(
      COPY_FIXTURE, BASE_FILE, resolver({ spaceUType: SPACE_U_TYPE }), false
    )).toEqual([]);
  });
});

describe('propertyDirectionShadowHintItemsAsync 异步提示流', () => {
  it('与同步提示流同产出口径', async () => {
    const sync = propertyDirectionShadowHintItems(
      COPY_FIXTURE, BASE_FILE, resolver({ spaceUType: SPACE_U_TYPE }), true
    );
    const asyncHints = await propertyDirectionShadowHintItemsAsync(
      COPY_FIXTURE, BASE_FILE, async () => SPACE_U_TYPE, true
    );
    expect(asyncHints.map(hint => [hint.position, hint.label, hint.code]))
      .toEqual(sync.map(hint => [hint.position, hint.label, hint.code]));
  });

  it('cellData 键与复制键预解析去重(异步解析器只解析一次)', async () => {
    let resolveCalls = 0;
    await propertyDirectionShadowHintItemsAsync(
      COPY_FIXTURE, BASE_FILE, async (propertyPath) => {
        resolveCalls += 1;
        return propertyPath === 'spaceUType' ? SPACE_U_TYPE : null;
      }, true
    );
    // 唯一解析键:spaceUType(裸访问/复制键/cellData 键同键合并)+ cellData
    // (属性访问扫描命中但非 def 属性,也预解析一次)
    expect(resolveCalls).toBe(2);
  });

  it('enabled=false 零产出(异步面同开关)', async () => {
    const hints = await propertyDirectionShadowHintItemsAsync(
      COPY_FIXTURE, BASE_FILE, async () => SPACE_U_TYPE, false
    );
    expect(hints).toEqual([]);
  });
});
