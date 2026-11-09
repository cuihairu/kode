import { describe, expect, it } from 'vitest';
import {
  formatUnresolvedException,
  parseExceptionSourceLocation,
  resolveExceptionSource
} from '../src/backend/exceptionSourceLocator';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

describe('exceptionSourceLocator (IDE-LIV-007)', () => {
  it('parses python traceback file+line', () => {
    const raw = '  File "scripts/base/Avatar.py", line 42, in onTimer\nAttributeError: no attr';
    expect(parseExceptionSourceLocation(raw)).toEqual({
      file: 'scripts/base/Avatar.py',
      line: 42,
      qualifier: 'traceback'
    });
  });

  it('parses engine-log path:line style', () => {
    expect(parseExceptionSourceLocation('[ERROR] baseapp:Bots load scripts/cell/Monster.py:128 - boom')).toEqual({
      file: 'scripts/cell/Monster.py',
      line: 128,
      qualifier: 'logpath'
    });
    // 解析不了的行如实 null,不猜
    expect(parseExceptionSourceLocation('Segmentation fault at 0x0')).toBeNull();
    expect(parseExceptionSourceLocation('')).toBeNull();
  });

  it('resolves relative engine paths against workspace roots that really exist', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-liv007-'));
    try {
      fs.mkdirSync(path.join(root, 'scripts/base'), { recursive: true });
      fs.writeFileSync(path.join(root, 'scripts/base/Avatar.py'), '# avatar');
      const resolved = resolveExceptionSource(
        [root],
        parseExceptionSourceLocation('File "scripts/base/Avatar.py", line 42, in onTimer')!
      );
      expect(resolved?.absolutePath).toBe(path.join(root, 'scripts/base/Avatar.py'));

      // 引擎日志带 assets 前缀而工作区直接开 assets 子目录:走 basename+scripts/<段> 候选
      const baseRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-liv007-b-'));
      try {
        fs.mkdirSync(path.join(baseRoot, 'scripts/cell'), { recursive: true });
        fs.writeFileSync(path.join(baseRoot, 'scripts/cell/Monster.py'), '');
        const resolved2 = resolveExceptionSource(
          [baseRoot],
          parseExceptionSourceLocation('assets/kbengine_demos_assets/scripts/cell/Monster.py:128')!
        );
        expect(resolved2?.absolutePath).toBe(path.join(baseRoot, 'scripts/cell/Monster.py'));
      } finally {
        fs.rmSync(baseRoot, { recursive: true, force: true });
      }
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('returns null when no workspace file matches, keeping raw info intact', () => {
    const resolved = resolveExceptionSource(
      ['/nonexistent-root'],
      parseExceptionSourceLocation('File "scripts/base/Ghost.py", line 7, in gone')!
    );
    expect(resolved).toBeNull();
    const location = parseExceptionSourceLocation('File "scripts/base/Ghost.py", line 7, in gone');
    expect(formatUnresolvedException('File "scripts/base/Ghost.py", line 7, in gone', location)).toBe(
      '异常文件行 scripts/base/Ghost.py:7 在当前工作区未找到源码,原始信息:File "scripts/base/Ghost.py", line 7, in gone'
    );
    expect(formatUnresolvedException('pure crash', null)).toBe('异常无可解析文件行,原始信息:pure crash');
  });

  it('respects injected exists probe instead of real disk', () => {
    const resolved = resolveExceptionSource(
      ['/root'],
      parseExceptionSourceLocation('scripts/base/Avatar.py:42')!,
      candidate => candidate === path.join('/root', 'scripts/base/Avatar.py')
    );
    expect(resolved?.absolutePath).toBe(path.join('/root', 'scripts/base/Avatar.py'));
  });
});
