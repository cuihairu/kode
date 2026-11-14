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
  makeWorkspaceFlowSource,
  resolveCursorFunction
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

const DEF_REGISTRY: Record<
  string,
  { defFile: string; line: number; declaredArgs?: string[]; declaredReturnType?: string | null }
> = {
  'Avatar\u001fBaseMethods\u001fchooseRole': {
    defFile: '/ws/entity_defs/Avatar.def',
    line: 10,
    declaredArgs: ['UINT32']
  },
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
    // 未声明 Arg/返回的 def 归一为空数组/null(诚实缺省,FLOW-017)
    expect(def).toEqual({
      defFile: '/ws/entity_defs/Avatar.def',
      line: 21,
      declaredArgs: [],
      declaredReturnType: null
    });
    // def 声明的 Arg/返回类型经宿主解析原样传通(FLOW-017)
    const defWithArgs = await source.resolveDefMethod('Avatar', 'BaseMethods', 'chooseRole');
    expect(defWithArgs!.declaredArgs).toEqual(['UINT32']);
    expect(defWithArgs!.declaredReturnType).toBeNull();
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

describe('FLOW-018 光标入口与节点反查', () => {
  const tick = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 0));
  const setEditorWithCursor = (fsPath: string, text: string, line: number): void => {
    (stubWindow as { activeTextEditor?: unknown }).activeTextEditor = {
      document: makeTextDocument(text, { fileName: fsPath, uri: Uri.file(fsPath) }),
      selection: { active: { line } }
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

  it('resolveCursorFunction:光标前最近 def 行语法锚', () => {
    expect(resolveCursorFunction(CLIENT_TEXT, 4)).toBe('onEnterGame');
    expect(resolveCursorFunction(CLIENT_TEXT, 1)).toBe('chooseRole');
    expect(resolveCursorFunction(CLIENT_TEXT, 0)).toBeNull();
    expect(resolveCursorFunction(CLIENT_TEXT, 99)).toBe('onEnterGame');
    expect(resolveCursorFunction('', 0)).toBeNull();
  });

  it('光标所在函数在图面:免快选直开', async () => {
    let quickPickCalls = 0;
    stubWindow.showQuickPick = (async (): Promise<string | undefined> => {
      quickPickCalls += 1;
      return undefined;
    }) as never;
    setEditorWithCursor(CLIENT_AVATAR, CLIENT_TEXT, 4);
    stubWorkspaceFolder();
    await makePanel().show();
    expect(quickPickCalls).toBe(0);
    expect(panelRegistry.panels).toHaveLength(1);
    expect(panelRegistry.panels[0].title).toBe('调用图(G2 泳道) · onEnterGame');
  });

  it('光标函数是叶(不在图面):回退快选,不虚构入口', async () => {
    const text = [
      'class Avatar:',
      '    def chooseRole(self):',
      '        self.base.ping()',
      '    def other(self):',
      '        self.client.ping()',
      '    def ghost(self):',
      '        pass'
    ].join('\n');
    let picked: string | null = null;
    stubWindow.showQuickPick = (async (items: string[]): Promise<string | undefined> => {
      picked = 'called';
      return items[0];
    }) as never;
    setEditorWithCursor(CLIENT_AVATAR, text, 6);
    stubWorkspaceFolder();
    await makePanel().show();
    expect(picked).toBe('called');
    expect(panelRegistry.panels[0].title).toBe('调用图(G2 泳道) · chooseRole');
  });

  it('候选帧节点反查:inspect 视图三面齐;返回回泳道(缓存复用)', async () => {
    const panel = makePanel();
    await panel.open('/ws', { filePath: CLIENT_AVATAR, functionName: 'chooseRole' });
    const fake = panelRegistry.panels[0];
    const nodeId = fake.webview.html.match(/data-node="([^"]+)"/)![1];
    for (const listener of [...fake.messageListeners]) {
      listener({ command: 'flowInspect', nodeId });
    }
    await tick();
    expect(fake.webview.html).toContain('反查:chooseRole');
    expect(fake.webview.html).toContain('上游');
    expect(fake.webview.html).toContain('下游');
    expect(fake.webview.html).toContain('data-flow-open-file');
    // 返回:回泳道走查(不走历史栈)
    for (const listener of [...fake.messageListeners]) {
      listener({ command: 'flowBack' });
    }
    await tick();
    expect(fake.webview.html).toContain('泳道:client(静态角色,非运行实例)');
    // 泳道上返回:空历史如实提示,不炸
    for (const listener of [...fake.messageListeners]) {
      listener({ command: 'flowBack' });
    }
    await tick();
    expect(messages.info).toContainEqual('没有上一视图');
  });

  it('坏节点 id 反查:如实不动(不炸不换视图)', async () => {
    const panel = makePanel();
    await panel.open('/ws', { filePath: CLIENT_AVATAR, functionName: 'chooseRole' });
    const fake = panelRegistry.panels[0];
    const before = fake.webview.html;
    for (const listener of [...fake.messageListeners]) {
      listener({ command: 'flowInspect', nodeId: 'garbage' });
    }
    await tick();
    expect(fake.webview.html).toBe(before);
    for (const listener of [...fake.messageListeners]) {
      listener({ command: 'flowInspect', nodeId: '/wsno-fnunresolvedno-entityno-fnnative-function' });
    }
    await tick();
    expect(fake.webview.html).toBe(before);
  });

  it('「打开图」导航:旧入口压栈,返回出栈重开', async () => {
    const panel = makePanel();
    await panel.open('/ws', { filePath: CLIENT_AVATAR, functionName: 'chooseRole' });
    const fake = panelRegistry.panels[0];
    for (const listener of [...fake.messageListeners]) {
      listener({ command: 'flowOpen', file: CELL_AVATAR, functionName: 'enterGame' });
    }
    await tick();
    expect(fake.title).toBe('调用图(G2 泳道) · enterGame');
    // 返回:出栈重开旧入口
    for (const listener of [...fake.messageListeners]) {
      listener({ command: 'flowBack' });
    }
    await tick();
    expect(fake.title).toBe('调用图(G2 泳道) · chooseRole');
    expect(messages.info).not.toContainEqual('没有上一视图');
  });

  it('导航目标装配失败:错误条如实,历史不入栈(视图停留)', async () => {
    const panel = makePanel();
    await panel.open('/ws', { filePath: CLIENT_AVATAR, functionName: 'chooseRole' });
    const fake = panelRegistry.panels[0];
    const before = fake.webview.html;
    for (const listener of [...fake.messageListeners]) {
      listener({ command: 'flowOpen', file: CLIENT_AVATAR, functionName: 'ghostFn' });
    }
    await tick();
    expect(messages.error).toContainEqual('调用图装配失败');
    expect(fake.webview.html).toBe(before);
    expect(fake.title).toBe('调用图(G2 泳道) · chooseRole');
  });

  it('面板销毁清历史:重开后返回如实提示(不复活旧场景)', async () => {
    const panel = makePanel();
    await panel.open('/ws', { filePath: CLIENT_AVATAR, functionName: 'chooseRole' });
    let fake = panelRegistry.panels[0];
    for (const listener of [...fake.messageListeners]) {
      listener({ command: 'flowOpen', file: CELL_AVATAR, functionName: 'enterGame' });
    }
    await tick();
    panel.dispose();
    await panel.open('/ws', { filePath: CLIENT_AVATAR, functionName: 'chooseRole' });
    fake = panelRegistry.panels[panelRegistry.panels.length - 1];
    for (const listener of [...fake.messageListeners]) {
      listener({ command: 'flowBack' });
    }
    await tick();
    expect(messages.info).toContainEqual('没有上一视图');
    expect(fake.title).toBe('调用图(G2 泳道) · chooseRole');
  });
});

describe('FLOW-016 面板跳转面(调用点/声明分别跳转)', () => {
  const stubOpenTextDocumentWithLines = (text: string): void => {
    (stubWorkspace as { openTextDocument: unknown }).openTextDocument = async (uri: unknown) => ({
      uri,
      lineCount: text.split('\n').length,
      lineAt: (line: number) => ({ text: text.split('\n')[line] ?? '' })
    });
  };

  it('面板启用脚本并注入 nonce 跳转桥(CSP 带脚本源)', async () => {
    const panel = new FlowSwimlanePanel({
      entityMappingManager: makeManager(),
      sourceFactory: rootKey => fullSource(rootKey)
    });
    await panel.open('/ws', { filePath: CLIENT_AVATAR, functionName: 'chooseRole' });
    const fake = panelRegistry.panels[0];
    expect((fake.options as { enableScripts?: boolean }).enableScripts).toBe(true);
    expect(fake.webview.html).toContain('script-src \'nonce-');
    expect(fake.webview.html).toContain('<script nonce=');
    expect(fake.webview.html).toContain('data-flow-jump');
  });

  it('flowJump 消息:按 0 基行打开并选中(越界钳末行)', async () => {
    stubOpenTextDocumentWithLines('l0\nl1\nl2');
    const editors: Array<{ selection?: { start: { line: number } } }> = [];
    const originalShow = stubWindow.showTextDocument;
    stubWindow.showTextDocument = (async (): Promise<unknown> => {
      const editor: { selection?: { start: { line: number } } } = {
        revealRange: (): void => undefined
      };
      editors.push(editor);
      return editor;
    }) as never;
    try {
      const panel = new FlowSwimlanePanel({
        entityMappingManager: makeManager(),
        sourceFactory: rootKey => fullSource(rootKey)
      });
      await panel.open('/ws', { filePath: CLIENT_AVATAR, functionName: 'chooseRole' });
      const fake = panelRegistry.panels[0];
      const jump = async (target: string): Promise<void> => {
        for (const listener of [...fake.messageListeners]) {
          listener({ command: 'flowJump', target });
        }
        // 揭示链是异步(openTextDocument → showTextDocument),宏任务后结算
        await new Promise(resolve => setTimeout(resolve, 0));
      };
      // 正常跳转:0 基行 2
      await jump('/ws/scripts/cell/Avatar.py:2');
      expect(editors).toHaveLength(1);
      expect(editors[0].selection!.start.line).toBe(2);
      // 越界:钳到末行(3 行文档 → 末行 2)
      await jump('/ws/scripts/cell/Avatar.py:99');
      expect(editors).toHaveLength(2);
      expect(editors[1].selection!.start.line).toBe(2);
      // 坏目标(行号非数字):不打开不炸
      await jump('nofile.py:xx');
      expect(editors).toHaveLength(2);
      // 合法目标(替身文档任意 uri 可开):正常打开
      await jump('/ws/scripts/base/Avatar.py:1');
      expect(editors).toHaveLength(3);
      expect(editors[2].selection!.start.line).toBe(1);
      // 空目标:不打开
      await jump('');
      expect(editors).toHaveLength(3);
    } finally {
      stubWindow.showTextDocument = originalShow;
    }
  });

  it('跳转目标文件打不开:警告如实', async () => {
    (stubWorkspace as { openTextDocument: unknown }).openTextDocument = async () => {
      throw new Error('missing');
    };
    const panel = new FlowSwimlanePanel({
      entityMappingManager: makeManager(),
      sourceFactory: rootKey => fullSource(rootKey)
    });
    await panel.open('/ws', { filePath: CLIENT_AVATAR, functionName: 'chooseRole' });
    const fake = panelRegistry.panels[0];
    for (const listener of [...fake.messageListeners]) {
      listener({ command: 'flowJump', target: '/ws/scripts/base/Ghost.py:1' });
    }
    await Promise.resolve();
    expect(messages.warning.some(w => w.includes('无法打开 /ws/scripts/base/Ghost.py'))).toBe(
      true
    );
  });
});

describe('FLOW-019 大图按需展开(有界初装/工具条/取消)', () => {
  const CHAIN_CELL = [
    'class Avatar:',
    '    def enterGame(self, roleId):',
    "        self.allClients.showScene('scene_1')",
    '        self.client.onEnterGame(roleId)',
    '        self.c1()',
    '',
    '    def c1(self):',
    '        self.c2()',
    '',
    '    def c2(self):',
    '        self.c3()',
    '',
    '    def c3(self):',
    '        self.c4()',
    '',
    '    def c4(self):',
    '        self.c5()',
    '',
    '    def c5(self):',
    '        pass'
  ].join('\n');

  const patchWithProgressCancelled = (): void => {
    (stubWindow as { withProgress: unknown }).withProgress = async (
      _options: unknown,
      task: (progress: unknown, token: { isCancellationRequested: boolean }) => Promise<unknown>
    ): Promise<unknown> =>
      task(undefined, {
        isCancellationRequested: true,
        onCancellationRequested: (): { dispose(): void } => ({ dispose: () => undefined })
      });
  };

  it('工具条注入:搜索/缩放/重置只在面板层,随 CSP nonce 脚本生效', async () => {
    const panel = new FlowSwimlanePanel({
      entityMappingManager: makeManager(),
      sourceFactory: rootKey => fullSource(rootKey)
    });
    await panel.open('/ws', { filePath: CLIENT_AVATAR, functionName: 'chooseRole' });
    const html = panelRegistry.panels[0].webview.html;
    expect(html).toContain('class="flow-toolbar"');
    expect(html).toContain('class="flow-search"');
    expect(html).toContain('搜索/过滤');
    expect(html).toContain('flow-zoom-in');
    expect(html).toContain('flow-zoom-out');
    expect(html).toContain('flow-zoom-reset');
    expect(html).toContain('applyZoom');
    expect(html).toContain('.flow-toolbar{position:sticky');
    // 工具条 DOM 在 <body> 之后(CSS/脚本注在 <head>,工件结构不被改写)
    expect(html.indexOf('class="flow-toolbar"')).toBeGreaterThan(html.indexOf('<body>'));
  });

  it('默认深度界 6:超界走查在边界帧标「截断边界/继续展开」,入口给文件+函数名', async () => {
    const sources: Record<string, string> = { ...TEXTS, [CELL_AVATAR]: CHAIN_CELL };
    const panel = new FlowSwimlanePanel({
      entityMappingManager: makeManager(),
      sourceFactory: (rootKey): FlowCallGraphSource => ({
        ...fullSource(rootKey),
        readFile: async filePath => sources[filePath] ?? null
      })
    });
    await panel.open('/ws', { filePath: CLIENT_AVATAR, functionName: 'chooseRole' });
    const html = panelRegistry.panels[0].webview.html;
    expect(html).toContain('截断边界');
    expect(html).toContain('继续展开');
    expect(html).toContain(`data-flow-open-file="${CELL_AVATAR}"`);
    expect(html).toContain('data-flow-open-fn="c4"');
    // 边界恰一处:深度 6 时触界的只有 c4;c5 叶函数无节点,不是帧
    expect(html.match(/data-flow-open-fn=/g)).toHaveLength(1);
    expect(html).not.toContain('data-flow-open-fn="c5"');
  });

  it('取消:open 停扩展弃写并抛取消哨兵(一个文件都不读)', async () => {
    const originalWithProgress = (stubWindow as { withProgress: unknown }).withProgress;
    patchWithProgressCancelled();
    const reads: string[] = [];
    try {
      const panel = new FlowSwimlanePanel({
        entityMappingManager: makeManager(),
        sourceFactory: (rootKey): FlowCallGraphSource => ({
          ...fullSource(rootKey),
          readFile: async filePath => {
            reads.push(filePath);
            return TEXTS[filePath] ?? null;
          }
        })
      });
      await expect(
        panel.open('/ws', { filePath: CLIENT_AVATAR, functionName: 'chooseRole' })
      ).rejects.toThrow(/cancelled/);
      expect(reads).toEqual([]);
      expect(panelRegistry.panels[0].webview.html).toBe('');
    } finally {
      (stubWindow as { withProgress: unknown }).withProgress = originalWithProgress;
    }
  });

  it('show() 取消:信息提示「已取消」,不误报装配失败', async () => {
    const originalWithProgress = (stubWindow as { withProgress: unknown }).withProgress;
    const originalGetWorkspaceFolder = (
      stubWorkspace as { getWorkspaceFolder?: unknown }
    ).getWorkspaceFolder;
    patchWithProgressCancelled();
    (stubWorkspace as { getWorkspaceFolder: unknown }).getWorkspaceFolder = () => ({
      uri: Uri.file('/ws'),
      name: 'ws',
      index: 0
    });
    try {
      (stubWindow as { activeTextEditor?: unknown }).activeTextEditor = {
        document: makeTextDocument(BASE_TEXT, { fileName: BASE_AVATAR, uri: Uri.file(BASE_AVATAR) })
      };
      const panel = new FlowSwimlanePanel({
        entityMappingManager: makeManager(),
        sourceFactory: rootKey => fullSource(rootKey)
      });
      await panel.show();
      expect(messages.info).toContainEqual('调用图装配已取消');
      expect(messages.error.some(e => e.includes('装配失败'))).toBe(false);
    } finally {
      (stubWindow as { withProgress: unknown }).withProgress = originalWithProgress;
      (stubWorkspace as { getWorkspaceFolder?: unknown }).getWorkspaceFolder =
        originalGetWorkspaceFolder;
    }
  });
});
