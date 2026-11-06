import { describe, expect, it } from 'vitest';
import { normalizeFileIdentity } from '../src/pathIdentity';
import { planPythonExtraPaths } from '../src/pythonExtraPaths';

// KR-AUD-37(IDX-注,三子项取证落地):
// ① pathIdentity 不折叠 `..`——身份键对同一目录的不同拼法(`scripts/../entity_defs`
//    与 `entity_defs`)产生不同键,误判为不同文件。修复:词法折叠 `..`(可弹出则
//    弹,超根保留,POSIX 语义)。
// ② pythonExtraPaths 差量比较大小写敏感——Windows 语境(盘符根)下,用户改了
//    托管条目的大小写会被判成用户段保留,同时写入规范托管条目 → 同目录重复共存。
//    修复:盘符语境下差量比较大小写不敏感(var 形态后缀同口径)。
// ③ workspaceIndex.noteSaved 每键两遍正则——原稿自述「既有取舍」,取证确认属实
//    (onDidChangeTextDocument 全文 findEventCalls+def 正则),不修,账面保留。

describe('KR-AUD-37① normalizeFileIdentity 折叠 ..', () => {
  it('中间 .. 段折叠后与直接拼法同键(POSIX)', () => {
    expect(normalizeFileIdentity('/w/scripts/../entity_defs/Avatar.py')).toBe(
      normalizeFileIdentity('/w/entity_defs/Avatar.py')
    );
  });

  it('Windows 盘符路径折叠后进大小写归一', () => {
    expect(normalizeFileIdentity('C:\\w\\scripts\\..\\entity_defs\\Avatar.py')).toBe(
      normalizeFileIdentity('c:/w/entity_defs/Avatar.py')
    );
  });

  it('超根 .. 与前置 ..:绝对根上弃、相对前置保留(POSIX 语义)', () => {
    expect(normalizeFileIdentity('/../x/y.py')).toBe('/x/y.py');
    expect(normalizeFileIdentity('../x/y.py')).toBe('../x/y.py');
    expect(normalizeFileIdentity('/a/../../b.py')).toBe('/b.py');
    expect(normalizeFileIdentity('C:/a/../../b.py')).toBe('c:/b.py');
  });
});

describe('KR-AUD-37② extraPaths 差量比较盘符语境大小写不敏感', () => {
  it('用户改写托管条目大小写不产生重复共存(盘符语境)', () => {
    const plan = planPythonExtraPaths({
      workspaceRoot: 'C:\\proj',
      currentPaths: ['${workspaceFolder}/Scripts', 'C:/proj/assets/scripts'],
      previouslyManaged: ['${workspaceFolder}/scripts', '${workspaceFolder}/assets/scripts'],
      deps: { exists: () => true, listSubdirs: () => [] }
    });
    // '${workspaceFolder}/Scripts' 应被识别为托管条目的大小写变体(不进用户段),
    // 规范托管条目照常写入;结果里同一目录只出现一次。
    const lower = plan.nextPaths.map(p => p.toLowerCase());
    expect(new Set(lower).size).toBe(lower.length);
    expect(plan.userPaths).not.toContain('${workspaceFolder}/Scripts');
    expect(plan.managedPaths).toContain('${workspaceFolder}/scripts');
  });

  it('POSIX 语境保持大小写敏感(Scripts 与 scripts 是不同目录)', () => {
    const plan = planPythonExtraPaths({
      workspaceRoot: '/home/user/proj',
      currentPaths: ['${workspaceFolder}/Scripts'],
      previouslyManaged: ['${workspaceFolder}/scripts'],
      deps: { exists: () => true, listSubdirs: () => [] }
    });
    expect(plan.userPaths).toContain('${workspaceFolder}/Scripts');
  });
});
