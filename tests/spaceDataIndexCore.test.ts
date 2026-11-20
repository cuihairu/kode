/**
 * KSEM-DATA-06(SEM-047)空间数据读写纯核边界(覆盖批5)。
 *
 * 面:实参括号深度切分 / 实参空白裁边 / 键字面量退化形态(短串、内嵌
 * 同引号表达式)/ 别名过滤 / 键位补全上下文(别名过滤、点链、首实参
 * 串态与括号态)/ 落点探测越界与异行。全部纯函数直查,零 vscode 依赖。
 *
 * 诚实边界:286/381 的 fnName 半臂按正则恒真不可达(模式只匹配三个
 * spaceData API 名),别名半臂可达已测;其余批5 miss 臂全部可达,零
 * 防御臂。
 */

import { describe, it, expect } from 'vitest';
import {
  findKbeSpaceDataCalls,
  findKbeSpaceDataCallAtPosition,
  spaceDataKeyCompletionContext
} from '../src/backend/spaceDataIndexCore';

const ALIASES = new Set(['KBEngine']);

describe('findKbeSpaceDataCalls 实参形态边界', () => {
  it('实参嵌套括号:深度感知切分不劈内层,调用照收', () => {
    const dictCalls = findKbeSpaceDataCalls(
      'KBEngine.setSpaceData(1, "cfg", {"hp": 100})',
      ALIASES
    );
    expect(dictCalls).toHaveLength(1);
    expect(dictCalls[0]).toMatchObject({
      fn: 'setSpaceData',
      keySignature: 'cfg',
      spaceIdSignature: '1'
    });
    const listCalls = findKbeSpaceDataCalls('KBEngine.setSpaceData(1, "xs", [1, 2])', ALIASES);
    expect(listCalls).toHaveLength(1);
    expect(listCalls[0].keySignature).toBe('xs');
  });

  it('实参首尾空白:裁边后键位锚引号内容真列', () => {
    const calls = findKbeSpaceDataCalls('KBEngine.getSpaceData( 1 , "hp" )', ALIASES);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      fn: 'getSpaceData',
      keySignature: 'hp',
      keyStart: 28,
      keyEnd: 30,
      spaceIdSignature: '1'
    });
  });

  it('键实参单字符裸名:非字面量 → keySignature null,键区间如实落位', () => {
    const calls = findKbeSpaceDataCalls('KBEngine.setSpaceData(1, k, "v")', ALIASES);
    expect(calls).toHaveLength(1);
    expect(calls[0].keySignature).toBeNull();
    expect(calls[0].keyStart).toBe(25);
    expect(calls[0].keyEnd).toBe(26);
  });

  it("键实参内嵌同引号表达式('a' + 'b'):非简单字面量 → null", () => {
    const calls = findKbeSpaceDataCalls('KBEngine.setSpaceData(1, \'a\' + \'b\', "v")', ALIASES);
    expect(calls).toHaveLength(1);
    expect(calls[0].keySignature).toBeNull();
    expect(calls[0].keyStart).toBe(25);
    expect(calls[0].keyEnd).toBe(34);
  });

  it('别名过滤:非注册别名调用不入索引,同行异名互不误收', () => {
    const calls = findKbeSpaceDataCalls(
      'other.setSpaceData(1, "k", "v")\nKBEngine.getSpaceData(1, "hp")',
      ALIASES
    );
    expect(calls).toHaveLength(1);
    expect(calls[0].fn).toBe('getSpaceData');
    expect(calls[0].line).toBe(1);
  });
});

describe('spaceDataKeyCompletionContext 首实参扫描边界', () => {
  it('别名不在注册集 → null', () => {
    expect(spaceDataKeyCompletionContext('other.setSpaceData(1, "', 23, ALIASES)).toBeNull();
  });

  it('x.KBEngine 点链前缀 → 非模块访问,null', () => {
    expect(
      spaceDataKeyCompletionContext('x.KBEngine.setSpaceData(1, "', 28, ALIASES)
    ).toBeNull();
  });

  it('首实参引号串(含转义):串态扫描带过,上下文照返(sid 非字面量 → 签名 null)', () => {
    // 行文 `KBEngine.getSpaceData("a\"b", "`:光标在键位引号后(行尾)
    const line = 'KBEngine.getSpaceData("a\\"b", "';
    const ctx = spaceDataKeyCompletionContext(line, line.length, ALIASES);
    expect(ctx).toEqual({
      fn: 'getSpaceData',
      spaceIdSignature: null,
      partial: '',
      replaceStart: line.length
    });
  });

  it('首实参带括号:闭括号即已离键位 → null', () => {
    expect(
      spaceDataKeyCompletionContext('KBEngine.getSpaceData(x[0], "', 29, ALIASES)
    ).toBeNull();
  });
});

describe('findKbeSpaceDataCallAtPosition 落点探测边界', () => {
  it('character 越行界 → null', () => {
    expect(
      findKbeSpaceDataCallAtPosition('KBEngine.setSpaceData(1, "hp", "v")', 0, 999, ALIASES)
    ).toBeNull();
  });

  it('异行调用逐个跳过:命中查询行调用返回', () => {
    const text = 'KBEngine.setSpaceData(1, "hp", "v")\n\nKBEngine.getSpaceData(2, "mp")';
    const found = findKbeSpaceDataCallAtPosition(text, 2, 27, ALIASES);
    expect(found).not.toBeNull();
    expect(found!.fn).toBe('getSpaceData');
    expect(found!.line).toBe(2);
    expect(found!.keySignature).toBe('mp');
  });
});
