import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EntityMappingManager } from '../src/entityMapping';
import type { DefinitionSymbolIdentity } from '../src/entityMapping';
import {
  Range,
  Uri,
  lastFileSystemWatcher,
  workspace as stubWorkspace,
  window as stubWindow
} from './helpers/vscodeStub';

// EntityMappingManager 的实现解析回落链:ensureIndexForOwner 的实体回溯
// 与重扫兜底、findMethodImplementationByIdentity 的绑定直查失败后的
// owner 文件正则回退(findPythonMethodLine 的存在性/命中/未命中),
// openMethodTarget 的无索引/无实现/def 兜底三分支。

const p = (root: string, ...segments: string[]) => path.join(root, ...segments);

const write = (root: string, relative: string, content: string): void => {
  const target = p(root, ...relative.split('/'));
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content, 'utf8');
};

const originalFindFiles = stubWorkspace.findFiles;
const originalOpenTextDocument = stubWorkspace.openTextDocument;
const originalShowTextDocument = stubWindow.showTextDocument;

let root = '';

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-mapping-fallback-'));

  write(root, 'scripts/entities.xml', [
    '<root>',
    '  <Hero hasBase="true" hasCell="true"/>',
    '  <Ghost hasBase="true"/>',
    '</root>'
  ].join('\n'));

  write(root, 'scripts/entity_defs/Hero.def', [
    '<root>',
    '  <Interfaces>',
    '    <MoveIface/>',
    '  </Interfaces>',
    '  <BaseMethods>',
    '    <onSave/>',
    '  </BaseMethods>',
    '  <CellMethods>',
    '    <move/>',
    '  </CellMethods>',
    '</root>'
  ].join('\n'));

  write(root, 'scripts/entity_defs/Ghost.def', [
    '<root>',
    '  <BaseMethods>',
    '    <roar/>',
    '    <vanish/>',
    '  </BaseMethods>',
    '</root>'
  ].join('\n'));

  write(root, 'scripts/entity_defs/interfaces/MoveIface.def', [
    '<root>',
    '  <BaseMethods>',
    '    <onMove/>',
    '  </BaseMethods>',
    '</root>'
  ].join('\n'));

  write(root, 'scripts/base/Hero.py', 'class Hero(object):\n    def onSave(self):\n        pass\n');
  write(root, 'scripts/cell/Hero.py', 'class Hero(object):\n    def move(self):\n        pass\n');
  write(root, 'scripts/interfaces/MoveIface.py', 'class MoveIface(object):\n    def onMove(self):\n        pass\n');

  stubWorkspace.workspaceFolders = [{ uri: Uri.file(root), name: 'ws', index: 0 }];
  stubWorkspace.findFiles = async (): Promise<Uri[]> => {
    const results: Uri[] = [];
    const walk = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = p(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full);
        } else if (entry.name.endsWith('.def')) {
          results.push(Uri.file(full));
        }
      }
    };
    walk(root);
    return results;
  };
});

afterAll(() => {
  stubWorkspace.findFiles = originalFindFiles;
  stubWorkspace.openTextDocument = originalOpenTextDocument;
  stubWindow.showTextDocument = originalShowTextDocument;
  stubWorkspace.workspaceFolders = [];
  lastFileSystemWatcher.current = null;
  fs.rmSync(root, { recursive: true, force: true });
});

const identity = (over: Partial<DefinitionSymbolIdentity>): DefinitionSymbolIdentity => ({
  ownerKind: 'entity',
  ownerName: 'Ghost',
  sourceKind: 'local',
  sourceChain: [],
  section: 'BaseMethods',
  symbolName: 'roar',
  ...over
});

const makeManager = (): EntityMappingManager => {
  const manager = new EntityMappingManager({ subscriptions: [] });
  return manager;
};

describe('resolveMethodImplementationByIdentity fallbacks', () => {
  it('walks from an interface symbol back to the referencing entity index', async () => {
    const manager = makeManager();
    const implementation = await manager.resolveMethodImplementationByIdentity(identity({
      ownerKind: 'interface',
      ownerName: 'MoveIface',
      symbolName: 'onMove'
    }));

    expect(implementation?.filePath).toBe(p(root, 'scripts', 'interfaces', 'MoveIface.py'));
    expect(implementation?.line).toBe(2);
    expect(implementation?.character).toBe(8);
    manager.dispose();
  });

  it('regex-scans owner candidate files when no python binding matches', async () => {
    // 扫描时 scripts/base/Ghost.py 与 assets/scripts/base/Ghost.py 都不存在,
    // Ghost 没有任何 python 绑定;落盘第二前缀后正则回退命中 assets 侧文件。
    write(root, 'assets/scripts/base/Ghost.py', 'class Ghost(object):\n    def roar(self):\n        pass\n');
    const manager = makeManager();

    const hit = await manager.resolveMethodImplementationByIdentity(identity({}));
    expect(hit?.filePath).toBe(p(root, 'assets', 'scripts', 'base', 'Ghost.py'));
    expect(hit?.line).toBe(2);
    expect(hit?.character).toBe(8);

    // 正则回退未命中(文件存在但没有该 def)与首个候选缺失都返回 null
    const miss = await manager.resolveMethodImplementationByIdentity(identity({ symbolName: 'absent' }));
    expect(miss).toBeNull();

    manager.dispose();
  });

  it('rescans and still returns null for an owner nothing references', async () => {
    const manager = makeManager();
    const implementation = await manager.resolveMethodImplementationByIdentity(identity({
      ownerName: 'Nobody',
      symbolName: 'x'
    }));

    expect(implementation).toBeNull();
    manager.dispose();
  });
});

describe('openMethodTarget legacy gaps', () => {
  it('returns false when the entity has no index', async () => {
    const manager = makeManager();
    expect(await manager.openMethodTarget('Nope', 'x', 'BaseMethods')).toBe(false);
    manager.dispose();
  });

  it('returns false when neither implementation nor definition exists', async () => {
    const manager = makeManager();
    expect(await manager.openMethodTarget('Ghost', 'nothere', 'BaseMethods')).toBe(false);
    manager.dispose();
  });

  it('opens the def file line when only the definition exists', async () => {
    const manager = makeManager();
    const opened: Uri[] = [];
    const shown: Array<{ document: { fsPath: string }; options: { selection: Range } }> = [];
    stubWorkspace.openTextDocument = async (uri: Uri) => {
      opened.push(uri);
      return { uri };
    };
    stubWindow.showTextDocument = async (document: never, options?: never) => {
      shown.push({
        document: document as unknown as { fsPath: string },
        options: options as unknown as { selection: Range }
      });
      return {};
    };

    try {
      const result = await manager.openMethodTarget('Ghost', 'vanish', 'BaseMethods');
      expect(result).toBe(true);
      expect(opened).toHaveLength(1);
      expect(path.basename(opened[0].fsPath)).toBe('Ghost.def');
      // Ghost.def 第 4 行的 <vanish/>,0 基行 3
      expect(shown[0].options.selection.start.line).toBe(3);
      expect(shown[0].options.selection.start.character).toBe(0);
    } finally {
      stubWorkspace.openTextDocument = originalOpenTextDocument;
      stubWindow.showTextDocument = originalShowTextDocument;
    }
    manager.dispose();
  });
});
