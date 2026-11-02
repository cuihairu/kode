import { describe, expect, it } from 'vitest';
import {
  inferPythonLiteralAnnotation,
  parsePythonLiteral,
  pythonLiteralAnnotation
} from '../src/pythonLiteralTypes';

describe('pythonLiteralTypes(GEN-DEF-1c:def <Default> 字面量 → 精确注解)', () => {
  it('标量字面量精确到基础类型', () => {
    expect(pythonLiteralAnnotation(parsePythonLiteral('123')!)).toBe('int');
    expect(pythonLiteralAnnotation(parsePythonLiteral('-5')!)).toBe('int');
    expect(pythonLiteralAnnotation(parsePythonLiteral('1.5')!)).toBe('float');
    expect(pythonLiteralAnnotation(parsePythonLiteral('.5')!)).toBe('float');
    expect(pythonLiteralAnnotation(parsePythonLiteral('1e3')!)).toBe('float');
    expect(pythonLiteralAnnotation(parsePythonLiteral('"abc"')!)).toBe('str');
    expect(pythonLiteralAnnotation(parsePythonLiteral("'x'")!)).toBe('str');
    expect(pythonLiteralAnnotation(parsePythonLiteral('b"ab"')!)).toBe('bytes');
    expect(pythonLiteralAnnotation(parsePythonLiteral('True')!)).toBe('bool');
    expect(pythonLiteralAnnotation(parsePythonLiteral('False')!)).toBe('bool');
    expect(pythonLiteralAnnotation(parsePythonLiteral('None')!)).toBe('None');
  });

  it('list/tuple/set/dict 容器与嵌套', () => {
    expect(pythonLiteralAnnotation(parsePythonLiteral('[1, 2, 3]')!)).toBe('list[int]');
    expect(pythonLiteralAnnotation(parsePythonLiteral('[1, "a"]')!)).toBe('list[Union[int, str]]');
    expect(pythonLiteralAnnotation(parsePythonLiteral('[]')!)).toBe('list');
    expect(pythonLiteralAnnotation(parsePythonLiteral('(1, 2)')!)).toBe('tuple[int, int]');
    expect(pythonLiteralAnnotation(parsePythonLiteral('(1,)')!)).toBe('tuple[int]');
    expect(pythonLiteralAnnotation(parsePythonLiteral('()')!)).toBe('tuple');
    expect(pythonLiteralAnnotation(parsePythonLiteral('{"hp": 1, "name": "hero"}')!))
      .toBe('dict[str, Union[int, str]]');
    expect(pythonLiteralAnnotation(parsePythonLiteral('{}')!)).toBe('dict');
    expect(pythonLiteralAnnotation(parsePythonLiteral('{1, 2}')!)).toBe('set[int]');
    expect(pythonLiteralAnnotation(parsePythonLiteral('[[1], [2, 3]]')!)).toBe('list[list[int]]');
  });

  it('分组括号不产 tuple,字典/集合按冒号区分', () => {
    expect(pythonLiteralAnnotation(parsePythonLiteral('(1)')!)).toBe('int');
    expect(pythonLiteralAnnotation(parsePythonLiteral('{"a": {"b": 1}}')!))
      .toBe('dict[str, dict[str, int]]');
  });

  it('解析失败/未知名字回落 null(调用方回落基类)', () => {
    expect(parsePythonLiteral('')).toBeNull();
    expect(parsePythonLiteral('SOME_CONST')).toBeNull();
    expect(parsePythonLiteral('[1,')).toBeNull();
    expect(parsePythonLiteral('foo()')).toBeNull();
    expect(parsePythonLiteral('{')).toBeNull();
  });

  it('inferPythonLiteralAnnotation 对 PYTHON 族精确化,非族/无 Default/失败回落基类', () => {
    // PYTHON 族带 Default 精化
    expect(inferPythonLiteralAnnotation('123', 'PYTHON')).toBe('int');
    expect(inferPythonLiteralAnnotation('{"hp": 1}', 'PY_DICT')).toBe('dict[str, int]');
    expect(inferPythonLiteralAnnotation('[1, 2]', 'PY_LIST')).toBe('list[int]');
    expect(inferPythonLiteralAnnotation("(1, 'a')", 'PY_TUPLE')).toBe('tuple[int, str]');
    // 无 Default / 空 / 解析失败 / None → 基类
    expect(inferPythonLiteralAnnotation(undefined, 'PYTHON')).toBe('Any');
    expect(inferPythonLiteralAnnotation('', 'PY_DICT')).toBe('dict');
    expect(inferPythonLiteralAnnotation('SOME_CONST', 'PY_LIST')).toBe('list');
    expect(inferPythonLiteralAnnotation('None', 'PYTHON')).toBe('Any');
    expect(inferPythonLiteralAnnotation('None', 'PY_DICT')).toBe('dict');
    // 容器基类不匹配字面量形态 → 基类
    expect(inferPythonLiteralAnnotation('[1]', 'PY_DICT')).toBe('dict');
    expect(inferPythonLiteralAnnotation('{"a": 1}', 'PY_LIST')).toBe('list');
    // 非 PYTHON 族不经字面量(直接返回类型名)
    expect(inferPythonLiteralAnnotation('123', 'UINT32')).toBe('UINT32');
  });
});
