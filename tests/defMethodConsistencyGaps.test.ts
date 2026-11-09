import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EntityMappingManager } from '../src/entityMapping';
import { Uri, workspace as stubWorkspace } from './helpers/vscodeStub';
import { normalizeFileIdentity } from '../src/backend/pathIdentity';

// C-19 交付①:entityMapping 查询面的 def↔Python 方法集合差。正向
// (collectDefMethodImplementationGaps)只看 rootCategory='entity' 的根、只标
// defFile 落在本文件的声明,实现判存与 Go to Implementations 同一查询面 +
// 缓冲区感知兜底;反向(collectPythonMethodNotInDef)跳过引擎钩子与 dunder;
// getDefFileForPythonFile 给「Python 改动 → 重算属主 def」钩子寻址。

const AVATAR_DEF = [
  '<root>',
  '  <BaseMethods>',
  '    <reqPos>',
  '      <Arg>UINT32</Arg>',
  '      <Arg>VECTOR3</Arg>',
  '    </reqPos>',
  '    <onTick/>',
  '  </BaseMethods>',
  '</root>',
  ''
].join('\n');

const ROLE_DEF = [
  '<root>',
  '  <BaseMethods>',
  '    <onRoleEvent/>',
  '  </BaseMethods>',
  '</root>',
  ''
].join('\n');

/** reqPos 已实现,onTick 未实现 */
const BASE_PY = [
  'class Avatar(kbe.KBEntity):',
  '    def reqPos(self, stamp, pos):',
  '        pass',
  ''
].join('\n');

const CELL_PY = [
  'class Avatar(kbe.KBEntity):',
  '    pass',
  ''
].join('\n');

interface Fixture {
  root: string;
  avatarDef: string;
  roleDef: string;
  basePy: string;
  cellPy: string;
}

const buildWorkspace = (opts: { includeRoleDef?: boolean } = {}): Fixture => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-c19-'));
  const put = (relative: string, content: string): string => {
    const file = path.join(root, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content, 'utf8');
    return file;
  };
  const avatarDef = put('a/scripts/entity_defs/Avatar.def', AVATAR_DEF);
  const basePy = put('a/scripts/base/Avatar.py', BASE_PY);
  const cellPy = put('a/scripts/cell/Avatar.py', CELL_PY);
  const roleDef = opts.includeRoleDef
    ? put('a/scripts/interfaces/ROLE.def', ROLE_DEF)
    : avatarDef;
  stubWorkspace.workspaceFolders = [{ uri: Uri.file(root), name: 'ws', index: 0 }];
  return { root, avatarDef, roleDef, basePy, cellPy };
};

const withStubbedDefs = async <T>(
  defFiles: string[],
  run: () => Promise<T>
): Promise<T> => {
  const originalFindFiles = stubWorkspace.findFiles;
  stubWorkspace.findFiles = (async (glob?: string) =>
    glob === '**/*.def' ? defFiles.map(file => Uri.file(file)) : []) as typeof stubWorkspace.findFiles;
  try {
    return await run();
  } finally {
    stubWorkspace.findFiles = originalFindFiles;
    stubWorkspace.workspaceFolders = [];
  }
};

const makeManager = async (): Promise<EntityMappingManager> => {
  const manager = new EntityMappingManager({ subscriptions: [] } as never);
  await (manager as unknown as { waitForInitialScan(): Promise<void> }).waitForInitialScan();
  return manager;
};

const roots: string[] = [];

afterAll(() => {
  for (const root of roots) {
    fs.rmSync(root, { recursive: true, force: true });
  }
  stubWorkspace.textDocuments = [];
});

describe('collectDefMethodImplementationGaps(正向:def 有 Python 无)', () => {
  it('未实现方法入列(名字/行号/段/属主/形参类型),已实现不入列', async () => {
    const ws = buildWorkspace();
    roots.push(ws.root);
    await withStubbedDefs([ws.avatarDef], async () => {
      const manager = await makeManager();
      const gaps = await manager.collectDefMethodImplementationGaps(ws.avatarDef);
      const names = gaps.map(gap => gap.name);
      expect(names).toContain('onTick');
      expect(names).not.toContain('reqPos');
      const onTick = gaps.find(gap => gap.name === 'onTick')!;
      expect(onTick.line).toBe(7);
      expect(onTick.section).toBe('BaseMethods');
      expect(onTick.ownerName).toBe('Avatar');
      expect(onTick.declaredArgs).toEqual([]);
      expect(onTick.ownerFile.length).toBeGreaterThan(0);
      const reqPos = gaps.find(gap => gap.name === 'reqPos');
      expect(reqPos).toBeUndefined();
    });
  });

  it('缓冲区感知兜底:实现只存在于打开缓冲区(盘上无)时不入列', async () => {
    const ws = buildWorkspace();
    roots.push(ws.root);
    // 盘上 base/Avatar.py 无 reqPos 实现(BASE_PY 有;重写为无)
    fs.writeFileSync(
      ws.basePy,
      ['class Avatar(kbe.KBEntity):', '    pass', ''].join('\n'),
      'utf8'
    );
    await withStubbedDefs([ws.avatarDef], async () => {
      const manager = await makeManager();
      // 打开缓冲区含 reqPos 实现(未保存)——CodeAction 生成后未保存的形态
      stubWorkspace.textDocuments = [{
        uri: { toString: () => `file://${ws.basePy}`, fsPath: ws.basePy },
        version: 2,
        getText: () => 'class Avatar(kbe.KBEntity):\n    def reqPos(self, stamp, pos):\n        pass\n'
      }];
      try {
        const gaps = await manager.collectDefMethodImplementationGaps(ws.avatarDef);
        expect(gaps.map(gap => gap.name)).not.toContain('reqPos');
      } finally {
        stubWorkspace.textDocuments = [];
      }
    });
  });

  it('接口 def 无 Python 实体类:rootCategory 门控,零诊断(不误报)', async () => {
    const ws = buildWorkspace({ includeRoleDef: true });
    roots.push(ws.root);
    await withStubbedDefs([ws.avatarDef, ws.roleDef], async () => {
      const manager = await makeManager();
      const gaps = await manager.collectDefMethodImplementationGaps(ws.roleDef);
      expect(gaps).toEqual([]);
    });
  });

  it('getDefFileForPythonFile:属主脚本 → 根 def 文件;无关文件 → undefined', async () => {
    const ws = buildWorkspace();
    roots.push(ws.root);
    await withStubbedDefs([ws.avatarDef], async () => {
      const manager = await makeManager();
      // WIN-3:返回值经 normalizeFileIdentity(win32 盘符路径归一小写),两侧同口径比身份键
      expect(normalizeFileIdentity(manager.getDefFileForPythonFile(ws.basePy) ?? ''))
        .toBe(normalizeFileIdentity(ws.avatarDef));
      expect(manager.getDefFileForPythonFile(path.join(ws.root, 'unrelated.py'))).toBeUndefined();
    });
  });
});

describe('collectPythonMethodNotInDef(反向:Python 有 def 无,默认关)', () => {
  it('未声明方法入列;def 声明过的/dunder/引擎钩子不入列', async () => {
    const ws = buildWorkspace();
    roots.push(ws.root);
    // 盘上加一个未声明方法 + 一个引擎钩子
    fs.writeFileSync(
      ws.basePy,
      [
        'class Avatar(kbe.KBEntity):',
        '    def reqPos(self, stamp, pos):',
        '        pass',
        '',
        '    def helperLocal(self):',
        '        pass',
        '',
        '    def onClientEnabled(self):',
        '        pass',
        ''
      ].join('\n'),
      'utf8'
    );
    await withStubbedDefs([ws.avatarDef], async () => {
      const manager = await makeManager();
      const gaps = manager.collectPythonMethodNotInDef(ws.basePy);
      const names = gaps.map(gap => gap.methodName);
      expect(names).toContain('helperLocal');
      expect(names).not.toContain('reqPos'); // def 声明过
      expect(names).not.toContain('onClientEnabled'); // 引擎钩子
      expect(names.every(name => !name.startsWith('__'))).toBe(true);
      const helper = gaps.find(gap => gap.methodName === 'helperLocal')!;
      expect(helper.line).toBeGreaterThan(0);
    });
  });
});
