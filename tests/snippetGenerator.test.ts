import { describe, expect, it } from 'vitest';
import {
  CUSTOM_SNIPPETS_RELATIVE_PATH,
  escapeSnippetText,
  leadingWhitespaceColumns,
  mergeSnippetEntry,
  selectionToSnippetBody,
  stripCommonIndent
} from '../src/snippetGenerator';

// 批94「代码片段生成器(自定义代码片段)」纯逻辑层:片段语法转义、
// 选区归一为片段体、片段文件 JSON 合并(含覆盖判定与坏 JSON 拒绝)。
// 命令装配层由 tests/snippetGeneratorCommand.test.ts 覆盖。
// 批121:去公共缩进从字符数改为 tabSize 列语义(审计块18 遗留①收口)。

describe('escapeSnippetText', () => {
  it('转义片段语法保留字 \\ 与 $,其余原样', () => {
    expect(escapeSnippetText('')).toBe('');
    expect(escapeSnippetText('plain text')).toBe('plain text');
    expect(escapeSnippetText('a$b')).toBe('a\\$b');
    expect(escapeSnippetText('a\\b')).toBe('a\\\\b');
    expect(escapeSnippetText('C:\\path $name')).toBe('C:\\\\path \\$name');
  });
});

describe('selectionToSnippetBody', () => {
  it('空与纯空白选区产出空片段体', () => {
    expect(selectionToSnippetBody('')).toEqual([]);
    expect(selectionToSnippetBody('   \n  \n\t\n')).toEqual([]);
  });

  it('统一换行并去首尾空行', () => {
    expect(selectionToSnippetBody('a\r\nb\r\n')).toEqual(['a', 'b']);
    expect(selectionToSnippetBody('\n\n  a  \n\n')).toEqual(['a  ']);
    expect(selectionToSnippetBody('a\n\n\nb')).toEqual(['a', '', '', 'b']);
  });

  it('按非空行最少缩进去公共缩进', () => {
    expect(selectionToSnippetBody('    <hp>\n      <Type>UINT32</Type>\n    </hp>\n'))
      .toEqual(['<hp>', '  <Type>UINT32</Type>', '</hp>']);
    expect(selectionToSnippetBody('\tfoo')).toEqual(['foo']);
    // 纯空白行不参与缩进统计,且短于公共缩进时安全收敛为空串
    expect(selectionToSnippetBody('    a\n  \n    b')).toEqual(['a', '', 'b']);
  });

  it('逐行做片段语法转义', () => {
    expect(selectionToSnippetBody('$root\n\\literal')).toEqual(['\\$root', '\\\\literal']);
  });

  // 审计块18 遗留①收口:原口径按 /^[ \t]*/ 字符数算公共缩进,
  // tab/空格混用时层级错位;按 tabSize 列语义后纯 tab/纯空格选区
  // 结果不变,混合选区保得住相对层级(红测试先行:老口径下三例全红)。
  it('混合 tab/空格按 tabSize 列语义去公共缩进', () => {
    // 4 空格=列 4、tab=列 4、2 空格=列 2 → 公共列 2;
    // foo/bar 相对 baz 各深 2 列。老口径取公共 1 字符 → ['   foo','bar',' baz'] 错位。
    expect(selectionToSnippetBody('    foo\n\tbar\n  baz', 4))
      .toEqual(['  foo', 'bar', 'baz']);
  });

  it('tab 跨过公共列时整枚剥除,相对层级只会偏浅不会偏深', () => {
    // tabSize 4:行1 tab=列 4,行2 2 空格=列 2 → 公共列 2;
    // 行1 的 tab 整枚剥除(跨过列 2),残层 0——tab 原子性下无法再细拆,
    // 但绝不能反向把行2 排到更深(老口径 ['foo',' bar'] 正好颠倒层级)。
    expect(selectionToSnippetBody('\tfoo\n  bar', 4)).toEqual(['foo', 'bar']);
  });

  it('tab 恰好落到公共列时精确停止,余文保留原字符', () => {
    // tabSize 4:行1 tab+2 空格=列 6,行2 tab=列 4 → 公共列 4;
    // 行1 的 tab 剥除后列恰好为 4,2 空格保留为相对层级
    expect(selectionToSnippetBody('\t  deep\n\tshallow', 4))
      .toEqual(['  deep', 'shallow']);
  });

  it('tabSize=2 的列语义与非默认 tabSize 生效', () => {
    // tabSize 2:行1 2 空格+tab=列 4,行2 tab=列 2 → 公共列 2;
    // 行1 剥 2 空格后停在列 2,tab 原样保留(若按 tabSize 4 会整枚剥除)
    expect(selectionToSnippetBody('  \tdeep\n\tbar', 2)).toEqual(['\tdeep', 'bar']);
  });
});

describe('leadingWhitespaceColumns', () => {
  it('空格 1 列,tab 前进到下一 tabSize 倍数,非空白开头为 0', () => {
    expect(leadingWhitespaceColumns('', 4)).toBe(0);
    expect(leadingWhitespaceColumns('x', 4)).toBe(0);
    expect(leadingWhitespaceColumns('  \tx', 4)).toBe(4);
    expect(leadingWhitespaceColumns('\t\tx', 4)).toBe(8);
    expect(leadingWhitespaceColumns('\tx', 2)).toBe(2);
    expect(leadingWhitespaceColumns('   ', 4)).toBe(3);
  });
});

describe('stripCommonIndent', () => {
  it('剥到公共列为止,余文保留原字符,短空白行安全收敛空串', () => {
    expect(stripCommonIndent('  \tfoo', 2, 4)).toBe('\tfoo');
    expect(stripCommonIndent('    foo', 2, 4)).toBe('  foo');
    expect(stripCommonIndent('\tfoo', 2, 4)).toBe('foo');
    expect(stripCommonIndent('x', 2, 4)).toBe('x');
    expect(stripCommonIndent('   ', 10, 4)).toBe('');
  });
});

describe('mergeSnippetEntry', () => {
  const entry = {
    prefix: 'kbe-a',
    body: ['<a>', '</a>'],
    description: '示例片段',
    scope: 'kbengine-def'
  };

  it('常量锁定:自定义片段文件路径', () => {
    expect(CUSTOM_SNIPPETS_RELATIVE_PATH).toBe('.vscode/kbengine-custom.code-snippets');
  });

  it('空内容新建单条目,追加尾部换行', () => {
    const result = mergeSnippetEntry(null, 'A', entry);

    expect(result.overwritten).toBe(false);
    expect(result.content.endsWith('\n')).toBe(true);
    expect(JSON.parse(result.content)).toEqual({
      A: { scope: 'kbengine-def', prefix: 'kbe-a', body: ['<a>', '</a>'], description: '示例片段' }
    });
    expect(mergeSnippetEntry('', 'A', entry)).toEqual(result);
  });

  it('合并保留既有条目且不改写', () => {
    const existing = JSON.stringify({ Old: { prefix: 'old', body: ['old'] } });
    const result = mergeSnippetEntry(existing, 'New', entry);

    expect(result.overwritten).toBe(false);
    const parsed = JSON.parse(result.content) as Record<string, { prefix: string }>;
    expect(Object.keys(parsed).sort()).toEqual(['New', 'Old']);
    expect(parsed.Old.prefix).toBe('old');
  });

  it('同名条目判定为覆盖', () => {
    const existing = JSON.stringify({
      A: { scope: 'kbengine-def', prefix: 'stale', body: ['stale'], description: '旧' }
    });
    const result = mergeSnippetEntry(existing, 'A', entry);

    expect(result.overwritten).toBe(true);
    expect((JSON.parse(result.content) as { A: { prefix: string } }).A.prefix).toBe('kbe-a');
  });

  it('空描述不写 description 字段', () => {
    const result = mergeSnippetEntry(null, 'A', { ...entry, description: '' });
    expect(JSON.parse(result.content)).toEqual({
      A: { scope: 'kbengine-def', prefix: 'kbe-a', body: ['<a>', '</a>'] }
    });
  });

  it('顶层非对象或坏 JSON 抛错交命令层提示', () => {
    expect(() => mergeSnippetEntry('[1,2]', 'A', entry)).toThrow('顶层必须是对象');
    expect(() => mergeSnippetEntry('42', 'A', entry)).toThrow('顶层必须是对象');
    expect(() => mergeSnippetEntry('{ // 手改注释', 'A', entry)).toThrow();
  });

  // 官方片段装载 vs/base/common/json.ts 的 setObjectProperty 对 __proto__ 键
  // 改用 defineProperty 保留自身属性;普通赋值会命中 Object.prototype 的
  // __proto__ 访问器把新条目吞掉(输出无该片段却报已生成),此处锁死修正。
  it('片段名 __proto__ 按自身属性写入,不被原型访问器吞掉', () => {
    const result = mergeSnippetEntry(null, '__proto__', entry);

    expect(result.overwritten).toBe(false);
    expect(result.content).toContain('"__proto__"');
    const parsed = JSON.parse(result.content) as Record<string, unknown>;
    expect(Object.keys(parsed)).toEqual(['__proto__']);
    expect(parsed['__proto__']).toEqual({
      scope: 'kbengine-def',
      prefix: 'kbe-a',
      body: ['<a>', '</a>'],
      description: '示例片段'
    });
  });

  it('既有 __proto__ 条目再生成判定为覆盖且前缀更新', () => {
    const existing = '{"__proto__": {"prefix": "stale", "body": ["stale"]}, "Kept": {"prefix": "kept", "body": ["x"]}}';
    const result = mergeSnippetEntry(existing, '__proto__', { ...entry, prefix: 'kbe-b' });

    expect(result.overwritten).toBe(true);
    const parsed = JSON.parse(result.content) as Record<string, { prefix: string }>;
    expect(Object.keys(parsed).sort()).toEqual(['Kept', '__proto__']);
    expect(parsed['__proto__'].prefix).toBe('kbe-b');
    expect(parsed.Kept.prefix).toBe('kept');
  });
});
