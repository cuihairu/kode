import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { EntityMappingManager } from '../src/entityMapping';
import type { DefMethodMroOutcome } from '../src/entityMapping';
import { PythonClassIndex } from '../src/backend/pythonClassIndex';
import { collectDefMethodMissingItems } from '../src/backend/defMethodConsistency';
import { resetScanRootCache } from '../src/scanRoots';
import { Uri, workspace as stubWorkspace } from './helpers/vscodeStub';
import { normalizeFileIdentity } from '../src/backend/pathIdentity';
import { patternGlob } from './helpers/findPattern';

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
  // 收窄:根下无 scripts 不贡献扫描根,建空 scripts 保 stub 发现链(同 nav007)
  fs.mkdirSync(path.join(root, 'scripts'), { recursive: true });
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
  stubWorkspace.findFiles = (async (raw?: unknown) => {
    const glob = patternGlob(raw);
    return glob.endsWith('.def') ? defFiles.map(file => Uri.file(file)) : [];
  }) as typeof stubWorkspace.findFiles;
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

// C-19-MRO(2026-11-24 用户令「父类已实现还报警」):判存臂按继承链查实现。
// 三态口径:链上有实现 → 消 gap;链查过无实现 → 照报并注明已查链;臂未生效
// (注入缺失/类或链解析不出)→ 照报现状不注明(不编造)。注入面经 setter
// 回填(构造序:entityMapping 先于 pythonClassIndex),真索引集成用例走
// resolveMroImplementationOutcome 实链(Python 解析面 C3 与 entityMapping 判存
// 两缝都在验收内)。
describe('collectDefMethodImplementationGaps C-19-MRO 臂(继承链判存)', () => {
  beforeEach(() => {
    // 扫描根缓存按 workspaceFolders 记忆,每用例换 mkdtemp 根,先清(同 selfPropertyHover)
    resetScanRootCache();
  });

  /** 继承形态夹具:base/Avatar.py 类继承 Parent(onTick 实现与否分态) */
  const mroOutcome = (outcome: Partial<DefMethodMroOutcome>): DefMethodMroOutcome => ({
    resolved: false,
    classNames: [],
    implementations: [],
    ...outcome
  });

  it('链上有实现(父类定义)→ gap 不产出(诊断不报)', async () => {
    const ws = buildWorkspace();
    roots.push(ws.root);
    await withStubbedDefs([ws.avatarDef], async () => {
      const manager = await makeManager();
      manager.setDefMethodMroOutcomeResolver(async () => mroOutcome({
        resolved: true,
        classNames: ['Avatar', 'Parent'],
        implementations: [{ className: 'Parent', filePath: '/x/parent.py', line: 3 }]
      }));
      const gaps = await manager.collectDefMethodImplementationGaps(ws.avatarDef);
      expect(gaps.map(gap => gap.name)).not.toContain('onTick');
      expect(gaps.map(gap => gap.name)).not.toContain('reqPos');
    });
  });

  it('链查过无实现 → 照报并注明已查链(gap 带 mroChainClassNames,消息带说明)', async () => {
    const ws = buildWorkspace();
    roots.push(ws.root);
    await withStubbedDefs([ws.avatarDef], async () => {
      const manager = await makeManager();
      manager.setDefMethodMroOutcomeResolver(async () => mroOutcome({
        resolved: true,
        classNames: ['Avatar', 'Parent']
      }));
      const gaps = await manager.collectDefMethodImplementationGaps(ws.avatarDef);
      const onTick = gaps.find(gap => gap.name === 'onTick');
      expect(onTick).toBeDefined();
      expect(onTick!.mroChainClassNames).toEqual(['Avatar', 'Parent']);
      const items = collectDefMethodMissingItems(fs.readFileSync(ws.avatarDef, 'utf8'), gaps);
      const message = items.find(item => item.message.includes('onTick'))!.message;
      expect(message).toContain('继承链 Avatar → Parent 亦无实现');
    });
  });

  it('臂未生效(类解析不出 resolved=false)→ 照报现状,不注链(不编造)', async () => {
    const ws = buildWorkspace();
    roots.push(ws.root);
    await withStubbedDefs([ws.avatarDef], async () => {
      const manager = await makeManager();
      manager.setDefMethodMroOutcomeResolver(async () => mroOutcome({ resolved: false }));
      const gaps = await manager.collectDefMethodImplementationGaps(ws.avatarDef);
      const onTick = gaps.find(gap => gap.name === 'onTick');
      expect(onTick).toBeDefined();
      expect(onTick!.mroChainClassNames).toBeUndefined();
      const items = collectDefMethodMissingItems(fs.readFileSync(ws.avatarDef, 'utf8'), gaps);
      const message = items.find(item => item.message.includes('onTick'))!.message;
      expect(message).not.toContain('亦无实现');
    });
  });

  it('注入缺失 → 照报现状(旧口径逐字不变)', async () => {
    const ws = buildWorkspace();
    roots.push(ws.root);
    await withStubbedDefs([ws.avatarDef], async () => {
      const manager = await makeManager();
      const gaps = await manager.collectDefMethodImplementationGaps(ws.avatarDef);
      const onTick = gaps.find(gap => gap.name === 'onTick');
      expect(onTick).toBeDefined();
      expect(onTick!.mroChainClassNames).toBeUndefined();
      const items = collectDefMethodMissingItems(fs.readFileSync(ws.avatarDef, 'utf8'), gaps);
      const message = items.find(item => item.message.includes('onTick'))!.message;
      expect(message).not.toContain('亦无实现');
    });
  });

  it('真索引集成:父类 mixin 已实现 → 不报;父类也无 → 报且注明实链(验收两态)', async () => {
    const ws = buildWorkspace();
    roots.push(ws.root);
    // 继承形态:Avatar(Parent) 不实现 onTick;Parent 实现与否写两态
    const avatarPy = [
      'from parent_mixin import Parent',
      '',
      'class Avatar(Parent):',
      '    def reqPos(self, stamp, pos):',
      '        pass',
      ''
    ].join('\n');
    const parentWith = [
      'class Parent:',
      '    def onTick(self):',
      '        pass',
      ''
    ].join('\n');
    const parentWithout = [
      'class Parent:',
      '    pass',
      ''
    ].join('\n');
    fs.writeFileSync(ws.basePy, avatarPy, 'utf8');
    const parentPy = path.join(path.dirname(ws.basePy), 'parent_mixin.py');
    const pyFiles = [ws.basePy, ws.cellPy, parentPy];
    // findFiles 桩:.def glob 给 def,.py glob 给 py(真索引发现链走同一桩)
    const originalFindFiles = stubWorkspace.findFiles;
    stubWorkspace.findFiles = (async (raw?: unknown) => {
      const glob = patternGlob(raw);
      if (glob.endsWith('.def')) { return [Uri.file(ws.avatarDef)]; }
      if (glob.endsWith('.py')) { return pyFiles.map(file => Uri.file(file)); }
      return [];
    }) as typeof stubWorkspace.findFiles;
    const originalFolders = stubWorkspace.workspaceFolders;
    stubWorkspace.workspaceFolders = [{ uri: Uri.file(ws.root), name: 'ws', index: 0 }];
    try {
      // 态①:父类实现 onTick → 诊断不报
      fs.writeFileSync(parentPy, parentWith, 'utf8');
      const manager = await makeManager();
      const index = new PythonClassIndex();
      manager.setDefMethodMroOutcomeResolver((ownerFile, ownerClassName, methodName) =>
        index.resolveMroImplementationOutcome(ownerFile, ownerClassName, methodName));
      let gaps = await manager.collectDefMethodImplementationGaps(ws.avatarDef);
      expect(gaps.map(gap => gap.name)).not.toContain('onTick');

      // 态②:父类也无实现 → 照报,注明真实查过的链(Avatar → Parent)
      fs.writeFileSync(parentPy, parentWithout, 'utf8');
      // py 变更须走真实失效链(pythonClassIndex 按盘读缓存,mtime+大小变化才重解析)
      await index.onFileChanged(parentPy);
      gaps = await manager.collectDefMethodImplementationGaps(ws.avatarDef);
      const onTick = gaps.find(gap => gap.name === 'onTick');
      expect(onTick).toBeDefined();
      expect(onTick!.mroChainClassNames).toEqual(['Avatar', 'Parent']);
      const items = collectDefMethodMissingItems(fs.readFileSync(ws.avatarDef, 'utf8'), gaps);
      expect(items.find(item => item.message.includes('onTick'))!.message)
        .toContain('继承链 Avatar → Parent 亦无实现');
    } finally {
      stubWorkspace.findFiles = originalFindFiles;
      stubWorkspace.workspaceFolders = originalFolders;
      resetScanRootCache();
    }
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
