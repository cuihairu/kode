import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  makeTextDocument,
  panelRegistry,
  Uri,
  window as stubWindow,
  workspace as stubWorkspace
} from './helpers/vscodeStub';
import { messages, windowState } from './fake-vscode/windowState';
import type { EntityMappingManager } from '../src/entityMapping';
import type { FlowCallGraphSource } from '../src/flowCallGraphData';
import {
  FlowSwimlanePanel,
  listEntryFunctions,
  makeWorkspaceFlowSource
} from '../src/flowSwimlanePanel';

// FLOW-015(旧 KFLOW-UI-02)泳道面板钉:入口选择、工作区数据源、面板
// 生命周期与展示红线(静态角色不冒充运行实例)。

const CLIENT_AVATAR = '/ws/scripts/client/Avatar.py';
const BASE_AVATAR = '/ws/scripts/base/Avatar.py';
const CELL_AVATAR = '/ws/scripts/cell/Avatar.py';

const CLIENT_TEXT = [
  'class Avatar:',
  '    def chooseRole(self, roleId):',
  '        self.base.chooseRole(roleId)',
  '',
  '    def onEnterGame(self, roleId):',
  "        self.playFx('enter_game')"
].join('\n');

const BASE_TEXT = [
  'class Avatar:',
  '    def chooseRole(self, roleId):',
  '        if self.ready:',
  '            self.cell.enterGame(roleId)'
].join('\n');

const CELL_TEXT = [
  'class Avatar:',
  '    def enterGame(self, roleId):',
  "        self.allClients.showScene('scene_1')",
  '        self.client.onEnterGame(roleId)'
].join('\n');

const TEXTS: Record<string, string> = {
  [CLIENT_AVATAR]: CLIENT_TEXT,
  [BASE_AVATAR]: BASE_TEXT,
  [CELL_AVATAR]: CELL_TEXT
};

const DEF_REGISTRY: Record<string, { defFile: string; line: number }> = {
  'Avatar\u001fBaseMethods\u001fchooseRole': { defFile: '/ws/entity_defs/Avatar.def', line: 10 },
  'Avatar\u001fCellMethods\u001fenterGame': { defFile: '/ws/entity_defs/Avatar.def', line: 21 },
  'Avatar\u001fClientMethods\u001fonEnterGame': { defFile: '/ws/entity_defs/Avatar.def', line: 34 }
};

const IMPL_REGISTRY: Record<
  string,
  { filePath: string; line: number; className: string }
> = {
  'Avatar\u001fBaseMethods\u001fchooseRole': {
    filePath: BASE_AVATAR,
    line: 1,
    className: 'Avatar'
  },
  'Avatar\u001fCellMethods\u001fenterGame': {
    filePath: CELL_AVATAR,
    line: 1,
    className: 'Avatar'
  },
  'Avatar\u001fClientMethods\u001fonEnterGame': {
    filePath: CLIENT_AVATAR,
    line: 4,
    className: 'Avatar'
  }
};

/** 宿主映射替身:resolveMethodDefinitionForClass 的 identity 形状只在本替身内闭合 */
const makeManager = (): EntityMappingManager =>
  ({
    getMappingForPythonFile: (file: string) =>
      TEXTS[file] !== undefined ? { name: 'Avatar' } : undefined,
    resolveMethodDefinitionForClass: async (
      entity: string,
      methodName: string,
      section?: string
    ) => {
      const key = `${entity}\u001f${section}\u001f${methodName}`;
      const def = DEF_REGISTRY[key];
      return def ? { ...def, identity: { key } } : null;
    },
    resolveMethodImplementationByIdentity: async (identity: { key?: string }) => {
      const impl = identity?.key ? IMPL_REGISTRY[identity.key] : undefined;
      return impl ?? null;
    }
  }) as unknown as EntityMappingManager;

const originalFindFiles = stubWorkspace.findFiles;
const originalOpenTextDocument = stubWorkspace.openTextDocument;
const originalGetWorkspaceFolder = (
  stubWorkspace as { getWorkspaceFolder?: unknown }
).getWorkspaceFolder;
const originalQuickPick = stubWindow.showQuickPick;
const originalActiveTextEditor = (
  stubWindow as { activeTextEditor?: unknown }
).activeTextEditor;

const stubOpenTextDocument = (): void => {
  (stubWorkspace as { openTextDocument: unknown }).openTextDocument = async (uri: unknown) => {
    const fsPath = (uri as { fsPath: string }).fsPath;
    const text = TEXTS[fsPath];
    if (text === undefined) {
      throw new Error(`not found: ${fsPath}`);
    }
    return makeTextDocument(text, { fileName: fsPath, uri: Uri.file(fsPath) });
  };
};

const stubFindFiles = (paths: string[]): void => {
  stubWorkspace.findFiles = async () => paths.map(fsPath => Uri.file(fsPath));
};

const fullSource = (rootKey: string): FlowCallGraphSource => ({
  rootKey,
  listScriptFiles: async () => Object.keys(TEXTS),
  readFile: async filePath => TEXTS[filePath] ?? null,
  entityForFile: async filePath => (TEXTS[filePath] !== undefined ? 'Avatar' : null),
  resolveDefMethod: async (entity, section, methodName) =>
    DEF_REGISTRY[`${entity}\u001f${section}\u001f${methodName}`] ?? null,
  resolveImplementation: async (entity, section, methodName) => {
    const impl = IMPL_REGISTRY[`${entity}\u001f${section}\u001f${methodName}`];
    return impl
      ? { ...impl, signature: 'def placeholder(self)', inheritedFrom: null }
      : null;
  }
});

beforeEach(() => {
  windowState.reset();
  panelRegistry.reset();
});

afterEach(() => {
  stubWorkspace.findFiles = originalFindFiles;
  stubWorkspace.openTextDocument = originalOpenTextDocument;
  (stubWorkspace as { getWorkspaceFolder?: unknown }).getWorkspaceFolder =
    originalGetWorkspaceFolder;
  stubWindow.showQuickPick = originalQuickPick;
  (stubWindow as { activeTextEditor?: unknown }).activeTextEditor =
    originalActiveTextEditor;
});

describe('FLOW-015 入口函数清单', () => {
  it('解析活动编辑器函数并按名排序', () => {
    expect(listEntryFunctions(CLIENT_TEXT, CLIENT_AVATAR, '/ws')).toEqual([
      'chooseRole',
      'onEnterGame'
    ]);
  });

  it('解析失败/无函数如实为空,不抛不猜', () => {
    expect(listEntryFunctions('', CLIENT_AVATAR, '/ws')).toEqual([]);
    expect(listEntryFunctions('def broken(:\n', CLIENT_AVATAR, '/ws')).toEqual([]);
  });
});

describe('FLOW-015 工作区数据源', () => {
  beforeEach(() => {
    stubOpenTextDocument();
  });

  it('有界收集:只收实体脚本面,按路径确定序(多根合并去乱序)', async () => {
    stubFindFiles([
      CELL_AVATAR,
      '/ws/other/random.py',
      CLIENT_AVATAR,
      BASE_AVATAR,
      '/ws/scripts/entity_defs/notpython.txt.py',
      '/ws/nested/scripts/bots/Bot.py'
    ]);
    const source = makeWorkspaceFlowSource(
      { entityMappingManager: makeManager() },
      '/ws'
    );
    const files = await source.listScriptFiles();
    expect(files).toEqual([
      '/ws/nested/scripts/bots/Bot.py',
      BASE_AVATAR,
      CELL_AVATAR,
      CLIENT_AVATAR
    ]);
  });

  it('readFile 经宿主文档读取;读不到如实 null', async () => {
    stubFindFiles([CLIENT_AVATAR]);
    const source = makeWorkspaceFlowSource(
      { entityMappingManager: makeManager() },
      '/ws'
    );
    expect(await source.readFile(CLIENT_AVATAR)).toBe(CLIENT_TEXT);
    expect(await source.readFile('/ws/scripts/base/Ghost.py')).toBeNull();
  });

  it('实体归属经宿主映射;无映射如实 null', async () => {
    stubFindFiles([CLIENT_AVATAR]);
    const source = makeWorkspaceFlowSource(
      { entityMappingManager: makeManager() },
      '/ws'
    );
    expect(await source.entityForFile(CLIENT_AVATAR)).toBe('Avatar');
    expect(await source.entityForFile('/ws/scripts/base/Ghost.py')).toBeNull();
  });

  it('def/实现解析经宿主(实现签名=def 行整行 trim,行号 0 基直通)', async () => {
    stubFindFiles([CELL_AVATAR]);
    const source = makeWorkspaceFlowSource(
      { entityMappingManager: makeManager() },
      '/ws'
    );
    const def = await source.resolveDefMethod('Avatar', 'CellMethods', 'enterGame');
    expect(def).toEqual({ defFile: '/ws/entity_defs/Avatar.def', line: 21 });
    const impl = await source.resolveImplementation('Avatar', 'CellMethods', 'enterGame');
    expect(impl).not.toBeNull();
    expect(impl!.filePath).toBe(CELL_AVATAR);
    expect(impl!.line).toBe(1);
    expect(impl!.signature).toBe('def enterGame(self, roleId):');
    expect(impl!.className).toBe('Avatar');
  });

  it('def 未声明:实现解析如实 null(不猜实现)', async () => {
    stubFindFiles([BASE_AVATAR]);
    const source = makeWorkspaceFlowSource(
      { entityMappingManager: makeManager() },
      '/ws'
    );
    expect(
      await source.resolveDefMethod('Avatar', 'ClientMethods', 'onChooseRoleFailed')
    ).toBeNull();
    expect(
      await source.resolveImplementation('Avatar', 'ClientMethods', 'onChooseRoleFailed')
    ).toBeNull();
  });
});

describe('FLOW-015 面板生命周期与展示红线', () => {
  it('open:面板标题/装配 HTML/CSP 注入齐备,泳道头带静态角色标注', async () => {
    const panel = new FlowSwimlanePanel({
      entityMappingManager: makeManager(),
      sourceFactory: rootKey => fullSource(rootKey)
    });
    await panel.open('/ws', { filePath: CLIENT_AVATAR, functionName: 'chooseRole' });
    expect(panelRegistry.panels).toHaveLength(1);
    const fake = panelRegistry.panels[0];
    expect(fake.viewType).toBe('kbengine.flowSwimlane');
    expect(fake.title).toBe('调用图(G2 泳道) · chooseRole');
    expect(fake.webview.html).toContain('Content-Security-Policy');
    expect(fake.webview.html).toContain('泳道:client(静态角色,非运行实例)');
    expect(fake.webview.html).toContain('静态可能路径');
  });

  it('dispose 后再 open:换代新面板,旧面板不复活', async () => {
    const panel = new FlowSwimlanePanel({
      entityMappingManager: makeManager(),
      sourceFactory: rootKey => fullSource(rootKey)
    });
    await panel.open('/ws', { filePath: CLIENT_AVATAR, functionName: 'chooseRole' });
    const first = panelRegistry.panels[0];
    panel.dispose();
    expect(first.disposed).toBe(true);
    await panel.open('/ws', { filePath: BASE_AVATAR, functionName: 'chooseRole' });
    expect(panelRegistry.panels).toHaveLength(2);
    expect(panelRegistry.panels[1]).not.toBe(first);
    expect(panelRegistry.panels[1].title).toBe('调用图(G2 泳道) · chooseRole');
  });

  it('装配期间面板关闭:弃写(无悬空写入)', async () => {
    let releaseFiles: (() => void) | null = null;
    const gated = new Promise<string[]>(resolve => {
      releaseFiles = (): void => resolve(Object.keys(TEXTS));
    });
    const panel = new FlowSwimlanePanel({
      entityMappingManager: makeManager(),
      sourceFactory: (rootKey): FlowCallGraphSource => ({
        ...fullSource(rootKey),
        listScriptFiles: () => gated
      })
    });
    const pending = panel.open('/ws', { filePath: CLIENT_AVATAR, functionName: 'chooseRole' });
    const fake = panelRegistry.panels[0];
    fake.dispose();
    releaseFiles!();
    await pending;
    expect(fake.webview.html).toBe('');
  });
});

describe('FLOW-015 show() 命令入口', () => {
  const setEditor = (fsPath: string, text: string): void => {
    (stubWindow as { activeTextEditor?: unknown }).activeTextEditor = {
      document: makeTextDocument(text, { fileName: fsPath, uri: Uri.file(fsPath) })
    };
  };
  const stubWorkspaceFolder = (): void => {
    (stubWorkspace as { getWorkspaceFolder?: unknown }).getWorkspaceFolder = () => ({
      uri: Uri.file('/ws'),
      name: 'ws',
      index: 0
    });
  };
  const makePanel = (): FlowSwimlanePanel =>
    new FlowSwimlanePanel({
      entityMappingManager: makeManager(),
      sourceFactory: rootKey => fullSource(rootKey)
    });

  it('无 Python 编辑器:信息条如实,不开面板', async () => {
    await makePanel().show();
    expect(messages.info).toContainEqual(
      '没有打开的 Python 编辑器:先打开实体脚本再打开调用图'
    );
    expect(panelRegistry.panels).toHaveLength(0);
  });

  it('单函数:免快选直开面板(入口=唯一函数)', async () => {
    setEditor(
      CLIENT_AVATAR,
      'class Avatar:\n    def onlyEntry(self):\n        self.base.ping()'
    );
    stubWorkspaceFolder();
    await makePanel().show();
    expect(panelRegistry.panels).toHaveLength(1);
    expect(panelRegistry.panels[0].title).toBe('调用图(G2 泳道) · onlyEntry');
  });

  it('多函数:快选取消不开面板;快选定入口开对应面板', async () => {
    setEditor(CLIENT_AVATAR, CLIENT_TEXT);
    stubWorkspaceFolder();
    stubWindow.showQuickPick = async () => undefined;
    await makePanel().show();
    expect(panelRegistry.panels).toHaveLength(0);

    stubWindow.showQuickPick = async (items: string[]) => items[0];
    await makePanel().show();
    expect(panelRegistry.panels).toHaveLength(1);
    expect(panelRegistry.panels[0].title).toBe('调用图(G2 泳道) · chooseRole');
  });

  it('装配失败:错误条如实(不静默)', async () => {
    setEditor(
      CLIENT_AVATAR,
      'class Avatar:\n    def onlyEntry(self):\n        self.base.ping()'
    );
    stubWorkspaceFolder();
    const panel = new FlowSwimlanePanel({
      entityMappingManager: makeManager(),
      sourceFactory: (rootKey): FlowCallGraphSource => ({
        ...fullSource(rootKey),
        listScriptFiles: async () => {
          throw new Error('host read failure');
        }
      })
    });
    await panel.show();
    expect(messages.error).toContainEqual('调用图装配失败');
    expect(panelRegistry.panels[0].webview.html).toBe('');
  });
});
