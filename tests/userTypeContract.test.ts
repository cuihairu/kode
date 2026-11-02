import { describe, expect, it } from 'vitest';

import {
  USER_TYPE_CONTRACT_METHODS,
  USER_TYPE_CONTRACT_CONSEQUENCE,
  USER_TYPE_CONTRACT_MISSING_DIAGNOSTIC_CODE,
  collectUserTypeContractMissing,
  collectUserTypeContractMissingByImplFile,
  contractSymbolName,
  implFileHasContractMethod,
  type UserTypeContractStatus
} from '../src/userTypeContract';

const fullStatus = (overrides: Partial<UserTypeContractStatus> = {}): UserTypeContractStatus => ({
  name: 'TalentTree',
  implementedBy: 'talent.TalentTreeImpl',
  implFile: '/ws/scripts/user_type/talent.py',
  implLine: 12,
  methods: {
    createObjFromDict: true,
    getDictFromObj: true,
    isSameType: true
  },
  ...overrides
});

describe('GEN-DEF-1e user_type 三契约索引(GEN-DEF-1e)', () => {
  it('契约方法名序与引擎 setImplModule 取法一致(createObjFromDict/getDictFromObj/isSameType)', () => {
    expect(USER_TYPE_CONTRACT_METHODS).toEqual([
      'createObjFromDict',
      'getDictFromObj',
      'isSameType'
    ]);
  });

  it('诊断 code 遵循 kbengine.<camelCase> 惯例', () => {
    expect(USER_TYPE_CONTRACT_MISSING_DIAGNOSTIC_CODE).toBe('kbengine.userTypeContractMethodMissing');
  });

  it('三契约方法全部存在 → 零缺方法诊断', () => {
    expect(collectUserTypeContractMissing(fullStatus())).toEqual([]);
  });

  it('缺 createObjFromDict → 一条诊断,文案写明反序列化后果方向(口径③)', () => {
    const status = fullStatus({ methods: { createObjFromDict: false, getDictFromObj: true, isSameType: true } });
    const items = collectUserTypeContractMissing(status);
    expect(items).toHaveLength(1);
    expect(items[0].method).toBe('createObjFromDict');
    expect(items[0].typeName).toBe('TalentTree');
    expect(items[0].symbolName).toBe('TalentTreeImpl');
    expect(items[0].message).toContain('createObjFromDict');
    expect(items[0].message).toContain(USER_TYPE_CONTRACT_CONSEQUENCE.createObjFromDict);
    expect(items[0].message).toContain('无法从网络/DB 构造');
  });

  it('缺 getDictFromObj → 文案写明序列化后果方向(无法写网络/持久化)', () => {
    const status = fullStatus({ methods: { createObjFromDict: true, getDictFromObj: false, isSameType: true } });
    const items = collectUserTypeContractMissing(status);
    expect(items).toHaveLength(1);
    expect(items[0].method).toBe('getDictFromObj');
    expect(items[0].message).toContain('无法写网络/持久化');
  });

  it('缺 isSameType → 文案写明类型判定失效', () => {
    const status = fullStatus({ methods: { createObjFromDict: true, getDictFromObj: true, isSameType: false } });
    const items = collectUserTypeContractMissing(status);
    expect(items).toHaveLength(1);
    expect(items[0].method).toBe('isSameType');
    expect(items[0].message).toContain('类型判定失效');
  });

  it('三个全缺 → 三条诊断(三诊断全亮场景),各带独立后果方向', () => {
    const status = fullStatus({
      methods: { createObjFromDict: false, getDictFromObj: false, isSameType: false }
    });
    const items = collectUserTypeContractMissing(status);
    expect(items).toHaveLength(3);
    expect(items.map(item => item.method)).toEqual([
      'createObjFromDict',
      'getDictFromObj',
      'isSameType'
    ]);
  });

  it('impl 文件缺失(implFile 为空)→ 静默,由「user_type 未找到 python 文件」诊断兜底', () => {
    const status = fullStatus({ implFile: undefined, implLine: undefined });
    expect(collectUserTypeContractMissing(status)).toEqual([]);
  });

  it('symbolName 取 implementedBy 后段;缺省回退类型名', () => {
    expect(contractSymbolName(fullStatus())).toBe('TalentTreeImpl');
    expect(contractSymbolName(fullStatus({ implementedBy: 'a.b.c' }))).toBe('c');
    expect(contractSymbolName(fullStatus({ implementedBy: undefined }))).toBe('TalentTree');
  });

  it('collectUserTypeContractMissingByImplFile 按文件聚合,仅命中该 impl 文件', () => {
    const a = fullStatus({
      name: 'A',
      implementedBy: 'm.AImpl',
      implFile: '/ws/scripts/user_type/a.py',
      implLine: 5,
      methods: { createObjFromDict: false, getDictFromObj: false, isSameType: false }
    });
    const b = fullStatus({ name: 'B', implementedBy: 'm.BImpl', implFile: '/ws/scripts/user_type/b.py', implLine: 9 });
    const items = collectUserTypeContractMissingByImplFile([a, b], '/ws/scripts/user_type/a.py');
    expect(items).toHaveLength(3); // a 三缺
    expect(items.every(item => item.line === 5)).toBe(true);
    expect(items.every(item => item.typeName === 'A')).toBe(true);
  });

  it('implFileHasContractMethod 识别 def 方法(缩进无关,类/模块形态皆认)', () => {
    const source = [
      'class TalentTreeImpl:',
      '    def createObjFromDict(self, dictData):',
      '        return dictData',
      '    def getDictFromObj(self, obj):',
      '        return {}',
      '    def isSameType(self, obj):',
      '        return True'
    ].join('\n');
    expect(implFileHasContractMethod(source, 'createObjFromDict')).toBe(true);
    expect(implFileHasContractMethod(source, 'getDictFromObj')).toBe(true);
    expect(implFileHasContractMethod(source, 'isSameType')).toBe(true);
  });

  it('implFileHasContractMethod 对缺失/相似名不误报', () => {
    const source = [
      'class TalentTreeImpl:',
      '    def createObjFromDict(self, dictData): ...',
      '    def getDictFromObjExtra(self, obj): ...' // 相似名前缀不算命中
    ].join('\n');
    expect(implFileHasContractMethod(source, 'createObjFromDict')).toBe(true);
    expect(implFileHasContractMethod(source, 'getDictFromObj')).toBe(false);
    expect(implFileHasContractMethod(source, 'isSameType')).toBe(false);
  });
});
