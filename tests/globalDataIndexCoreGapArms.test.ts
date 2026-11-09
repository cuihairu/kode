import { describe, expect, it } from 'vitest';
import {
  diffFunctionDefs,
  extractFunctionReturns,
  findKbeDataDictAccesses,
  findKbeDataDictAccessesSliced,
  getDataDictAccessInCodeContext,
  normalizeKeySignature,
  resolveFunctionReturns
} from '../src/globalDataIndexCore';

// globalDataIndexCore 缺口臂(2026-11-09 覆盖率扫尾)。
//
// 已覆盖臂:
// - decodeEscape/matchStringLiteral:八进制越界 \777(131)、\u 非法(143-145)/
//   合法(147)、\U 非法(150-152)/合法(154)、原始串尾反斜杠(181)。
// - findKbeDataDictAccessesSliced 空别名集早退(738)。
// - getDataDictAccessInCodeContext:行号越界(833)、同行双字典命中后段(801,
//   findAliasDictSpanForAccess 首段 dict 不匹配 continue)。
// - matchCallForm 括号未闭合(898)、extractFunctionReturns 嵌套 def 体内空行
//   (970-971)、resolveFunctionReturns 空/None(1021)/裸标识符(1028)/f-string
//   (1032)、diffFunctionDefs 变化(1099)。
//
// 死臂(证据):
// - 105(decodeEscape 的 `next === undefined` 早退):唯一调用方 matchStringLiteral
//   在循环前先验 `text[text.length-1] === quote`(172),循环上界
//   `index < text.length - 1`(176),故反斜杠下标 ≤ length-2,text[index+1]
//   恒为闭引号,不会是 undefined;f-string 路径不经 decodeEscape。
// - 816/842(findAliasDictSpanForAccess 尾部 null 与 getDataDictAccessInCodeContext
//   的 `!aliasSpan` 早退):access 恒由 getKbeDataDictAccessAtPosition 对同一
//   rawLine 扫描产生,findAliasDictSpanForAccess 用同一 DATA_DICT_PATTERN(双方
//   入口都重置 lastIndex)+ 同一 parseSubscriptAccess/parseGetAccess 对同一
//   字符串重扫,匹配对(字典下标+keyStart)必然复现 → aliasSpan 恒非 null。
//   这两个守卫只防御跨文本/跨扫描的不一致,当前唯一公共入口
//   getDataDictAccessInCodeContext 不产生这种不一致,无运行时路径可达。

describe('globalDataIndexCore 缺口臂:转义序列解码', () => {
  it('八进制越界 \\777 → null(131)', () => {
    // 构造 `'\777'` 字面量(避免 JS 严格模式八进制转义语法错误)
    expect(normalizeKeySignature("'" + '\\' + '777' + "'")).toBeNull();
  });

  it('\\u 非法十六进制 → null(143-145);合法 → 解引(147)', () => {
    expect(normalizeKeySignature("'\\u00ZZ'")).toBeNull();
    expect(normalizeKeySignature("'\\u0041'")).toBe('A');
  });

  it('\\U 非法/短十六进制 → null(150-152);合法 8 位 → 码点(154)', () => {
    expect(normalizeKeySignature("'\\U0041'")).toBeNull(); // 只给 4 位
    expect(normalizeKeySignature("'\\U00ZZZZZZ'")).toBeNull();
    expect(normalizeKeySignature("'\\U0001F600'")).toBe('😀');
  });

  it('原始串(r 前缀)尾反斜杠 → null(181)', () => {
    expect(normalizeKeySignature("r'a\\'")).toBeNull();
  });
});

describe('globalDataIndexCore 缺口臂:切片扫描与代码上下文', () => {
  it('findKbeDataDictAccessesSliced 空别名集 → 零片早退(738)', async () => {
    const result = await findKbeDataDictAccessesSliced(
      'KBEngine.globalData["k"] = 1\n',
      new Set<string>(),
      () => false
    );
    expect(result).toEqual({ accesses: [], sliceCount: 0, maxSliceMs: 0 });
  });

  it('行号越界 → getDataDictAccessInCodeContext 早退 null(833)', () => {
    const text = 'KBEngine.globalData["a"] = 1\n';
    expect(getDataDictAccessInCodeContext(text, 5, 0, new Set(['KBEngine']))).toBeNull();
  });

  it('同一行两个不同字典访问:命中后段 → 前段 dict 不匹配 continue(801)', () => {
    const line = 'KBEngine.globalData["a"] = 1; kbe.baseAppData["b"] = 2';
    const aliases = new Set(['KBEngine', 'kbe']);
    const char = line.indexOf('"b"') + 1; // 落在后段键 b 内
    const access = getDataDictAccessInCodeContext(line, 0, char, aliases);
    expect(access).not.toBeNull();
    expect(access?.dict).toBe('baseAppData');
    expect(access?.keySignature).toBe('b');
    // 前段(globalData)仍可命中
    const front = getDataDictAccessInCodeContext(line, 0, line.indexOf('"a"') + 1, aliases);
    expect(front?.dict).toBe('globalData');
  });

  it('调用键带尾随残余 → matchCallForm 早退 null(898),不索引', () => {
    // 键 `Fn(a)junk`:下标闭合、非字面量/拼接,callForm 尾部有残余 → 898 null
    const accesses = findKbeDataDictAccesses(
      'KBEngine.globalData[Fn(a)junk] = 1',
      new Set(['KBEngine'])
    );
    expect(accesses).toEqual([]);
  });
});

describe('globalDataIndexCore 缺口臂:函数返回提取与解析', () => {
  it('嵌套 def 体内空行 → 嵌套跳过循环空行 continue(970-971),外层 return 不误归属', () => {
    const text = [
      'def outer():',
      '    def inner():',
      '        return 1',
      '',
      '    return 2'
    ].join('\n');
    const result = extractFunctionReturns(text);
    // 嵌套 def 整段跳过(其 return 不入外层函数),跳过途中空行由 969-971 走过
    expect(result.get('inner')).toBeUndefined();
    // 外层 return 2(indent == defIndent,结束嵌套跳过)仍归属 outer
    expect(result.get('outer')).toEqual(['2']);
  });

  it('return 为 None/空串 → 签名 null(1021)', () => {
    const defs = new Map<string, Map<string, string[]>>([
      ['a.py', new Map([['f', ['None']]])]
    ]);
    expect(resolveFunctionReturns('f', defs)).toBeNull();
    const empty = new Map<string, Map<string, string[]>>([
      ['a.py', new Map([['f', ['']]])]
    ]);
    expect(resolveFunctionReturns('f', empty)).toBeNull();
  });

  it('return 为裸标识符 → 原文签名(1028)', () => {
    const defs = new Map<string, Map<string, string[]>>([
      ['a.py', new Map([['f', ['KEY_NAME']]])]
    ]);
    expect(resolveFunctionReturns('f', defs)).toEqual(['KEY_NAME']);
  });

  it('return 为 f-string → 字面量骨架(1032)', () => {
    const defs = new Map<string, Map<string, string[]>>([
      ['a.py', new Map([['f', ['f"SERVER_{x}"']]])]
    ]);
    expect(resolveFunctionReturns('f', defs)).toEqual(['SERVER_*']);
  });

  it('diffFunctionDefs:return 列表变化 → 报告变化函数(1099)', () => {
    expect(
      diffFunctionDefs(
        new Map([['f', ['a']], ['same', ['x']]]),
        new Map([['f', ['a', 'b']], ['same', ['x']]])
      )
    ).toEqual(['f']);
  });
});
