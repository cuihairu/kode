import { describe, expect, it } from 'vitest';
import { joinWorkspacePath, usesPosixPath } from '../src/workspacePath';

describe('joinWorkspacePath', () => {
  it('joins posix-style workspace paths with normalized segments', () => {
    expect(joinWorkspacePath('/home/user/project', 'scripts', 'entity_defs')).toBe(
      '/home/user/project/scripts/entity_defs'
    );
  });

  it('converts windows separators inside segments on posix workspaces', () => {
    expect(joinWorkspacePath('/home/user/project', 'scripts\\entity_defs')).toBe(
      '/home/user/project/scripts/entity_defs'
    );
  });

  it('uses win32 joining for drive-letter workspaces', () => {
    expect(joinWorkspacePath('C:\\work\\kbengine', 'assets', 'scripts')).toBe(
      'C:\\work\\kbengine\\assets\\scripts'
    );
    // path.win32.join 会把段内的 posix 分隔符一并归一为反斜杠
    expect(joinWorkspacePath('C:\\work\\kbengine', 'assets/scripts')).toBe(
      'C:\\work\\kbengine\\assets\\scripts'
    );
  });
});

describe('usesPosixPath', () => {
  it('detects posix and windows layouts', () => {
    expect(usesPosixPath('/home/user/project')).toBe(true);
    expect(usesPosixPath('relative/path')).toBe(true);
    expect(usesPosixPath('C:\\work')).toBe(false);
    expect(usesPosixPath('C:/work')).toBe(false);
    expect(usesPosixPath('plainname')).toBe(false);
  });
});
