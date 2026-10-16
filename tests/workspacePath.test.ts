import { afterAll, describe, expect, it } from 'vitest';
import {
  expandWorkspacePlaceholders,
  joinWorkspacePath,
  usesPosixPath
} from '../src/workspacePath';

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

describe('expandWorkspacePlaceholders(批112:binPath/元件配置路径共用)', () => {
  const originalEnv = { ...process.env };

  afterAll(() => {
    process.env = originalEnv;
  });

  it('${workspaceFolder} 全量展开,未设工作区落空串', () => {
    expect(expandWorkspacePlaceholders('${workspaceFolder}/kbe/bin/server', '/proj')).toBe(
      '/proj/kbe/bin/server'
    );
    expect(expandWorkspacePlaceholders('${workspaceFolder}/a${workspaceFolder}b', '/proj')).toBe(
      '/proj/a/projb'
    );
    expect(expandWorkspacePlaceholders('${workspaceFolder}/x', undefined)).toBe('/x');
  });

  it('${env:VAR} 展开缺失变量落空串', () => {
    process.env.KODE_TEST_VAR = 'val';
    // 相对结果锚定仓库根(用户令 2026-10-16:相对路径一律以仓库根为基准,
    // 不许假设 cwd)——'val/kbe' 不再原样返回,而是相对 '/proj' 解析
    expect(expandWorkspacePlaceholders('${env:KODE_TEST_VAR}/kbe', '/proj')).toBe('/proj/val/kbe');
    expect(expandWorkspacePlaceholders('${env:KODE_TEST_MISSING}/kbe', '/proj')).toBe('/kbe');
  });

  it('相对结果以仓库根为基准,无根可锚时返回空串(不落 cwd)', () => {
    expect(expandWorkspacePlaceholders('assets/kbengine.xml', '/proj')).toBe(
      '/proj/assets/kbengine.xml'
    );
    expect(expandWorkspacePlaceholders('/abs/x', '/proj')).toBe('/abs/x');
    expect(expandWorkspacePlaceholders('', '/proj')).toBe('');
    expect(expandWorkspacePlaceholders('assets/x', undefined)).toBe('');
  });
});
