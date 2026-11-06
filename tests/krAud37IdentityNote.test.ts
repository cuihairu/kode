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

describe('KR-AUD-37 审核轮收口:根边界与混合语境', () => {
  it('盘符根折叠后形态归一:C:/a/.. 与 c:/ 同键(审核 P2)', () => {
    expect(normalizeFileIdentity('C:/a/..')).toBe('c:/');
    expect(normalizeFileIdentity('C:/a/..')).toBe(normalizeFileIdentity('c:/'));
    expect(normalizeFileIdentity('c:/')).toBe('c:/');
  });

  it('UNC 的 server/share 根不可被 .. 弹出(审核 P2)', () => {
    expect(normalizeFileIdentity('//server/share/..')).toBe('//server/share');
    // share 根上的 .. 按根上丢弃语义(=/.. 即 /),不跨共享边界
    expect(normalizeFileIdentity('//server/share/../other')).toBe('//server/share/other');
    expect(normalizeFileIdentity('//server/share/a/../../b')).toBe('//server/share/b');
  });

  it('extraPaths 逐对判定:盘符字面路径 CI,混合语境下 POSIX var 对不误吞(审核 P2)', () => {
    const plan = planPythonExtraPaths({
      workspaceRoot: '/home/user/proj',
      currentPaths: ['C:/data/proj/Scripts', '${workspaceFolder}/Scripts'],
      previouslyManaged: ['c:/data/proj/scripts', '${workspaceFolder}/scripts'],
      deps: { exists: () => true, listSubdirs: () => [] }
    });
    // 盘符字面路径对:大小写变体被识别为托管(不进用户段)
    expect(plan.userPaths).not.toContain('C:/data/proj/Scripts');
    // POSIX 工作区 + var 形态对:保持大小写敏感,Scripts 不被误吞
    expect(plan.userPaths).toContain('${workspaceFolder}/Scripts');
  });
});

describe('KR-AUD-37 三轮收口:POSIX 目录名不得与盘符根碰撞', () => {
  it('POSIX `/C:`(名为 C: 的目录)保持 POSIX 形态,不与盘符根 c:/ 同键', () => {
    expect(normalizeFileIdentity('/C:')).toBe('/C:');
    expect(normalizeFileIdentity('/C:')).not.toBe(normalizeFileIdentity('c:/'));
    expect(normalizeFileIdentity('/C:/x.py')).toBe('/C:/x.py');
  });
});
