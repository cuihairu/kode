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
});
