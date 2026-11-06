import { readFileSync } from 'fs';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import {
  deriveHotReloadGlob,
  deriveWatcherPattern,
  planHotReloadWatch,
  readHotReloadSettings,
  setupHotReload,
  type HotReloadTimerDeps
} from '../src/hotReload';
import {
  HotReloadStatusController,
  type OutputChannelLike,
  type StatusBarItemLike
} from '../src/hotReloadStatus';
import {
  createFileChangeRouter,
  registerRustFileChangeConsumer,
  type NonPythonChangeEvent
} from '../src/fileChangeBypass';
import { KodeCoreGate, type ShadowClientLike } from '../src/kodeCoreGate';
import { resetScanRootCache, setActiveProfileScanRoot } from '../src/scanRoots';
import {
  allFileSystemWatchers,
  configurationOverrides,
  workspaceEvents
} from './helpers/vscodeStub';
import { RelativePattern, Uri } from './fake-vscode/core';

// 热更 watcher 默认只监控 assetsRoot(docs/design/hot-reload-design.md §11.1/§11.4):
// ① 未写 globs → 从 assetsRoot 派生 `<assetsRoot>/**/*.py`,绝不回落裸 `**/*.py`
//    全工作区扫描(旧回落会把 site-packages/out 一并盯上);
// ② 拿不到有效 assetsRoot → 显式报错(状态栏 ready-with-error + 补救诊断),
//    不静默全扫;
// ③ 显式 globs 原样生效(source=explicit,不被派生覆盖);
// ④ assetsRoot/派生值变更 → 重建 watcher(§11.4);
// ⑤ 非 py 变化只进旁路通道:零投递、零状态跃迁(见 fileChangeBypass.test.ts)。

const READY_FACE = '$(eye) 热更: 就绪';
const OFF_FACE = '$(eye-closed) 热更: 关';
const ERROR_FACE = '$(warning) 热更: 就绪(未监视)';

const makeTimers = (): {
  timers: HotReloadTimerDeps;
  pending: () => number;
  tick: () => number;
} => {
  const handles = new Map<unknown, () => void>();
  return {
    pending: () => handles.size,
    tick: () => {
      const callbacks = [...handles.values()];
      handles.clear();
      for (const callback of callbacks) {
        callback();
      }
      return callbacks.length;
    },
    timers: {
      set: (callback): unknown => {
        const handle = handles.size;
        handles.set(handle, callback);
        return handle;
      },
      clear: (handle): void => {
        handles.delete(handle);
      }
    }
  };
};

/** 排干节流窗(状态栏尾沿渲染):有界循环防挂死 */
const settle = (clock: { pending: () => number; tick: () => number }): void => {
  for (let guard = 0; guard < 8 && clock.pending() > 0; guard += 1) {
    clock.tick();
  }
};

/** 状态控制器假体:bar 文案 + 输出通道行,状态跃迁与日志都可断言 */
const makeStatus = (timers: HotReloadTimerDeps) => {
  const bar: StatusBarItemLike = {
    text: '',
    command: undefined,
    tooltip: '',
    show(): void {},
    hide(): void {},
    dispose(): void {}
  };
  const lines: string[] = [];
  const channel: OutputChannelLike = {
    appendLine: (line: string): void => {
      lines.push(line);
    },
    show(): void {},
    dispose(): void {}
  };
  const controller = new HotReloadStatusController({
    createStatusBarItem: () => bar,
    createOutputChannel: () => channel,
    registerCommand: () => ({ dispose: (): void => undefined }),
    timers,
    now: () => new Date(2026, 9, 27, 12, 34, 56).getTime()
  });
  return { controller, bar, lines };
};

const makeContext = (): vscode.ExtensionContext =>
  ({ subscriptions: [] }) as unknown as vscode.ExtensionContext;

/** RelativePattern 注册形态 → 可断言文本(base 是路径或 Uri 都吃) */
const patternText = (pattern: unknown): string => {
  if (pattern instanceof RelativePattern) {
    const base = pattern.base as { fsPath?: string } | string;
    const basePath = typeof base === 'string' ? base : (base.fsPath ?? String(base));
    return `${basePath}/${pattern.pattern}`;
  }
  return String(pattern);
};

const isRelativePattern = (pattern: unknown): pattern is RelativePattern =>
  pattern instanceof RelativePattern;

describe('派生 glob(§11.1 纯函数)', () => {
  it('assetsRoot 在工作区内 → ${workspaceFolder} 形态 + 正斜杠 + 限定 *.py', () => {
    expect(deriveHotReloadGlob('/ws/assets', '/ws')).toBe('${workspaceFolder}/assets/**/*.py');
    // 不是裸 `**/*.py` 全扫
    expect(deriveHotReloadGlob('/ws/assets', '/ws')).not.toBe('**/*.py');
    expect(deriveHotReloadGlob('/ws', '/ws')).toBe('${workspaceFolder}/**/*.py');
  });

  it('assetsRoot 在工作区外 → 绝对路径(反斜杠归一成正斜杠)', () => {
    expect(deriveHotReloadGlob('/data/kbe/assets', '/ws')).toBe('/data/kbe/assets/**/*.py');
    expect(deriveHotReloadGlob('C:\\kbe\\assets', 'C:\\kbe')).toBe('${workspaceFolder}/assets/**/*.py');
    expect(deriveHotReloadGlob('D:/kbe/assets', 'C:/kbe')).toBe('D:/kbe/assets/**/*.py');
  });

  it('assetsRoot 落空 → 空串(调用方按缺根报错,不回落全扫)', () => {
    expect(deriveHotReloadGlob('', '/ws')).toBe('');
    expect(deriveHotReloadGlob('   ', '/ws')).toBe('');
  });

  it('注册形态:工作区内锚工作区根,工作区外锚资产根本身(ACC-011 RelativePattern 口径)', () => {
    expect(deriveWatcherPattern('/ws/assets', '/ws', '**/*.py')).toEqual({
      base: '/ws',
      pattern: 'assets/**/*.py'
    });
    expect(deriveWatcherPattern('/ws/assets', '/ws', '**/*')).toEqual({
      base: '/ws',
      pattern: 'assets/**/*'
    });
    expect(deriveWatcherPattern('/data/kbe/assets', '/ws', '**/*.py')).toEqual({
      base: '/data/kbe/assets',
      pattern: '**/*.py'
    });
  });
});

describe('planHotReloadWatch(§11.1 决策表)', () => {
  it('未写 globs → 从 assetsRoot 派生,source=derived', () => {
    const plan = planHotReloadWatch({
      enabled: true,
      globs: [],
      globsSpec: 'unset',
      assetsRoot: '/ws/assets',
      workspaceRoot: '/ws'
    });
    expect(plan.source).toBe('derived');
    expect(plan.globs).toEqual(['${workspaceFolder}/assets/**/*.py']);
    expect(plan.globs).not.toEqual(['**/*.py']);
    expect(plan.watchOff).toBeNull();
    expect(plan.error).toBeNull();
  });

  it('拿不到 assetsRoot → 显式报错(不回落全扫)', () => {
    const plan = planHotReloadWatch({
      enabled: true,
      globs: [],
      globsSpec: 'unset',
      assetsRoot: '',
      workspaceRoot: '/ws'
    });
    expect(plan.error?.code).toBe('assets-root-missing');
    expect(plan.error?.message).toContain('kbengine.assetsRoot');
    expect(plan.globs).toEqual([]);
    expect(plan.globs).not.toContain('**/*.py');
    expect(plan.source).toBe('none');
    expect(plan.watchOff).toBeNull();
  });

  it('显式 globs 原样生效(有 assetsRoot 也不被派生覆盖)', () => {
    const plan = planHotReloadWatch({
      enabled: true,
      globs: ['**/*.def'],
      globsSpec: 'explicit',
      assetsRoot: '/ws/assets',
      workspaceRoot: '/ws'
    });
    expect(plan.source).toBe('explicit');
    expect(plan.globs).toEqual(['**/*.def']);
    expect(plan.error).toBeNull();
    expect(plan.watchOff).toBeNull();
  });

  it('显式空数组 → watch-off(globs 为空),既不派生也不全扫', () => {
    const plan = planHotReloadWatch({
      enabled: true,
      globs: [],
      globsSpec: 'explicit',
      assetsRoot: '/ws/assets',
      workspaceRoot: '/ws'
    });
    expect(plan.watchOff).toBe('empty-globs');
    expect(plan.globs).toEqual([]);
    expect(plan.error).toBeNull();
    expect(plan.source).toBe('none');
  });

  it('关着就关着:disabled 优先,不因缺根报错', () => {
    expect(
      planHotReloadWatch({
        enabled: false,
        globs: [],
        globsSpec: 'unset',
        assetsRoot: '',
        workspaceRoot: '/ws'
      })
    ).toMatchObject({ watchOff: 'disabled', error: null, globs: [], source: 'none' });
    expect(
      planHotReloadWatch({
        enabled: false,
        globs: ['**/*.py'],
        globsSpec: 'explicit',
        assetsRoot: '',
        workspaceRoot: '/ws'
      })
    ).toMatchObject({ watchOff: 'disabled', error: null });
  });
});

describe('readHotReloadSettings globs 口径', () => {
  const readerOf = (values: Record<string, unknown>): {
    get: <T>(key: string, defaultValue: T) => T;
  } => ({
    get: <T>(key: string, defaultValue: T): T => (values[key] as T) ?? defaultValue
  });

  it('未写 globs → 空表 + spec=unset(交给派生,不回落裸全扫)', () => {
    // enabled 缺省为「开」是默认开启批(用户令 2026-11-06)的口径,本例只锁 globs 语义
    expect(readHotReloadSettings(readerOf({}))).toEqual({
      enabled: true,
      actionName: '',
      globs: [],
      globsSpec: 'unset',
      debounceMs: 500
    });
  });

  it('写了 globs → spec=explicit(空数组也算显式,保留 watch-off 语义)', () => {
    expect(readHotReloadSettings(readerOf({ globs: ['**/*.def'] }))).toMatchObject({
      globs: ['**/*.def'],
      globsSpec: 'explicit'
    });
    expect(readHotReloadSettings(readerOf({ globs: [] }))).toMatchObject({
      globs: [],
      globsSpec: 'explicit'
    });
    expect(readHotReloadSettings(readerOf({ globs: ['', '  ', 7] }))).toMatchObject({
      globs: [],
      globsSpec: 'explicit'
    });
  });

  it('类型写坏按未写处理(回落派生,不回落全扫)', () => {
    expect(readHotReloadSettings(readerOf({ globs: '**/*.py' }))).toMatchObject({
      globs: [],
      globsSpec: 'unset'
    });
  });
});

describe('装配(§11.1/§11.4 watcher 生命周期)', () => {
  let workspaceFoldersBackup: typeof vscode.workspace.workspaceFolders;
  let tmpDirs: string[] = [];
  let contexts: vscode.ExtensionContext[] = [];

  const makeFixture = (): { root: string; assets: string; assets2: string } => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-watcher-'));
    tmpDirs.push(root);
    const assets = path.join(root, 'assets');
    fs.mkdirSync(path.join(assets, 'scripts', 'base'), { recursive: true });
    fs.mkdirSync(path.join(assets, 'res'), { recursive: true });
    fs.writeFileSync(path.join(assets, 'scripts', 'base', 'Account.py'), 'class Account: pass\n');
    fs.writeFileSync(path.join(assets, 'res', 'types.xml'), '<root/>\n');
    const assets2 = path.join(root, 'assets2');
    fs.mkdirSync(path.join(assets2, 'scripts'), { recursive: true });
    fs.writeFileSync(path.join(assets2, 'scripts', 'B.py'), 'x = 1\n');
    vscode.workspace.workspaceFolders = [{ uri: Uri.file(root), name: 'fixture', index: 0 }];
    return { root, assets, assets2 };
  };

  /** 装一次装配并排干状态栏节流窗;登记 context 便于用例间释放 */
  const boot = (
    runAction: (name: string) => void,
    extra: { fileChangeRouter?: ReturnType<typeof createFileChangeRouter> } = {}
  ): {
    clock: ReturnType<typeof makeTimers>;
    status: ReturnType<typeof makeStatus>;
  } => {
    const clock = makeTimers();
    const status = makeStatus(clock.timers);
    const context = makeContext();
    contexts.push(context);
    setupHotReload(context, runAction, {
      timers: clock.timers,
      status: status.controller,
      fileChangeRouter: extra.fileChangeRouter
    });
    settle(clock);
    return { clock, status };
  };

  beforeEach(() => {
    configurationOverrides.clear();
    allFileSystemWatchers.length = 0;
    setActiveProfileScanRoot(null);
    resetScanRootCache();
    workspaceFoldersBackup = vscode.workspace.workspaceFolders;
    contexts = [];
  });

  afterEach(() => {
    // 释放本用例建的装配:否则它们的配置监听器会在后续 fireConfig 里各自重建
    // watcher,污染 allFileSystemWatchers 计数(共享替身的账)
    for (const context of contexts) {
      try {
        context.subscriptions[0]?.dispose();
      } catch {
        // 释放失败不掩盖用例本身的断言
      }
    }
    contexts = [];
    vscode.workspace.workspaceFolders = workspaceFoldersBackup;
    configurationOverrides.clear();
    setActiveProfileScanRoot(null);
    resetScanRootCache();
    for (const dir of tmpDirs) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
    tmpDirs = [];
  });

  it('未写 globs:一个 assetsRoot 全扩展名 watcher,py 走热更、非 py 走旁路', async () => {
    const { root, assets } = makeFixture();
    configurationOverrides.set('kbengine', {
      hotReload: { enabled: true, actionName: '热更', debounceMs: 10 },
      assetsRoot: assets
    });
    const router = createFileChangeRouter();
    const bypass: NonPythonChangeEvent[] = [];
    router.subscribe(event => bypass.push(event));
    const runCalls: string[] = [];
    const { clock, status } = boot(name => void runCalls.push(name), { fileChangeRouter: router });

    // 单一 watcher:assetsRoot 下全扩展名(同 py/非 py 同一事件源)
    expect(allFileSystemWatchers).toHaveLength(1);
    const watcher = allFileSystemWatchers[0];
    expect(isRelativePattern(watcher.pattern)).toBe(true);
    expect(patternText(watcher.pattern)).toBe(`${root}/assets/**/*`);

    // 状态栏如实显示派生 glob + 来源
    expect(status.bar.text).toBe(READY_FACE);
    expect(
      status.lines.some(line => line.includes('来源=derived') && line.includes('${workspaceFolder}/assets/**/*.py'))
    ).toBe(true);

    // py 变化 → 热更动作照常触发
    watcher.fireChange(Uri.file(path.join(assets, 'scripts', 'base', 'Account.py')));
    expect(clock.pending()).toBe(1);
    clock.tick();
    expect(runCalls).toEqual(['热更']);
  });

  it('非 py 变化只进旁路:零投递、零状态跃迁、日志如实记待路由', async () => {
    const { assets } = makeFixture();
    configurationOverrides.set('kbengine', {
      hotReload: { enabled: true, actionName: '热更', debounceMs: 10 },
      assetsRoot: assets
    });
    const router = createFileChangeRouter();
    const bypass: NonPythonChangeEvent[] = [];
    router.subscribe(event => bypass.push(event));
    const runCalls: string[] = [];
    const { clock, status } = boot(name => void runCalls.push(name), { fileChangeRouter: router });

    allFileSystemWatchers[0].fireChange(Uri.file(path.join(assets, 'res', 'types.xml')));

    await vi.waitFor(() => expect(bypass).toHaveLength(1));
    // 零投递:不排去抖、不触发动作
    expect(clock.pending()).toBe(0);
    expect(runCalls).toEqual([]);
    // 零状态跃迁:仍是就绪,没有发送中/已发送上屏
    expect(status.bar.text).toBe(READY_FACE);
    expect(status.lines.some(line => line.includes('触发:'))).toBe(false);
    // 如实记:N 个非 py 变化待路由(无消费者)
    expect(status.lines.some(line => line.includes('非 py 变化待路由') && line.includes('无消费者'))).toBe(true);
    expect(bypass[0]).toMatchObject({
      fileName: 'types.xml',
      ext: '.xml',
      kind: 'change',
      handledBy: 'unrouted'
    });
  });

  it('注册 rust 消费者:非 py 变化 → $/kode/fileChanged 走现有 LSP stdio(§11.3)', async () => {
    const { assets } = makeFixture();
    configurationOverrides.set('kbengine', {
      hotReload: { enabled: true, actionName: '热更', debounceMs: 10 },
      assetsRoot: assets
    });
    const router = createFileChangeRouter();
    const notes: Array<{ method: string; params?: unknown }> = [];
    const client = {
      start: vi.fn(async () => ({})),
      request: vi.fn(async () => ({})),
      notify: vi.fn((method: string, params?: unknown) => {
        notes.push({ method, params });
      }),
      dispose: vi.fn(async () => undefined)
    } as unknown as ShadowClientLike;
    const gate = new KodeCoreGate({ clientFactory: () => client });
    gate.setConfig({ backend: 'ts', serverPath: 'node:stub', shadowTimeoutMs: 500 });
    // 既有命令面把 client 拉活(生产同链路),通知面复用同一 stdio 进程
    await gate.runInRust('$/kode/echo', {});
    const registered = registerRustFileChangeConsumer(router, gate, { extensions: ['.xml'] });

    const runCalls: string[] = [];
    const { clock, status } = boot(name => void runCalls.push(name), { fileChangeRouter: router });

    allFileSystemWatchers[0].fireChange(Uri.file(path.join(assets, 'res', 'types.xml')));
    await vi.waitFor(() => expect(notes).toHaveLength(1));

    expect(notes[0].method).toBe('$/kode/fileChanged');
    expect(notes[0].params).toMatchObject({
      fsPath: path.join(assets, 'res', 'types.xml'),
      fileName: 'types.xml',
      ext: '.xml',
      kind: 'change',
      handledBy: 'rust',
      sha256: expect.any(String)
    });
    // 旁路不进热更:零去抖、零动作、状态不跃迁
    expect(clock.pending()).toBe(0);
    expect(runCalls).toEqual([]);
    expect(status.bar.text).toBe(READY_FACE);
    // 注册即接通,退订口可用
    registered.dispose();
    expect(router.consumers()).toHaveLength(0);
  });

  it('rust 进程未起:通知口静默降级不炸热更,也不为发通知拉起进程(§11.3)', async () => {
    const { assets } = makeFixture();
    configurationOverrides.set('kbengine', {
      hotReload: { enabled: true, actionName: '热更', debounceMs: 10 },
      assetsRoot: assets
    });
    const router = createFileChangeRouter();
    const factory = vi.fn();
    const gate = new KodeCoreGate({ clientFactory: factory });
    gate.setConfig({ backend: 'ts', serverPath: 'node:stub', shadowTimeoutMs: 500 });
    // 没有存活 client:通知口如实 false(静默降级)
    expect(gate.notifyFileChanged({ fsPath: '/x.xml' })).toBe(false);
    registerRustFileChangeConsumer(router, gate, { extensions: ['.xml'] });
    const bypass: NonPythonChangeEvent[] = [];
    router.subscribe(event => bypass.push(event));

    const runCalls: string[] = [];
    const { clock, status } = boot(name => void runCalls.push(name), { fileChangeRouter: router });

    expect(() =>
      allFileSystemWatchers[0].fireChange(Uri.file(path.join(assets, 'res', 'types.xml')))
    ).not.toThrow();
    await vi.waitFor(() => expect(bypass).toHaveLength(1));

    expect(factory).not.toHaveBeenCalled();
    expect(clock.pending()).toBe(0);
    expect(runCalls).toEqual([]);
    expect(status.bar.text).toBe(READY_FACE);
    // 有消费者命中:不再记「无消费者待路由」,但也没有任何成功宣称
    expect(status.lines.some(line => line.includes('非 py 变化待路由'))).toBe(false);
  });

  it('显式宽 glob:非 py/非 def 不进投递(只走旁路),.py/.def 仍在热更域(§11.2)', async () => {
    const { root, assets } = makeFixture();
    fs.mkdirSync(path.join(assets, 'entity_defs'), { recursive: true });
    fs.writeFileSync(path.join(assets, 'entity_defs', 'Avatar.def'), '<root/>\n');
    configurationOverrides.set('kbengine', {
      hotReload: { enabled: true, actionName: '热更', debounceMs: 10, globs: ['**/*'] },
      assetsRoot: assets
    });
    const router = createFileChangeRouter();
    const bypass: NonPythonChangeEvent[] = [];
    router.subscribe(event => bypass.push(event));
    const runCalls: string[] = [];
    const { clock, status } = boot(name => void runCalls.push(name), { fileChangeRouter: router });

    expect(allFileSystemWatchers).toHaveLength(2); // 显式 glob 面 + 旁路面
    const explicitWatcher = allFileSystemWatchers[0];
    const bypassWatcher = allFileSystemWatchers[1];

    // 显式 `**/*` 匹配到的 .xml:不进投递(引擎按模块重载,xml 无模块可发),
    // 不排去抖、不触发动作、状态不动
    explicitWatcher.fireChange(Uri.file(path.join(assets, 'res', 'types.xml')));
    expect(clock.pending()).toBe(0);
    expect(runCalls).toEqual([]);
    expect(status.bar.text).toBe(READY_FACE);
    expect(status.lines.some(line => line.includes('触发:'))).toBe(false);

    // 同一个 .xml 仍从旁路面照捕(旁路不因显式 globs 而失效)
    bypassWatcher.fireChange(Uri.file(path.join(assets, 'res', 'types.xml')));
    await vi.waitFor(() => expect(bypass).toHaveLength(1));
    expect(bypass[0]).toMatchObject({ ext: '.xml', handledBy: 'unrouted' });

    // .def 仍在热更域:确实进投递(会话首见无基线 → 结构闸保守不发,那是
    // IDE-HOT-005/REV-024 的口径,不是没进投递)
    explicitWatcher.fireChange(Uri.file(path.join(assets, 'entity_defs', 'Avatar.def')));
    expect(clock.pending()).toBe(1);
    clock.tick();
    expect(status.lines.some(line => line.includes('触发:') && line.includes('Avatar.def'))).toBe(true);
    expect(runCalls).toEqual([]);
    settle(clock); // 状态栏节流窗与去抖共用同一时钟:先排干再计下一发

    // .py 同样照常:不经闸,直接执行动作
    explicitWatcher.fireChange(Uri.file(path.join(assets, 'scripts', 'base', 'Account.py')));
    expect(clock.pending()).toBe(1);
    clock.tick();
    expect(runCalls).toEqual(['热更']);
  });

  it('缺 assetsRoot:ready-with-error + 补救诊断,不建 watcher 更不全扫', () => {
    const emptyRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-watcher-empty-'));
    tmpDirs.push(emptyRoot);
    vscode.workspace.workspaceFolders = [{ uri: Uri.file(emptyRoot), name: 'empty', index: 0 }];
    configurationOverrides.set('kbengine', {
      hotReload: { enabled: true, actionName: '热更', debounceMs: 10 }
    });
    const { status } = boot(() => undefined);

    expect(allFileSystemWatchers).toHaveLength(0);
    expect(status.bar.text).toBe(ERROR_FACE);
    expect(String(status.bar.tooltip)).toContain('kbengine.assetsRoot');
    expect(String(status.bar.tooltip)).not.toContain('**/*.py');
    expect(
      status.lines.some(line => line.includes('kbengine.assetsRoot') && line.includes('父目录'))
    ).toBe(true);
    expect(status.lines.some(line => line.includes('**/*.py'))).toBe(false);
  });

  it('关着:watch-off,提示区分「未配 assetsRoot」与「globs 为空」', () => {
    const emptyRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-watcher-off-'));
    tmpDirs.push(emptyRoot);
    vscode.workspace.workspaceFolders = [{ uri: Uri.file(emptyRoot), name: 'empty', index: 0 }];

    // 未配 assetsRoot(且未写 globs)的 watch-off 提示点名缺根
    configurationOverrides.set('kbengine', { hotReload: { enabled: false } });
    const first = boot(() => undefined);
    expect(first.status.bar.text).toBe(OFF_FACE);
    expect(String(first.status.bar.tooltip)).toContain('kbengine.assetsRoot');
    expect(String(first.status.bar.tooltip)).not.toContain('globs 为空');

    // 根配着(只是热更关着)时,不得把「没解析到根」当事实写上——缺根提示
    // 必须基于真解析出来的根,关着也不例外
    const validRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-watcher-offroot-'));
    tmpDirs.push(validRoot);
    configurationOverrides.set('kbengine', {
      hotReload: { enabled: false },
      assetsRoot: validRoot
    });
    const withRoot = boot(() => undefined);
    expect(withRoot.status.bar.text).toBe(OFF_FACE);
    expect(String(withRoot.status.bar.tooltip)).not.toContain('kbengine.assetsRoot');
    expect(withRoot.status.lines.some(line => line.includes('未开启: kbengine.hotReload.enabled=false'))).toBe(
      true
    );

    // 显式空 globs 的 watch-off 提示点名 globs 为空
    configurationOverrides.set('kbengine', {
      hotReload: { enabled: true, globs: [] },
      assetsRoot: path.join(emptyRoot, 'assets')
    });
    const second = boot(() => undefined);
    expect(second.status.bar.text).toBe(OFF_FACE);
    expect(String(second.status.bar.tooltip)).toContain('globs 为空');
    expect(allFileSystemWatchers).toHaveLength(0);
  });

  it('显式 globs 零回归:按用户模式建 watcher,来源 explicit;assetsRoot 在时另挂旁路', () => {
    const { root, assets } = makeFixture();
    configurationOverrides.set('kbengine', {
      hotReload: { enabled: true, actionName: '热更', globs: ['**/*.def'], debounceMs: 10 },
      assetsRoot: assets
    });
    const { status } = boot(() => undefined);

    expect(allFileSystemWatchers).toHaveLength(2);
    expect(allFileSystemWatchers[0].pattern).toBe('**/*.def');
    expect(isRelativePattern(allFileSystemWatchers[1].pattern)).toBe(true);
    expect(patternText(allFileSystemWatchers[1].pattern)).toBe(`${root}/assets/**/*`);
    expect(status.lines.some(line => line.includes('来源=explicit') && line.includes('**/*.def'))).toBe(true);
    expect(status.bar.text).toBe(READY_FACE);
  });

  it('§11.4 assetsRoot 变更 → 重建 watcher(旧的 dispose,新的锚新根)', () => {
    const { assets, assets2 } = makeFixture();
    configurationOverrides.set('kbengine', {
      hotReload: { enabled: true, actionName: '热更', debounceMs: 10 },
      assetsRoot: assets
    });
    boot(() => undefined);
    const first = allFileSystemWatchers[0];
    let firstDisposed = 0;
    first.dispose = (): void => {
      firstDisposed += 1;
    };

    configurationOverrides.set('kbengine', {
      hotReload: { enabled: true, actionName: '热更', debounceMs: 10 },
      assetsRoot: assets2
    });
    workspaceEvents.configurationChanged.fire({
      affectsConfiguration: (section: string) => section === 'kbengine'
    });

    expect(firstDisposed).toBe(1);
    expect(allFileSystemWatchers).toHaveLength(2);
    const second = allFileSystemWatchers[1];
    expect(second).not.toBe(first);
    expect(patternText(second.pattern)).toContain('/assets2/');
  });

  it('§11.4 派生值变了也要重建(事件不认 kbengine 段也认计划签名)', () => {
    const { assets, assets2 } = makeFixture();
    configurationOverrides.set('kbengine', {
      hotReload: { enabled: true, actionName: '热更', debounceMs: 10 },
      assetsRoot: assets
    });
    boot(() => undefined);
    const first = allFileSystemWatchers[0];

    // 派生输入变了(assetsRoot),但事件谎称不涉及 kbengine 段 → 仍须重建
    configurationOverrides.set('kbengine', {
      hotReload: { enabled: true, actionName: '热更', debounceMs: 10 },
      assetsRoot: assets2
    });
    workspaceEvents.configurationChanged.fire({ affectsConfiguration: () => false });
    expect(allFileSystemWatchers).toHaveLength(2);
    expect(patternText(allFileSystemWatchers[1].pattern)).toContain('/assets2/');

    // 没有变化的非 kbengine 配置事件不碰 watcher(既有口径)
    const stable = allFileSystemWatchers[1];
    workspaceEvents.configurationChanged.fire({ affectsConfiguration: () => false });
    expect(allFileSystemWatchers).toHaveLength(2);
    expect(allFileSystemWatchers[1]).toBe(stable);
    expect(allFileSystemWatchers[0]).toBe(first);
  });
});

describe('设置文档对账(中英)', () => {
  const root = path.resolve(__dirname, '..');
  const read = (relative: string): string => readFileSync(path.join(root, relative), 'utf8');
  const pkg = JSON.parse(read('package.json')) as {
    contributes: { configuration: Record<string, unknown> | Array<{ properties: Record<string, unknown> }> };
  };
  const globsProperty = (): Record<string, unknown> => {
    const configuration = pkg.contributes.configuration;
    const properties = Array.isArray(configuration)
      ? Object.assign({}, ...configuration.map(section => section.properties))
      : (configuration as Record<string, Record<string, unknown>>).properties;
    return properties['kbengine.hotReload.globs'] as Record<string, unknown>;
  };

  it('package.json 不再把 `["**/*.py"]` 当默认(未设才派生)', () => {
    expect(globsProperty()).not.toHaveProperty('default', ['**/*.py']);
    expect(JSON.stringify(globsProperty()['default'] ?? null)).not.toContain('**/*.py');
  });

  it('中英配置指南与 features 表都改成「未设按 assetsRoot 派生」', () => {
    for (const doc of [
      'docs/guide/configuration.md',
      'docs/zh/guide/configuration.md',
      'docs/features.md',
      'docs/zh/features.md'
    ]) {
      const text = read(doc);
      const row = text.split('\n').find(line => line.startsWith('| `kbengine.hotReload.globs`'));
      expect(row, `${doc} 应有 hotReload.globs 行`).toBeDefined();
      expect(row, `${doc} 不应再记默认 ["**/*.py"]`).not.toContain('`["**/*.py"]`');
      expect(row, `${doc} 应点名按 assetsRoot 派生`).toContain('assetsRoot');
    }
  });

  it('设计文档落了 §11.1(派生+缺根报错)与 §11.4(变更重建)', () => {
    const design = read('docs/design/hot-reload-design.md');
    expect(design).toContain('### 11.1');
    expect(design).toContain('### 11.4');
    expect(design).toMatch(/11\.1[\s\S]{0,600}assetsRoot/);
  });

  it('设计文档逐字引了状态面字面量与 §11.3 注册口(不许只写概念)', () => {
    const design = read('docs/design/hot-reload-design.md');
    // 状态/日志字面量:生产 emit 什么,文档就写什么(与测试断言同一串)
    expect(design).toContain('来源=<explicit|derived>');
    expect(design).toContain('未开启: kbengine.hotReload.enabled=false');
    expect(design).toContain('未开启: kbengine.hotReload.globs 为空');
    expect(design).toContain('监视范围不可用: <缺根补救文案>');
    // §11.3 的生产接线口与通知帧
    expect(design).toContain('registerFileChangeConsumer');
    expect(design).toContain('$/kode/fileChanged');
    // 中英配置指南也点了旁路通道与通知帧
    for (const doc of ['docs/guide/configuration.md', 'docs/zh/guide/configuration.md']) {
      expect(read(doc), `${doc} 应点名 $/kode/fileChanged`).toContain('$/kode/fileChanged');
    }
  });
});
