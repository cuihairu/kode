import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type * as vscode from 'vscode';
import {
  buildImportPreviewItems,
  identifyProjectLayout,
  importExistingProject
} from '../src/projectImport';
import { ProjectProfileStore } from '../src/projectProfiles';
import { Uri, window as stubWindow } from './helpers/vscodeStub';

// IDE-PRJ-003:现有 KBEngine 项目导入。选择资产根后按约定链识别
// entities/defs/scripts/engine 四面并预览(缺失如实显示未识别),确认后
// 建立项目 profile(IDE-PRJ-001 稳定身份存储);Esc 取消零写入;四面全空
// (不像 KBEngine 资产根)拒绝导入,宁缺勿猜。

class MemoryMemento implements vscode.Memento {
  private readonly map = new Map<string, unknown>();

  get<T>(key: string, defaultValue?: T): T | undefined {
    return this.map.has(key) ? (this.map.get(key) as T) : defaultValue;
  }

  update(key: string, value: unknown): Thenable<void> {
    if (value === undefined) {
      this.map.delete(key);
    } else {
      this.map.set(key, value);
    }
    return Promise.resolve();
  }

  keys(): readonly string[] {
    return [...this.map.keys()];
  }

  setKeysForSync(_keys: readonly string[]): void {
    // 内存替身不参与云同步
  }
}

function buildProjectTree(): { base: string; assetsRoot: string } {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-import-'));
  const assetsRoot = path.join(base, 'proj');
  fs.mkdirSync(path.join(assetsRoot, 'scripts', 'entity_defs'), { recursive: true });
  fs.writeFileSync(path.join(assetsRoot, 'scripts', 'entities.xml'), '<root>\n</root>\n', 'utf8');
  fs.writeFileSync(path.join(assetsRoot, 'scripts', 'entity_defs', 'types.xml'), '<root>\n</root>\n', 'utf8');
  // 引擎仓是资产根的兄弟:<base>/kbe 带源码锚点
  fs.mkdirSync(path.join(base, 'kbe', 'src', 'lib', 'entitydef'), { recursive: true });
  fs.writeFileSync(path.join(base, 'kbe', 'src', 'lib', 'entitydef', 'entitydef.cpp'), '', 'utf8');
  return { base, assetsRoot };
}

describe('project layout identification (IDE-PRJ-003)', () => {
  it('identifies entities/defs/scripts from the picked assets root and engine from the sibling repo', () => {
    const { base, assetsRoot } = buildProjectTree();

    const identification = identifyProjectLayout(assetsRoot);
    expect(identification.entitiesXml).toBe(path.join(assetsRoot, 'scripts', 'entities.xml'));
    expect(identification.entityDefsRoot).toBe(path.join(assetsRoot, 'scripts', 'entity_defs'));
    expect(identification.scriptsRoot).toBe(path.join(assetsRoot, 'scripts'));
    expect(identification.engineRoot).toBe(path.join(base, 'kbe'));

    fs.rmSync(base, { recursive: true, force: true });
  });

  it('keeps the assets root itself as scripts root when entities.xml sits at the top', () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-import-flat-'));
    fs.writeFileSync(path.join(base, 'entities.xml'), '<root>\n</root>\n', 'utf8');
    fs.mkdirSync(path.join(base, 'entity_defs'), { recursive: true });

    const identification = identifyProjectLayout(base);
    expect(identification.entitiesXml).toBe(path.join(base, 'entities.xml'));
    expect(identification.entityDefsRoot).toBe(path.join(base, 'entity_defs'));
    expect(identification.scriptsRoot).toBe(base);
    expect(identification.engineRoot).toBeNull();

    fs.rmSync(base, { recursive: true, force: true });
  });

  it('reports missing faces as null and preview items show 未识别', () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-import-bare-'));
    fs.mkdirSync(path.join(base, 'scripts'), { recursive: true });

    const identification = identifyProjectLayout(base);
    expect(identification.entitiesXml).toBeNull();
    expect(identification.entityDefsRoot).toBeNull();
    expect(identification.scriptsRoot).toBe(path.join(base, 'scripts'));

    const items = buildImportPreviewItems(identification);
    expect(items.map(item => item.label)).toEqual(['entities', 'defs', 'scripts', 'engine']);
    expect(items[0].description).toBe('未识别');
    expect(items[1].description).toBe('未识别');
    expect(items[2].description).toBe(path.join(base, 'scripts'));
    expect(items[3].description).toBe('未识别');

    fs.rmSync(base, { recursive: true, force: true });
  });
});

describe('import existing project flow (IDE-PRJ-003)', () => {
  const windowish = stubWindow as unknown as Record<string, unknown>;
  const originalWindow: Record<string, unknown> = {};
  const windowKeys = ['showOpenDialog', 'showQuickPick', 'showInformationMessage', 'showWarningMessage'];
  const info: string[] = [];
  const warning: string[] = [];

  beforeAll(() => {
    for (const key of windowKeys) {
      originalWindow[key] = windowish[key];
    }
  });

  afterAll(() => {
    for (const key of windowKeys) {
      if (originalWindow[key] === undefined) {
        delete windowish[key];
      } else {
        windowish[key] = originalWindow[key];
      }
    }
  });

  it('creates a profile with the identified roots after confirming the preview', async () => {
    const { base, assetsRoot } = buildProjectTree();
    const memento = new MemoryMemento();
    let previewItems: Array<{ label: string; description: string }> = [];
    windowish.showOpenDialog = async () => [Uri.file(assetsRoot)];
    windowish.showQuickPick = async (items: unknown[] | Promise<unknown[]>): Promise<unknown> => {
      const resolved = (await items) as Array<{ label: string; description: string }>;
      previewItems = resolved.slice(1);
      return resolved.find(item => item.label === '导入');
    };
    windowish.showInformationMessage = async (message: string): Promise<unknown> => {
      info.push(message);
      return undefined;
    };
    windowish.showWarningMessage = async (): Promise<unknown> => undefined;

    await importExistingProject({ workspaceState: memento });

    // 预览四面:识别结果带准确路径
    expect(previewItems.map(item => item.label)).toEqual(['entities', 'defs', 'scripts', 'engine']);
    expect(previewItems[0].description).toBe(path.join(assetsRoot, 'scripts', 'entities.xml'));
    expect(previewItems[3].description).toBe(path.join(base, 'kbe'));

    // 确认导入:profile 落进持久层,显示名取资产根目录名
    const profiles = new ProjectProfileStore(memento).list();
    expect(profiles).toHaveLength(1);
    expect(profiles[0]).toMatchObject({
      displayName: 'proj',
      assetsRoot,
      engineRoot: path.join(base, 'kbe')
    });
    expect(info.at(-1)).toContain('已导入项目 profile');

    fs.rmSync(base, { recursive: true, force: true });
  });

  it('cancels at the preview without writing any profile', async () => {
    const { base, assetsRoot } = buildProjectTree();
    const memento = new MemoryMemento();
    windowish.showOpenDialog = async () => [Uri.file(assetsRoot)];
    windowish.showQuickPick = async (): Promise<unknown> => undefined;
    windowish.showInformationMessage = async (message: string): Promise<unknown> => {
      info.push(message);
      return undefined;
    };

    await importExistingProject({ workspaceState: memento });

    expect(new ProjectProfileStore(memento).list()).toHaveLength(0);

    fs.rmSync(base, { recursive: true, force: true });
  });

  it('rejects a folder with no KBEngine structure instead of importing junk', async () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-import-empty-'));
    const memento = new MemoryMemento();
    let quickPickCalls = 0;
    windowish.showOpenDialog = async () => [Uri.file(base)];
    windowish.showQuickPick = async (): Promise<unknown> => {
      quickPickCalls += 1;
      return undefined;
    };
    windowish.showWarningMessage = async (message: string): Promise<unknown> => {
      warning.push(message);
      return undefined;
    };

    await importExistingProject({ workspaceState: memento });

    // 四面全空:直接拒绝,连预览都不出
    expect(quickPickCalls).toBe(0);
    expect(warning.at(-1)).toContain('未识别到 KBEngine 资产结构');
    expect(new ProjectProfileStore(memento).list()).toHaveLength(0);

    fs.rmSync(base, { recursive: true, force: true });
  });

  it('is a no-op when the folder dialog is dismissed', async () => {
    const memento = new MemoryMemento();
    windowish.showOpenDialog = async () => undefined;
    let quickPickCalls = 0;
    windowish.showQuickPick = async (): Promise<unknown> => {
      quickPickCalls += 1;
      return undefined;
    };

    await importExistingProject({ workspaceState: memento });

    expect(quickPickCalls).toBe(0);
    expect(new ProjectProfileStore(memento).list()).toHaveLength(0);
  });
});
