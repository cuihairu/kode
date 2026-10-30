// 覆盖率补测(lcov 未触达行):defCallChainViewer(webview 装配面)/
// defCallChainProvider / defCallChain / defParamInlayHints / defReferenceGraph。
// 只做真实行为断言:渲染失败回落 Text、tab 点击/postMessage/宿主消息联动、
// code lens 装配、同名多候选按文件收窄、默认文件读取器 mtime 缓存、
// 引号/嵌套/转义切参、接口与组件引用边、畸形与不可读 .def 跳过。
// webview 脚本本身 `void activate()` 自驱:node 环境先装 DOM/window/
// mermaid 最小替身再动态导入,vi.resetModules 让每个面重跑一次装配。
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildDefCallChain,
  clearDefCallChainFileCache,
  findDefMethodByStart
} from '../src/defCallChain';
import { CallChainController } from '../src/defCallChainProvider';
import { DefParamInlayHintsProvider, findDefParamSites } from '../src/defParamInlayHints';
import { buildDefReferenceGraphFromFile } from '../src/defReferenceGraph';
import { EntityMappingManager } from '../src/entityMapping';
import type { EntityMappingIndex } from '../src/entityMapping';
import {
  configurationOverrides,
  makeTextDocument,
  messages,
  panelRegistry,
  Position,
  Range,
  Uri,
  window as stubWindow
} from './helpers/vscodeStub';

// ---------------------------------------------------------------------------
// defCallChainViewer:浏览器侧装配面(esbuild 打包源,vitest 直驱)
// ---------------------------------------------------------------------------

/** 最小 DOM 元素替身:覆盖 viewer 用到的全部面(textContent/hidden/innerHTML/
 *  dataset/setAttribute/addEventListener) */
interface StubElement {
  textContent: string;
  innerHTML: string;
  hidden: boolean;
  dataset: Record<string, string>;
  attributes: Record<string, string>;
  clickListeners: Array<() => void>;
  setAttribute(name: string, value: string): void;
  addEventListener(type: string, listener: () => void): void;
  click(): void;
}

const makeElement = (dataset: Record<string, string> = {}, textContent = ''): StubElement => {
  const element: StubElement = {
    textContent,
    innerHTML: '',
    hidden: false,
    dataset,
    attributes: {},
    clickListeners: [],
    setAttribute(name: string, value: string): void {
      element.attributes[name] = value;
    },
    addEventListener(_type: string, listener: () => void): void {
      element.clickListeners.push(listener);
    },
    click(): void {
      for (const listener of [...element.clickListeners]) {
        listener();
      }
    }
  };
  return element;
};

interface StubDocument extends Record<string, unknown> {
  payload: StubElement;
  notice: StubElement | null;
  tabs: StubElement[];
  panes: StubElement[];
  getElementById(id: string): StubElement | null;
  querySelector(selector: string): StubElement | null;
  querySelectorAll(selector: string): StubElement[];
}

const makeDocument = (payloadText: string, options: {
  tabs?: string[];
  panes?: string[];
  notice?: boolean;
  graphPane?: boolean;
} = {}): StubDocument => {
  const tabs = (options.tabs ?? ['graph', 'text']).map(tab => makeElement({ callChainTab: tab }));
  const panes = (options.panes ?? ['graph', 'text']).map(pane => makeElement({ callChainPane: pane }));
  const notice = options.notice === false ? null : makeElement();
  // 真实面板的 notice 由服务端 HTML 带 hidden 属性出场
  if (notice) {
    notice.hidden = true;
  }
  const graphPane = options.graphPane === false ? null : panes.find(pane => pane.dataset.callChainPane === 'graph') ?? null;
  const document: StubDocument = {
    payload: makeElement({}, payloadText),
    notice,
    tabs,
    panes,
    getElementById(id: string): StubElement | null {
      if (id === 'call-chain-payload') return document.payload;
      if (id === 'call-chain-notice') return document.notice;
      return null;
    },
    querySelector(selector: string): StubElement | null {
      return selector === '[data-call-chain-pane="graph"]' ? graphPane : null;
    },
    querySelectorAll(selector: string): StubElement[] {
      if (selector === '[data-call-chain-tab]') return tabs;
      if (selector === '[data-call-chain-pane]') return panes;
      return [];
    }
  };
  return document;
};

interface StubWindow {
  posted: unknown[];
  messageListeners: Array<(event: { data?: unknown }) => void>;
  acquireVsCodeApi?(): { postMessage(message: unknown): void };
}

const makeWindow = (withVsCodeApi = true): StubWindow => {
  const stub: StubWindow = {
    posted: [],
    messageListeners: [],
    addEventListener(_type: string, listener: (event: { data?: unknown }) => void): void {
      stub.messageListeners.push(listener);
    }
  };
  if (withVsCodeApi) {
    stub.acquireVsCodeApi = () => ({
      postMessage(message: unknown): void {
        stub.posted.push(message);
      }
    });
  }
  return stub;
};

let document_: StubDocument;

const globals = globalThis as unknown as { document?: unknown; window?: unknown; mermaid?: unknown };

/** viewer 的 activate() 有 await,微任务排队后用 setImmediate 一次排干 */
const waitForActivation = async (): Promise<void> => {
  await new Promise(resolve => setImmediate(resolve));
};

const importViewer = async (): Promise<void> => {
  vi.resetModules();
  await import('../src/webview/defCallChainViewer');
  await waitForActivation();
};

describe('defCallChainViewer(webview 装配面)', () => {
  afterEach(() => {
    delete globals.document;
    delete globals.window;
    delete globals.mermaid;
  });

  it('渲染成功:注入 svg、按 payload 选初始 tab,点击/消息切换并 postMessage', async () => {
    const payload = {
      mermaid: 'flowchart TD\n    A --> B',
      text: 'A --cell--> B',
      configView: 'graph',
      storedTab: null
    };
    document_ = makeDocument(JSON.stringify(payload), { tabs: ['graph', 'text', 'bogus'] });
    const window_ = makeWindow();
    const initialize = vi.fn();
    const render = vi.fn(async () => ({ svg: '<svg>chain</svg>' }));
    globals.document = document_;
    globals.window = window_;
    globals.mermaid = { initialize, render };

    await importViewer();

    // tiny 发行面钉 dagre + strict CSP 口径
    expect(initialize).toHaveBeenCalledWith({
      startOnLoad: false,
      securityLevel: 'strict',
      theme: 'dark',
      layout: 'dagre'
    });
    expect(render).toHaveBeenCalledWith('kbengine-call-chain-graph', payload.mermaid);
    expect(document_.panes[0].innerHTML).toBe('<svg>chain</svg>');

    // 初始 tab:storedTab 空 → configView(graph)
    expect(document_.tabs[0].attributes['aria-selected']).toBe('true');
    expect(document_.tabs[1].attributes['aria-selected']).toBe('false');
    expect(document_.panes[0].hidden).toBe(false);
    expect(document_.panes[1].hidden).toBe(true);
    expect(document_.notice?.hidden).toBe(true);

    // 点击 Text:切换 + 通知宿主
    document_.tabs[1].click();
    expect(document_.tabs[1].attributes['aria-selected']).toBe('true');
    expect(document_.tabs[0].attributes['aria-selected']).toBe('false');
    expect(document_.panes[1].hidden).toBe(false);
    expect(document_.panes[0].hidden).toBe(true);
    expect(window_.posted).toEqual([{ type: 'callChainTab', tab: 'text' }]);

    // 未知 tab 值的按钮:normalize 落 null,零动作
    document_.tabs[2].click();
    expect(document_.tabs[1].attributes['aria-selected']).toBe('true');
    expect(window_.posted).toHaveLength(1);

    // 宿主消息切回 graph;未知值/无关消息忽略
    window_.messageListeners[0]({ data: { type: 'callChainTab', tab: 'graph' } });
    expect(document_.tabs[0].attributes['aria-selected']).toBe('true');
    window_.messageListeners[0]({ data: { type: 'callChainTab', tab: 'diagram' } });
    expect(document_.tabs[0].attributes['aria-selected']).toBe('true');
    window_.messageListeners[0]({ data: { type: 'other' } });
    expect(document_.tabs[0].attributes['aria-selected']).toBe('true');
  });

  it('渲染抛错:自动回落 Text,面板头给出带原因的说明', async () => {
    const payload = { mermaid: 'flowchart TD', text: 'A', configView: 'graph', storedTab: null };
    document_ = makeDocument(JSON.stringify(payload));
    const window_ = makeWindow();
    globals.document = document_;
    globals.window = window_;
    globals.mermaid = {
      initialize: vi.fn(),
      render: vi.fn(async () => {
        throw new Error('Parse error');
      })
    };

    await importViewer();

    expect(document_.notice?.hidden).toBe(false);
    expect(document_.notice?.textContent).toBe('Graph render failed (Parse error); showing text view instead.');
    expect(document_.panes[1].hidden).toBe(false);
    expect(document_.panes[0].hidden).toBe(true);
    expect(document_.panes[0].innerHTML).toBe('');
  });

  it('mermaid 全局缺失:同样回落 Text;无 notice 元素/无 acquireVsCodeApi 也不崩', async () => {
    const payload = { mermaid: 'flowchart TD', text: 'A', configView: 'graph', storedTab: 'graph' };
    // 无 notice 元素(showNotice 判空跳过)+ 无 acquireVsCodeApi(postTab 静默跳过)
    document_ = makeDocument(JSON.stringify(payload), { notice: false });
    const window_ = makeWindow(false);
    globals.document = document_;
    globals.window = window_;
    delete globals.mermaid;

    await importViewer();

    expect(document_.panes[1].hidden).toBe(false);
    expect(document_.panes[0].hidden).toBe(true);

    // 点击仍可切换,只是不 postMessage
    document_.tabs[0].click();
    expect(document_.tabs[0].attributes['aria-selected']).toBe('true');
    expect(document_.panes[0].hidden).toBe(false);
    expect(window_.posted).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// defCallChain:同名多候选收窄 / 方法块缺失 / 默认读取器 mtime 缓存
// ---------------------------------------------------------------------------

const HERO_DEF = '/tmp/proj/scripts/entity_defs/Hero.def';
const HERO_PY = '/tmp/proj/scripts/base/Hero.py';
const HERO_PY_TEXT = 'class Hero:\n    def start(self):\n        self.cell.move(1)\n';

const mkDefinition = (name: string, section: string, line: number, file = HERO_DEF) => ({
  defFile: file,
  line,
  section,
  exposed: false,
  owner: { kind: 'entity', name: 'Hero', filePath: file, line: 1 },
  declaredArgs: ['UINT32'],
  identity: {
    ownerKind: 'entity',
    ownerName: 'Hero',
    sourceKind: 'local',
    sourceChain: ['Hero'],
    section,
    symbolName: name
  }
});

const mkPythonMethod = (filePath: string, methodName: string, section: string) => ({
  filePath,
  methodName,
  line: 1,
  character: 4,
  endLine: 3,
  calls: [],
  binding: {
    pythonFile: filePath,
    identity: {
      ownerKind: 'entity',
      ownerName: 'Hero',
      sourceKind: 'local',
      sourceChain: ['Hero'],
      section,
      symbolName: methodName
    }
  }
});

const mkIndex = (
  methodDefinitions: EntityMappingIndex['methodDefinitions'],
  pythonMethods: EntityMappingIndex['pythonMethods']
): EntityMappingIndex => ({
  rootName: 'Hero',
  rootCategory: 'entity',
  rootDefFile: HERO_DEF,
  semantics: {} as EntityMappingIndex['semantics'],
  propertyDefinitions: [],
  methodDefinitions,
  pythonOwnerFiles: [],
  pythonMethods
});

describe('defCallChain 补测(收窄/缺失方法块/默认读取器)', () => {
  let temporaryRoot = '';

  beforeEach(() => {
    temporaryRoot = mkdtempSync(join(tmpdir(), 'cov-defchain-'));
    clearDefCallChainFileCache();
  });

  afterEach(() => {
    rmSync(temporaryRoot, { recursive: true, force: true });
    clearDefCallChainFileCache();
  });

  it('同名多候选:按起点文件收窄;无同文件命中保持原序取首个', () => {
    const defA = '/tmp/proj/scripts/entity_defs/A.def';
    const defB = '/tmp/proj/scripts/entity_defs/B.def';
    const defC = '/tmp/proj/scripts/entity_defs/C.def';
    const index = mkIndex(
      [mkDefinition('start', 'BaseMethods', 2, defA), mkDefinition('start', 'BaseMethods', 4, defB)],
      []
    );

    // 行号不匹配任何候选 → 同文件收窄后回落该文件首个
    expect(findDefMethodByStart(index, { filePath: defB, line: 99, methodName: 'start' })?.defFile).toBe(defB);
    // 起点文件不在候选内 → 收窄无命中,保持原候选序
    expect(findDefMethodByStart(index, { filePath: defC, line: 99, methodName: 'start' })?.defFile).toBe(defA);
  });

  it('绑定方法在源文本中无对应方法块:该方法零出边', () => {
    const index = mkIndex([mkDefinition('start', 'BaseMethods', 1, HERO_PY)], [mkPythonMethod(HERO_PY, 'start', 'BaseMethods')]);
    const chain = buildDefCallChain(index, { filePath: HERO_PY, line: 1, methodName: 'start' }, {
      depth: 2,
      // 索引说有方法,盘上文本却没有(索引过期面):receiverCallsInMethod 空手而归
      readPythonFile: () => 'class Hero:\n    pass\n'
    });
    expect(chain?.nodes).toHaveLength(1);
    expect(chain?.edges).toEqual([]);
  });

  it('默认读取器走真实盘读 + mtime 缓存:两次构建同边,第二次命中缓存', () => {
    const pyFile = join(temporaryRoot, 'scripts', 'base', 'Hero.py');
    mkdirSync(join(temporaryRoot, 'scripts', 'base'), { recursive: true });
    writeFileSync(pyFile, HERO_PY_TEXT);
    const index = mkIndex(
      [mkDefinition('start', 'BaseMethods', 2), mkDefinition('move', 'CellMethods', 2)],
      [mkPythonMethod(pyFile, 'start', 'BaseMethods')]
    );

    const first = buildDefCallChain(index, { filePath: pyFile, line: 2, methodName: 'start' }, { depth: 1 });
    expect(first?.edges.map(edge => `${edge.from}>${edge.to}:${edge.receiver}`)).toEqual([
      'Hero:BaseMethods:start>Hero:CellMethods:move:cell'
    ]);

    const second = buildDefCallChain(index, { filePath: pyFile, line: 2, methodName: 'start' }, { depth: 1 });
    expect(second?.edges).toEqual(first?.edges);
    expect(second?.nodes.map(node => node.methodName)).toContain('move');
  });
});

// ---------------------------------------------------------------------------
// defCallChainProvider:code lens 装配 / 命令消息面 / 全链文本 / nonce 回退
// ---------------------------------------------------------------------------

describe('defCallChainProvider 补测', () => {
  const managers: EntityMappingManager[] = [];
  const controllers: CallChainController[] = [];
  const roots: string[] = [];
  const originalQuickPick = stubWindow.showQuickPick;

  const newManager = (indexFor: (pythonFile: string) => unknown): EntityMappingManager => {
    const manager = new EntityMappingManager({ subscriptions: [] });
    managers.push(manager);
    return new Proxy(manager, {
      get(target, property, receiver) {
        if (property === 'getIndexForPythonFile') return (pythonFile: string) => indexFor(pythonFile);
        if (property === 'waitForInitialScan') return async () => undefined;
        return Reflect.get(target, property, receiver);
      }
    }) as EntityMappingManager;
  };

  const newController = (manager: EntityMappingManager): CallChainController => {
    const controller = new CallChainController(manager);
    controllers.push(controller);
    return controller;
  };

  beforeEach(() => {
    messages.info.length = 0;
  });

  afterEach(() => {
    controllers.splice(0).forEach(controller => controller.dispose());
    managers.splice(0).forEach(manager => manager.dispose());
    delete (stubWindow as { activeTextEditor?: unknown }).activeTextEditor;
    stubWindow.showQuickPick = originalQuickPick;
    roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true }));
    configurationOverrides.delete('kbengine.python');
    panelRegistry.reset();
  });

  it('provideCodeLenses:已索引方法出 lens,未登记方法跳过', async () => {
    const manager = new EntityMappingManager({ subscriptions: [] });
    managers.push(manager);
    manager.resolveMethodDefinition = async (_file: string, methodName: string) =>
      (methodName === 'start' ? { section: 'BaseMethods' } : null) as never;
    const controller = newController(manager);
    const document = makeTextDocument(
      'class Hero:\n    def start(self):\n        pass\n\n    def ghost(self):\n        pass\n',
      { fileName: HERO_PY, languageId: 'python' }
    );

    const lenses = await controller.provideCodeLenses(document as never);
    expect(lenses).toHaveLength(1);
    const lens = lenses[0] as unknown as {
      range: { start: { line: number; character: number } };
      command: { title: string; command: string; arguments: unknown[] };
    };
    expect(lens.range.start.line).toBe(1);
    expect(lens.range.start.character).toBe(8);
    expect(lens.command.title).toBe('Call Chain');
    expect(lens.command.command).toBe('kbengine.python.showCallChain');
    expect(lens.command.arguments).toEqual([document.uri, 2, 'start']);
  });

  it('无参无编辑器:提示打开 Python 实体脚本', async () => {
    const controller = newController(newManager(() => null));
    await controller.showForActiveEditor();
    expect(messages.info).toContain('Open a Python entity script to show a call chain');
  });

  it('活动编辑器无 def 声明:pickMethod 空手,同上提示', async () => {
    const controller = newController(newManager(() => null));
    stubWindow.activeTextEditor = {
      document: makeTextDocument('class Hero:\n    pass\n', { fileName: HERO_PY, languageId: 'python' })
    } as never;
    await controller.showForActiveEditor();
    expect(messages.info).toContain('Open a Python entity script to show a call chain');
  });

  it('声明存在但都未登记:def 列表过滤后空,同上提示', async () => {
    const manager = newManager(() => null);
    manager.resolveMethodDefinition = async () => null as never;
    const controller = newController(manager);
    stubWindow.activeTextEditor = {
      document: makeTextDocument('class Hero:\n    def start(self):\n        pass\n', {
        fileName: HERO_PY,
        languageId: 'python'
      })
    } as never;
    await controller.showForActiveEditor();
    expect(messages.info).toContain('Open a Python entity script to show a call chain');
  });

  it('首扫后仍无索引:提示无实体映射', async () => {
    const controller = newController(newManager(() => null));
    await controller.showForActiveEditor(Uri.file(HERO_PY), 2, 'start');
    expect(messages.info).toContain('No entity mapping found for Hero.py');
  });

  it('索引有但起点方法未登记:提示非索引实体方法', async () => {
    const index = mkIndex([mkDefinition('move', 'CellMethods', 2)], []);
    const controller = newController(newManager(() => index));
    await controller.showForActiveEditor(Uri.file(HERO_PY), 2, 'start');
    expect(messages.info).toContain('start is not an indexed entity def method');
  });

  it('编辑器单方法 + 首扫后索引到位:建面板,文本链含边', async () => {
    const temporaryRoot = mkdtempSync(join(tmpdir(), 'cov-chain-provider-'));
    roots.push(temporaryRoot);
    const pyFile = join(temporaryRoot, 'scripts', 'base', 'Hero.py');
    mkdirSync(join(temporaryRoot, 'scripts', 'base'), { recursive: true });
    writeFileSync(pyFile, HERO_PY_TEXT);
    const index = mkIndex(
      [mkDefinition('start', 'BaseMethods', 2), mkDefinition('move', 'CellMethods', 2)],
      [mkPythonMethod(pyFile, 'start', 'BaseMethods')]
    );

    // 首查缺失 → 等首扫 → 复查命中(走 withInitialScanTimeout 复查面)
    let indexCalls = 0;
    const manager = newManager(() => {
      indexCalls += 1;
      return indexCalls === 1 ? null : index;
    });
    manager.resolveMethodDefinition = async () => ({ section: 'BaseMethods' }) as never;
    const controller = newController(manager);
    stubWindow.activeTextEditor = {
      document: makeTextDocument(HERO_PY_TEXT, { fileName: pyFile, languageId: 'python' })
    } as never;

    await controller.showForActiveEditor();
    expect(indexCalls).toBe(2);
    expect(panelRegistry.panels).toHaveLength(1);
    const html = panelRegistry.panels[0].webview.html;
    // chainText 的边行(兜底文本视图可见;'>' 经 escapeHtml 成 &gt;)
    expect(html).toContain('Hero:BaseMethods:start --cell--&gt; CellMethods.move(UINT32)');
    expect(html).toContain('CellMethods.move');
  });

  it('宿主无 crypto.getRandomValues:nonce 走 Math.random 回退仍为 32 位十六进制', async () => {
    const temporaryRoot = mkdtempSync(join(tmpdir(), 'cov-chain-nonce-'));
    roots.push(temporaryRoot);
    const pyFile = join(temporaryRoot, 'scripts', 'base', 'Hero.py');
    mkdirSync(join(temporaryRoot, 'scripts', 'base'), { recursive: true });
    writeFileSync(pyFile, HERO_PY_TEXT);
    const index = mkIndex(
      [mkDefinition('start', 'BaseMethods', 2), mkDefinition('move', 'CellMethods', 2)],
      [mkPythonMethod(pyFile, 'start', 'BaseMethods')]
    );
    const controller = newController(newManager(() => index));

    const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
    Object.defineProperty(globalThis, 'crypto', { value: undefined, configurable: true });
    try {
      await controller.showForActiveEditor(Uri.file(pyFile), 2, 'start');
      const html = panelRegistry.panels[0].webview.html;
      expect(/'nonce-([0-9a-f]{32})'/.exec(html)?.[1]).toBeTruthy();
    } finally {
      if (descriptor) {
        Object.defineProperty(globalThis, 'crypto', descriptor);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// defParamInlayHints:切参的引号/嵌套/转义面 + provider 视口/异常面
// ---------------------------------------------------------------------------

const CELL_FILE = '/proj/assets/scripts/cell/avatar.py';

describe('defParamInlayHints 补测', () => {
  const managers: EntityMappingManager[] = [];

  afterEach(() => {
    managers.splice(0).forEach(manager => manager.dispose());
    configurationOverrides.delete('kbengine');
  });

  it('splitParams:引号/圆括号/方括号/花括号内的逗号不切分,列位如实', () => {
    const text = [
      'class Avatar:',
      '    def quirk(self, a="x,y", b=(1,2), c=[u], d={1:2}):',
      '        pass',
      ''
    ].join('\n');
    const sites = findDefParamSites(text, CELL_FILE);
    expect(sites).toHaveLength(1);
    const [site] = sites;
    // self 剔除后四参;引号里的 ',' 与三类括号内的 ',' 都不是边界
    expect(site.params.map(param => param.name)).toEqual(['a', 'b', 'c', 'd']);
    expect(site.params.map(param => param.start)).toEqual([20, 29, 38, 45]);
    expect(site.closeParenCharacter).toBe(52);
    expect(site.params.every(param => !param.hasAnnotation && !param.isStar)).toBe(true);
  });

  it('splitParams:转义引号不提前闭合字符串,后续形参不丢', () => {
    const text = [
      'class Avatar:',
      '    def esc(self, a="x\\"y", b):',
      '        pass',
      ''
    ].join('\n');
    const [site] = findDefParamSites(text, CELL_FILE);
    expect(site.params.map(param => param.name)).toEqual(['a', 'b']);
  });

  it('provideInlayHints:视图口外的定义行不出;resolve 抛错按无声明处理', async () => {
    const manager = new EntityMappingManager({ subscriptions: [] });
    managers.push(manager);
    manager.resolveMethodDefinition = async () => {
      throw new Error('index gone');
    };
    const provider = new DefParamInlayHintsProvider(manager);
    const document = makeTextDocument('class Avatar:\n    def lone(self, a):\n        pass\n', {
      fileName: CELL_FILE,
      languageId: 'python'
    });

    // 定义行 1 不在 [0,0] 视口内 → 跳过(不触发解析)
    expect(await provider.provideInlayHints(document as never, new Range(new Position(0, 0), new Position(0, 0)) as never)).toEqual([]);
    // 视口覆盖 → resolveMethodDefinition 抛错被吞为 null → 无声明不出
    expect(await provider.provideInlayHints(document as never, new Range(new Position(0, 0), new Position(9, 0)) as never)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// defReferenceGraph:接口/组件引用边 + 畸形与不可读 .def 的跳过面
// ---------------------------------------------------------------------------

const runsAsRoot = (process.getuid?.() ?? -1) === 0;

describe('defReferenceGraph 补测(接口/组件边与坏文件跳过)', () => {
  let root = '';

  const put = (relative: string, content: string): string => {
    const target = join(root, ...relative.split('/'));
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content, 'utf8');
    return target;
  };

  afterEach(() => {
    // 权限用例的恢复:mode-000 目录不恢复无法 rm(mode-000 文件本身可 unlink,一并恢复)
    try {
      chmodSync(join(root, 'scripts', 'entity_defs', 'locked'), 0o755);
    } catch {
      /* 本用例无 locked 目录 */
    }
    try {
      chmodSync(join(root, 'scripts', 'entity_defs', 'B.def'), 0o644);
    } catch {
      /* 本用例无 B.def */
    }
    rmSync(root, { recursive: true, force: true });
  });

  it('Interfaces/Components 引用解析为 interface/component 边;畸形 .def 被跳过', () => {
    root = mkdtempSync(join(tmpdir(), 'cov-defgraph-'));
    put('scripts/entities.xml', '<root/>\n');
    put('scripts/entity_defs/Hero.def', [
      '<root>',
      '  <Interfaces>',
      '    <interface> ICombat </interface>',
      '  </Interfaces>',
      '  <Components>',
      '    <motor>',
      '      <Type> Motor </Type>',
      '    </motor>',
      '  </Components>',
      '  <BaseMethods>',
      '    <move> <Arg> UINT8 </Arg> </move>',
      '  </BaseMethods>',
      '</root>'
    ].join('\n'));
    put('scripts/entity_defs/interfaces/ICombat.def', [
      '<root>',
      '  <BaseMethods>',
      '    <ping/>',
      '  </BaseMethods>',
      '</root>'
    ].join('\n'));
    put('scripts/entity_defs/components/Motor.def', [
      '<root>',
      '  <BaseMethods>',
      '    <spin/>',
      '  </BaseMethods>',
      '</root>'
    ].join('\n'));
    // 未闭合元素:parseDefDocument 抛错 → parseDef 吞为 null → 整文件不进索引
    put('scripts/entity_defs/Broken.def', '<root>\n  <BaseMethods>\n    <move>\n</root>');

    const graph = buildDefReferenceGraphFromFile(join(root, 'scripts', 'entity_defs', 'Hero.def'));
    expect(graph).not.toBeNull();

    const relations = graph!.edges.map(edge => ({
      target: edge.target.split('/').pop(),
      relation: edge.relation
    }));
    expect(relations).toContainEqual({ target: 'ICombat.def', relation: 'interface' });
    expect(relations).toContainEqual({ target: 'Motor.def', relation: 'component' });

    const owners = graph!.definitions.map(definition => definition.ownerName);
    expect(owners).toContain('Hero');
    expect(owners).toContain('ICombat');
    expect(owners).toContain('Motor');
    expect(owners).not.toContain('Broken');
    // 坏文件不产生悬空误报(根本没进索引)
    expect(graph!.issues.map(issue => issue.name)).not.toContain('Broken');
  });

  describe.skipIf(runsAsRoot)('只读失败面(root 下 chmod 不生效,跳过)', () => {
    it('不可读 .def:readFile 吞错为 null,整文件跳过', () => {
      root = mkdtempSync(join(tmpdir(), 'cov-defgraph-perm-'));
      put('scripts/entities.xml', '<root/>\n');
      // 可达性说明:definitions 只保留进了连通分量的文件,Base 把 A/B 都挂进图
      put('scripts/entity_defs/Base.def', '<root>\n  <BaseMethods>\n    <root/>\n  </BaseMethods>\n</root>\n');
      put('scripts/entity_defs/A.def', '<root>\n  <Parent> Base </Parent>\n  <BaseMethods>\n    <go/>\n  </BaseMethods>\n</root>\n');
      const bDef = put('scripts/entity_defs/B.def', '<root>\n  <Parent> Base </Parent>\n  <BaseMethods>\n    <halt/>\n  </BaseMethods>\n</root>\n');
      chmodSync(bDef, 0o000);

      const graph = buildDefReferenceGraphFromFile(join(root, 'scripts', 'entity_defs', 'A.def'));
      const owners = graph!.definitions.map(definition => definition.ownerName);
      expect(owners).toContain('A');
      // B 若可读会经 Parent 进图;缺席即证明读失败被吞、整文件跳过
      expect(owners).not.toContain('B');
    });

    it('不可读子目录:readdir 吞错返回,目录整体跳过不炸', () => {
      root = mkdtempSync(join(tmpdir(), 'cov-defgraph-dir-'));
      put('scripts/entities.xml', '<root/>\n');
      put('scripts/entity_defs/Base.def', '<root>\n  <BaseMethods>\n    <root/>\n  </BaseMethods>\n</root>\n');
      put('scripts/entity_defs/A.def', '<root>\n  <Parent> Base </Parent>\n  <BaseMethods>\n    <go/>\n  </BaseMethods>\n</root>\n');
      put('scripts/entity_defs/locked/C.def', '<root>\n  <Parent> Base </Parent>\n  <BaseMethods>\n    <hidden/>\n  </BaseMethods>\n</root>\n');
      chmodSync(join(root, 'scripts', 'entity_defs', 'locked'), 0o000);

      const graph = buildDefReferenceGraphFromFile(join(root, 'scripts', 'entity_defs', 'A.def'));
      const owners = graph!.definitions.map(definition => definition.ownerName);
      expect(owners).toContain('A');
      expect(owners).not.toContain('C');
    });
  });
});
