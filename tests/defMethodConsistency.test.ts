import { describe, expect, it } from 'vitest';
import {
  DEF_METHOD_MISSING_DIAGNOSTIC_CODE,
  PYTHON_METHOD_NOT_IN_DEF_DIAGNOSTIC_CODE,
  buildMethodStubCode,
  collectDefMethodMissingItems,
  collectPythonMethodNotInDefItems,
  defArgTypeToPythonAnnotation
} from '../src/defMethodConsistency';

// C-19 纯逻辑半边:def↔Python 方法一致性(诊断定位 + 一键骨架)。类型映射
// 与 PYTHON_BUILTIN_TYPE_ANNOTATIONS 同源(单一事实源);骨架只发射内建注解
// (int/float/str/bool/bytes),Tuple/Dict/List/Any 需 import 不发射;诊断定位
// 按方法名在声明行内首个 `<name` 出现,回退整行区间。

describe('defArgTypeToPythonAnnotation(内建注解映射,单一事实源)', () => {
  it('内建标量映射:UINT32→int、FLOAT→float、STRING→str、BOOL→bool、BLOB→bytes', () => {
    expect(defArgTypeToPythonAnnotation('UINT32')).toBe('int');
    expect(defArgTypeToPythonAnnotation('INT8')).toBe('int');
    expect(defArgTypeToPythonAnnotation('UINT64')).toBe('int');
    expect(defArgTypeToPythonAnnotation('FLOAT')).toBe('float');
    expect(defArgTypeToPythonAnnotation('DOUBLE')).toBe('float');
    expect(defArgTypeToPythonAnnotation('STRING')).toBe('str');
    expect(defArgTypeToPythonAnnotation('UNICODE')).toBe('str');
    expect(defArgTypeToPythonAnnotation('BOOL')).toBe('bool');
    expect(defArgTypeToPythonAnnotation('BLOB')).toBe('bytes');
  });

  it('需 import 的 typing 泛型不发射:VECTOR3/Tuple、PY_DICT/Dict、PY_LIST/List、PYTHON/Any、ENTITYCALL/Any → undefined', () => {
    expect(defArgTypeToPythonAnnotation('VECTOR2')).toBeUndefined();
    expect(defArgTypeToPythonAnnotation('VECTOR3')).toBeUndefined();
    expect(defArgTypeToPythonAnnotation('VECTOR4')).toBeUndefined();
    expect(defArgTypeToPythonAnnotation('PY_DICT')).toBeUndefined();
    expect(defArgTypeToPythonAnnotation('PY_LIST')).toBeUndefined();
    expect(defArgTypeToPythonAnnotation('PY_TUPLE')).toBeUndefined();
    expect(defArgTypeToPythonAnnotation('PYTHON')).toBeUndefined();
    expect(defArgTypeToPythonAnnotation('ENTITYCALL')).toBeUndefined();
  });

  it('未知类型/空串/带空白 → undefined(不猜)', () => {
    expect(defArgTypeToPythonAnnotation('CUSTOM')).toBeUndefined();
    expect(defArgTypeToPythonAnnotation('')).toBeUndefined();
    expect(defArgTypeToPythonAnnotation('   ')).toBeUndefined();
    expect(defArgTypeToPythonAnnotation(' UINT32 ')).toBe('int');
  });
});

describe('buildMethodStubCode(骨架:形参自 def 类型映射,体可配)', () => {
  it('pass 默认体:签名自 <Arg> 类型映射(内建注解),VECTOR3 裸 argN', () => {
    expect(buildMethodStubCode('reqPos', ['UINT32', 'VECTOR3'], 'pass')).toBe(
      '    def reqPos(self, arg0: int, arg1):\n        pass\n'
    );
  });

  it('raise 体:raise NotImplementedError', () => {
    expect(buildMethodStubCode('reqPos', ['UINT32', 'VECTOR3'], 'raise')).toBe(
      '    def reqPos(self, arg0: int, arg1):\n        raise NotImplementedError\n'
    );
  });

  it('无参方法:签名只 (self)', () => {
    expect(buildMethodStubCode('onTick', [], 'pass')).toBe(
      '    def onTick(self):\n        pass\n'
    );
  });

  it('全部裸参数(非内建类型):退化为 arg0/arg1 无注解', () => {
    expect(buildMethodStubCode('doIt', ['PYTHON', 'VECTOR3'], 'pass')).toBe(
      '    def doIt(self, arg0, arg1):\n        pass\n'
    );
  });
});

describe('collectDefMethodMissingItems(诊断定位与关联)', () => {
  const defText = [
    '<root>',
    '  <BaseMethods>',
    '    <reqPos>',
    '      <Arg>UINT32</Arg>',
    '    </reqPos>',
    '    <onTick/>',
    '  </BaseMethods>',
    '  <CellMethods>',
    '    <onLevelUp/>',
    '  </CellMethods>',
    '</root>',
    ''
  ].join('\n');

  it('空 gaps → 空 items', () => {
    expect(collectDefMethodMissingItems(defText, [])).toEqual([]);
  });

  it('定位方法名区间(首个 <name 出现,+1 跳过 <)+消息与关联目标', () => {
    const items = collectDefMethodMissingItems(defText, [
      {
        name: 'reqPos',
        line: 3,
        section: 'BaseMethods',
        declaredArgs: ['UINT32'],
        ownerName: 'Avatar',
        ownerFile: '/ws/scripts/base/Avatar.py'
      }
    ]);
    expect(items).toHaveLength(1);
    const item = items[0];
    // <reqPos> 在第 3 行:< 后即方法名;验证字节区间落在 reqPos
    const nameOffset = defText.indexOf('reqPos');
    expect(item.startOffset).toBe(nameOffset);
    expect(item.endOffset).toBe(nameOffset + 'reqPos'.length);
    expect(item.message).toContain('方法 reqPos 声明于 base 段');
    expect(item.message).toContain('实体类 Avatar');
    expect(item.message).toContain('Avatar.py');
    expect(item.related.targetFile).toBe('/ws/scripts/base/Avatar.py');
    expect(item.related.label).toContain('Avatar');
  });

  it('自闭合方法(onTick/)同样定位;CellMethods 段标签 client 段', () => {
    const items = collectDefMethodMissingItems(defText, [
      { name: 'onTick', line: 6, section: 'BaseMethods', declaredArgs: [], ownerName: 'Avatar', ownerFile: '/w/base/Avatar.py' },
      { name: 'onLevelUp', line: 9, section: 'CellMethods', declaredArgs: [], ownerName: 'Avatar', ownerFile: '/w/cell/Avatar.py' }
    ]);
    const onTick = items.find(item => item.message.includes('方法 onTick'));
    expect(onTick).toBeDefined();
    expect(onTick!.startOffset).toBe(defText.indexOf('onTick'));
    expect(onTick!.message).toContain('base 段');
    const onLevelUp = items.find(item => item.message.includes('方法 onLevelUp'));
    expect(onLevelUp).toBeDefined();
    expect(onLevelUp!.message).toContain('cell 段');
  });

  it('越界行 → 跳过(不产生越界诊断);方法名不在该行回退整行区间', () => {
    expect(collectDefMethodMissingItems(defText, [
      { name: 'ghost', line: 999, section: 'BaseMethods', declaredArgs: [], ownerName: 'Avatar', ownerFile: '/w/base/Avatar.py' }
    ])).toEqual([]);
    // 方法名在该行找不到(声明行与名字错位)→ 回退整行区间,不丢诊断
    const items = collectDefMethodMissingItems(defText, [
      { name: 'reqPos', line: 2, section: 'BaseMethods', declaredArgs: [], ownerName: 'Avatar', ownerFile: '/w/base/Avatar.py' }
    ]);
    expect(items).toHaveLength(1);
    expect(items[0].startOffset).toBeLessThan(items[0].endOffset);
  });

  it('\r\n 行尾也定位正确(行首偏移含 \r 不破坏)', () => {
    const text = '<root>\r\n  <BaseMethods>\r\n    <reqPos/>\r\n  </BaseMethods>\r\n</root>\r\n';
    const items = collectDefMethodMissingItems(text, [
      { name: 'reqPos', line: 3, section: 'BaseMethods', declaredArgs: [], ownerName: 'Avatar', ownerFile: '/w/base/Avatar.py' }
    ]);
    expect(items).toHaveLength(1);
    expect(items[0].startOffset).toBe(text.indexOf('reqPos'));
    expect(items[0].endOffset).toBe(text.indexOf('reqPos') + 'reqPos'.length);
  });
});

describe('collectPythonMethodNotInDefItems(反向规则项)', () => {
  it('映射 gaps → 诊断项(消息/定位/长度)', () => {
    const items = collectPythonMethodNotInDefItems([
      { methodName: 'helper', line: 4, character: 4 }
    ]);
    expect(items).toHaveLength(1);
    expect(items[0].line).toBe(4);
    expect(items[0].character).toBe(4);
    expect(items[0].length).toBe('helper'.length);
    expect(items[0].message).toContain('方法 helper');
    expect(items[0].message).toContain('.def 未声明');
  });
});

describe('诊断 code 常量', () => {
  it('正向规则 code=Rust lint 规则 id(统一 def-method-missing-in-python)', () => {
    // KODE-AUD-002:正向必须与 Provider CodeAction + Rust lint 规则 id 同值,
    // 否则严格比较不命中致 CodeAction 恒空。
    expect(DEF_METHOD_MISSING_DIAGNOSTIC_CODE).toBe('def-method-missing-in-python');
    // 反向规则无 Rust/CodeAction 对接口,沿用 kbengine.<camelCase> 惯例。
    expect(PYTHON_METHOD_NOT_IN_DEF_DIAGNOSTIC_CODE).toBe('kbengine.pythonMethodNotInDef');
  });
});
