// SemanticTokens 决策核单元钉(RUST-144 批 3,新面):结构符号 5 类提取
// 与 LSP 相对编码。防 golden 自洽同义反复——断言值显式推自语义。
import { describe, expect, it } from 'vitest';
import {
  buildSemanticTokenSpans,
  encodeSemanticTokens,
  SEMANTIC_TOKEN_MODIFIERS,
  SEMANTIC_TOKEN_TYPES
} from '../src/backend/semanticTokens';

describe('semantic tokens decision core (RUST-144 batch 3)', () => {
  it('class/method/function/parameter/macro 全类提取与 async 修饰', () => {
    const text = [
      'import base',
      '',
      '@classmethod',
      'class Avatar(Base):',
      '    async def shoot(self, target, times=1):',
      '        pass',
      '',
      '    def plain(self):',
      '        pass',
      '',
      'def helper(a, b):',
      '    pass',
      ''
    ].join('\n');
    const spans = buildSemanticTokenSpans(text);
    const kind = (line: number) => spans.filter(span => span.line === line).map(span => span.type);
    // 行 0 import 无符号
    expect(kind(0)).toEqual([]);
    // 行 2 装饰器 macro
    expect(kind(2)).toEqual(['macro']);
    // 行 3 class + 无形参(class 行无 def)
    expect(kind(3)).toEqual(['class']);
    // 行 4 async def:method+2 形参
    expect(kind(4)).toEqual(['method', 'parameter', 'parameter']);
    // 行 7 普通方法(无形参,self 不算)
    expect(kind(7)).toEqual(['method']);
    // 行 10 模块级 function+2 形参
    expect(kind(10)).toEqual(['function', 'parameter', 'parameter']);
    const shoot = spans.find(span => span.type === 'method' && span.line === 4);
    expect(shoot?.modifiers).toEqual(['declaration', 'async']);
    const avatar = spans.find(span => span.type === 'class');
    expect(avatar).toEqual({
      line: 3,
      startCharacter: 6,
      length: 6,
      type: 'class',
      modifiers: ['declaration']
    });
  });

  it('字符串与注释内伪声明不触发;跨行 def 形参落各自所在行', () => {
    const text = [
      'x = "def fake(self, a):"',
      '# class Ghost:',
      'class Real:',
      '    def cross(self, a,',
      '              b):',
      '        pass'
    ].join('\n');
    const spans = buildSemanticTokenSpans(text);
    expect(spans.some(span => span.type === 'class')).toBe(true);
    expect(spans.map(span => span.type)).not.toContain('function');
    // 跨行 def(KODE-SYN-004):方法名出(单行),形参出且落各自所在行
    const method = spans.find(span => span.type === 'method');
    expect(method).toBeDefined();
    expect(spans.filter(span => span.type === 'parameter')).toEqual([
      { line: 3, startCharacter: 20, length: 1, type: 'parameter', modifiers: ['declaration'] },
      { line: 4, startCharacter: 14, length: 1, type: 'parameter', modifiers: ['declaration'] }
    ]);
  });

  it('encodeSemanticTokens LSP 相对编码与类型索引', () => {
    expect(SEMANTIC_TOKEN_TYPES).toEqual(['class', 'function', 'method', 'parameter', 'macro']);
    expect(SEMANTIC_TOKEN_MODIFIERS).toEqual(['declaration', 'async']);
    const spans = [
      { line: 3, startCharacter: 6, length: 6, type: 'class' as const, modifiers: ['declaration'] },
      { line: 4, startCharacter: 13, length: 5, type: 'method' as const, modifiers: ['declaration', 'async'] },
      { line: 4, startCharacter: 20, length: 6, type: 'parameter' as const, modifiers: ['declaration'] }
    ];
    // 行 3→4 deltaLine=1(deltaStart 绝对),行 4 内 deltaStart=20-13
    expect(encodeSemanticTokens(spans)).toEqual([
      3, 6, 6, 0, 1, // class: type 0, declaration bit0
      1, 13, 5, 2, 3, // method: type 2, declaration|async = 1|2 = 3
      0, 7, 6, 3, 1 // parameter: 同行 deltaStart=7, type 3
    ]);
    // 同行首 token deltaStart 为绝对列
    const sameLine = [
      { line: 0, startCharacter: 2, length: 3, type: 'class' as const, modifiers: [] },
      { line: 0, startCharacter: 9, length: 3, type: 'macro' as const, modifiers: [] }
    ];
    expect(encodeSemanticTokens(sameLine)).toEqual([0, 2, 3, 0, 0, 0, 7, 3, 4, 0]);
    // 未知类型早爆
    expect(() =>
      encodeSemanticTokens([
        { line: 0, startCharacter: 0, length: 1, type: 'variable' as never, modifiers: [] }
      ])
    ).toThrow();
  });
});
