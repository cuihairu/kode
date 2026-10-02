import { describe, expect, it } from 'vitest';
import {
  CUSTOM_SNIPPETS_RELATIVE_PATH,
  escapeSnippetText,
  mergeSnippetEntry,
  selectionToSnippetBody
} from '../src/snippetGenerator';

// 批94「代码片段生成器(自定义代码片段)」纯逻辑层:片段语法转义、
// 选区归一为片段体、片段文件 JSON 合并(含覆盖判定与坏 JSON 拒绝)。
// 命令装配层由 tests/snippetGeneratorCommand.test.ts 覆盖。

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
});
