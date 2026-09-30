import { describe, expect, it } from 'vitest';
import {
  getPythonSelfAccessAtPosition,
  getPythonSelfCompletionContext,
  getPythonSelfSymbolAtPosition
} from '../src/pythonLanguageUtils';

describe('getPythonSelfAccessAtPosition', () => {
  const line = '    self.avatar.position.x += 1';

  it('identifies the segment under the cursor', () => {
    // 'self.' 长度 5,avatar 从列 5 开始
    expect(getPythonSelfAccessAtPosition(line, line.indexOf('avatar') + 2)).toEqual({
      rootSymbol: 'avatar',
      currentSymbol: 'avatar',
      fullPath: 'avatar.position.x'
    });
    expect(getPythonSelfAccessAtPosition(line, line.indexOf('position') + 3)).toEqual({
      rootSymbol: 'avatar',
      currentSymbol: 'position',
      fullPath: 'avatar.position.x'
    });
  });

  it('covers the character right after a segment', () => {
    const endOfAvatar = line.indexOf('avatar') + 'avatar'.length;
    expect(getPythonSelfAccessAtPosition(line, endOfAvatar)?.currentSymbol).toBe('avatar');
  });

  it('returns null outside self accesses', () => {
    expect(getPythonSelfAccessAtPosition('x = self', 0)).toBeNull();
    expect(getPythonSelfAccessAtPosition('other.value', 3)).toBeNull();
  });

  it('anchors the path after the self. prefix when the name repeats inside self', () => {
    // 批87 缺陷收口(批86 M7 反向发现):原码 fullMatch.indexOf(accessPath) 会把
    // 'self' 内部的同形子串当路径起点——'self.e' 命中相对 1,光标停在属性 e
    // (相对 5)漏真命中返回 null,停在 self 中段反而吐出越界根名 'e'。fullMatch
    // 恒为 'self.'+accessPath,后缀算术修复后两侧均按真实列命中。
    expect(getPythonSelfAccessAtPosition('self.e', 5)).toEqual({
      rootSymbol: 'e',
      currentSymbol: 'e',
      fullPath: 'e'
    });
    expect(getPythonSelfAccessAtPosition('self.e', 1)).toBeNull();
    expect(getPythonSelfAccessAtPosition('self.self', 6)).toEqual({
      rootSymbol: 'self',
      currentSymbol: 'self',
      fullPath: 'self'
    });
    expect(getPythonSelfAccessAtPosition('self.self', 1)).toBeNull();

    // 对照:名字与 'self' 无同形交集时原码本就正确,修复不改其行为
    expect(getPythonSelfAccessAtPosition('self.ab', 5)).toEqual({
      rootSymbol: 'ab',
      currentSymbol: 'ab',
      fullPath: 'ab'
    });
    expect(getPythonSelfAccessAtPosition('self.ab', 1)).toBeNull();
  });
});

describe('getPythonSelfSymbolAtPosition', () => {
  it('returns the first segment after self', () => {
    const line = 'self.cellData.hp';
    expect(getPythonSelfSymbolAtPosition(line, line.indexOf('cellData') + 1)).toBe('cellData');
    expect(getPythonSelfSymbolAtPosition('print(1)', 2)).toBeNull();
  });
});

describe('getPythonSelfCompletionContext', () => {
  it('handles a trailing dot as member-list request', () => {
    expect(getPythonSelfCompletionContext('self.')).toEqual({
      rootSymbol: null,
      parentPath: '',
      fullPath: '',
      partialSymbol: ''
    });
    expect(getPythonSelfCompletionContext('self.cellData.')).toEqual({
      rootSymbol: 'cellData',
      parentPath: 'cellData',
      fullPath: 'cellData',
      partialSymbol: ''
    });
  });

  it('handles a partial member being typed', () => {
    expect(getPythonSelfCompletionContext('self.cellData.hp_')).toEqual({
      rootSymbol: 'cellData',
      parentPath: 'cellData',
      fullPath: 'cellData.hp_',
      partialSymbol: 'hp_'
    });
    expect(getPythonSelfCompletionContext('self.sp')).toEqual({
      rootSymbol: 'sp',
      parentPath: '',
      fullPath: 'sp',
      partialSymbol: 'sp'
    });
  });

  it('returns null when no self access is being completed', () => {
    expect(getPythonSelfCompletionContext('foo = 1')).toBeNull();
    expect(getPythonSelfCompletionContext('self == other')).toBeNull();
  });

  it('keeps the empty access shape for consecutive dots and rejects trailing junk', () => {
    // 'self..':组1 未匹配,命中串整体以 '.' 结尾,仍走 endsWithDot 早退形状
    expect(getPythonSelfCompletionContext('self..')).toEqual({
      rootSymbol: null,
      parentPath: '',
      fullPath: '',
      partialSymbol: ''
    });
    // 'self.a..':尾随多余点令 $ 锚定失败,整体归 null
    expect(getPythonSelfCompletionContext('self.a..')).toBeNull();
  });
});
