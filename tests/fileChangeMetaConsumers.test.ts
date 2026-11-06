import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as vscode from 'vscode';
import { createFileChangeMetaResolver, type FileChangeMetaDeps } from '../src/fileChangeMeta';
import { logIndexFileChangeMeta } from '../src/fileChangeMetaLog';
import { setupHotReload, type HotReloadTimerDeps } from '../src/hotReload';
import type { HotReloadStatusController } from '../src/hotReloadStatus';
import { HotReloadTargetStateStore } from '../src/hotReloadTargetState';
import { clearRecentJumpLogs, getRecentJumpLogs, setJumpLogEnabled } from '../src/navigationLog';
import { normalizeFileIdentity } from '../src/pathIdentity';
import { configurationOverrides, lastFileSystemWatcher } from './helpers/vscodeStub';

// 文件变化元信息(方案 B)的两个真实消费端接线:
// ① 热更投递腿——setupHotReload 注入解析器后,审计行逐文件补一行元信息
//    (module/process/sha256/version),不注入则零 IO;
// ② python 索引事件腿——logIndexFileChangeMeta 沿用既有 jumpLog 开关,
//    关闭时零 IO,开启后落同一行格式。
// 只断言「接线真的产出元信息行」,字段口径归 tests/fileChangeMeta.test.ts。

const makeTimers = (): { timers: HotReloadTimerDeps; tick: () => number } => {
  const handles = new Map<unknown, () => void>();
  return {
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

/**
 * 轮询等待异步落账:读文件走真 fs 线程池,固定轮数在负载下会抖(本文件曾因此
 * 偶发红),改成按断言面轮询,超时即如实失败。
 */
const waitFor = async (predicate: () => boolean, timeoutMs = 5000): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (!predicate() && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 5));
  }
};

/** 固定让出若干事件循环轮次(用于「断言没有发生」的负向用例) */
const settle = async (rounds = 20): Promise<void> => {
  for (let round = 0; round < rounds; round += 1) {
    await new Promise(resolve => setTimeout(resolve, 5));
  }
};

/** 状态机替身:只收 log 行,其余方法空转(审计行是本文件的断言面) */
const fakeStatus = (): { lines: string[]; status: HotReloadStatusController } => {
  const lines: string[] = [];
  const noop = (): void => undefined;
  const status = {
    log: (text: string): void => {
      lines.push(text);
    },
    setWatchOff: noop,
    setReady: noop,
    setSending: noop,
    setSentUnverified: noop,
    setFailed: noop,
    setSkippedNoAction: noop,
    setRestartRequired: noop,
    dispose: noop
  };
  return { lines, status: status as unknown as HotReloadStatusController };
};

/** 计数型 IO 替身:读/次统计是「未注入即零 IO」「开启才解析」的断言面 */
const countingDeps = (
  scriptRoot: () => string,
  assetsRoot: () => string
): { deps: FileChangeMetaDeps; reads: string[]; stats: string[] } => {
  const reads: string[] = [];
  const stats: string[] = [];
  return {
    reads,
    stats,
    deps: {
      scriptRoot,
      assetsRoot,
      readFile: async (file: string): Promise<Buffer> => {
        reads.push(file);
        return fs.promises.readFile(file);
      },
      stat: async (file: string): Promise<{ mtimeMs: number; size: number }> => {
        stats.push(file);
        const value = await fs.promises.stat(file);
        return { mtimeMs: value.mtimeMs, size: value.size };
      }
    }
  };
};

const temporaryDirectories: string[] = [];

afterEach(() => {
  setJumpLogEnabled(false);
  clearRecentJumpLogs();
  configurationOverrides.clear();
  lastFileSystemWatcher.current = null;
  for (const dir of temporaryDirectories.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

beforeEach(() => {
  configurationOverrides.clear();
  lastFileSystemWatcher.current = null;
});

/** `<tmp>/scripts/cell/Avatar.py`(脚本根 = `<tmp>/scripts`) */
const realScriptFile = (): { tmp: string; scripts: string; file: string } => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-fcm-consumer-'));
  temporaryDirectories.push(tmp);
  const scripts = path.join(tmp, 'scripts');
  fs.mkdirSync(path.join(scripts, 'cell'), { recursive: true });
  const file = path.join(scripts, 'cell', 'Avatar.py');
  fs.writeFileSync(file, 'class Avatar: pass\n', 'utf8');
  return { tmp, scripts, file };
};

describe('fileChangeMeta 消费端①:热更投递审计行', () => {
  it('注入解析器:审计行后逐文件补元信息行(module/process/sha256/version)', async () => {
    const { tmp, scripts, file } = realScriptFile();
    configurationOverrides.set('kbengine', {
      hotReload: { enabled: true, actionName: '热更', debounceMs: 100 }
    });
    const clock = makeTimers();
    const runCalls: string[] = [];
    const { lines, status } = fakeStatus();
    const resolver = createFileChangeMetaResolver({
      scriptRoot: () => scripts,
      assetsRoot: () => tmp
    });
    const store = new HotReloadTargetStateStore({ now: () => 1 });
    const context = { subscriptions: [] } as unknown as vscode.ExtensionContext;

    setupHotReload(context, name => void runCalls.push(name), {
      timers: clock.timers,
      status,
      fileChangeMeta: resolver,
      targetState: {
        store,
        resolveTargetId: () => 't1',
        resolveRootId: () => '/root'
      }
    });

    lastFileSystemWatcher.current!.fireChange({ fsPath: file } as never);
    clock.tick();
    // targetId 解析走微任务、元信息读走真 fs 线程池:按断言面轮询落定
    await waitFor(() => runCalls.length > 0);
    expect(runCalls).toEqual(['热更']);
    await waitFor(() => lines.some(line => line.startsWith('文件元信息: ')));

    const metaLine = lines.find(line => line.startsWith('文件元信息: '));
    expect(metaLine, `审计元信息行应落在状态日志里: ${JSON.stringify(lines)}`).toBeDefined();
    expect(metaLine).toContain('Avatar.py');
    expect(metaLine).toContain('module=cell.Avatar');
    expect(metaLine).toContain('package=cell');
    expect(metaLine).toContain('process=cellapp');
    expect(metaLine).toMatch(/sha256=[0-9a-f]{12}…/);
    expect(metaLine).toMatch(/version=\d+(\.\d+)?:\d+/);
    // 审计五要素行照旧(元信息行是**追加**,不替换既有审计行),且先审计后元信息
    const auditIndex = lines.findIndex(line => line.startsWith('审计: 触发源='));
    expect(auditIndex).toBeGreaterThanOrEqual(0);
    expect(lines.findIndex(line => line.startsWith('文件元信息: '))).toBeGreaterThan(auditIndex);
    context.subscriptions.forEach(disposable => disposable.dispose());
  });

  it('未注入解析器:审计照发,零元信息行(未接线场景零 IO)', async () => {
    const clock = makeTimers();
    const { lines, status } = fakeStatus();
    configurationOverrides.set('kbengine', {
      hotReload: { enabled: true, actionName: '热更', debounceMs: 100 }
    });
    const store = new HotReloadTargetStateStore({ now: () => 1 });
    const context = { subscriptions: [] } as unknown as vscode.ExtensionContext;

    setupHotReload(context, () => Promise.resolve(true), {
      timers: clock.timers,
      status,
      targetState: {
        store,
        resolveTargetId: () => 't1',
        resolveRootId: () => '/root'
      }
    });

    lastFileSystemWatcher.current!.fireChange({ fsPath: '/ws/scripts/cell/Ghost.py' } as never);
    clock.tick();
    await waitFor(() => lines.some(line => line.startsWith('审计: 触发源=')));
    await settle(); // 审计已落,再让出一轮确认没有元信息行长出来

    expect(lines.some(line => line.startsWith('审计: 触发源='))).toBe(true);
    expect(lines.some(line => line.startsWith('文件元信息: '))).toBe(false);
    context.subscriptions.forEach(disposable => disposable.dispose());
  });

  it('非 py 投递(globs 可配场景):审计元信息行 module=- package=-,不编造模块名', async () => {
    const { tmp, scripts } = realScriptFile();
    const jsonFile = path.join(scripts, 'cell', 'Avatar.json');
    fs.writeFileSync(jsonFile, '{"Avatar": {}}', 'utf8');
    configurationOverrides.set('kbengine', {
      hotReload: { enabled: true, actionName: '热更', debounceMs: 100 }
    });
    const clock = makeTimers();
    const { lines, status } = fakeStatus();
    const resolver = createFileChangeMetaResolver({
      scriptRoot: () => scripts,
      assetsRoot: () => tmp
    });
    const store = new HotReloadTargetStateStore({ now: () => 1 });
    const context = { subscriptions: [] } as unknown as vscode.ExtensionContext;

    setupHotReload(context, () => Promise.resolve(true), {
      timers: clock.timers,
      status,
      fileChangeMeta: resolver,
      targetState: {
        store,
        resolveTargetId: () => 't1',
        resolveRootId: () => '/root'
      }
    });

    // 默认 globs 是 **/*.py,但 globs 可配置——锁住即便非 py 文件真被投递,
    // 元信息行也不带 module_name(module/package 是 Python 概念,渲染层落 -)
    lastFileSystemWatcher.current!.fireChange({ fsPath: jsonFile } as never);
    clock.tick();
    await waitFor(() => lines.some(line => line.startsWith('文件元信息: ')));

    const metaLine = lines.find(line => line.startsWith('文件元信息: '));
    expect(metaLine, `非 py 投递也应有元信息行: ${JSON.stringify(lines)}`).toBeDefined();
    expect(metaLine).toContain('Avatar.json');
    expect(metaLine).toContain('module=-');
    expect(metaLine).toContain('package=-');
    expect(metaLine).toContain('process=cellapp');
    expect(metaLine).not.toContain('module=cell');
    context.subscriptions.forEach(disposable => disposable.dispose());
  });
});

describe('fileChangeMeta 消费端②:python 索引事件', () => {
  it('jumpLog 关闭:事件到达也不发起解析(零 IO、零日志行)', async () => {
    const { tmp, scripts, file } = realScriptFile();
    const { deps, reads, stats } = countingDeps(() => scripts, () => tmp);
    const resolver = createFileChangeMetaResolver(deps);
    setJumpLogEnabled(false);
    clearRecentJumpLogs();

    logIndexFileChangeMeta(resolver, {
      fsPath: file,
      identity: normalizeFileIdentity(file),
      kind: 'change'
    });
    await settle();

    expect(reads, '开关关闭时连解析都不发起').toEqual([]);
    expect(stats).toEqual([]);
    expect(getRecentJumpLogs()).toEqual([]);
  });

  it('jumpLog 开启:落同一行格式的索引日志(module/process/sha256/version)', async () => {
    const { tmp, scripts, file } = realScriptFile();
    const { deps, reads } = countingDeps(() => scripts, () => tmp);
    const resolver = createFileChangeMetaResolver(deps);
    setJumpLogEnabled(true);
    clearRecentJumpLogs();

    logIndexFileChangeMeta(resolver, {
      fsPath: file,
      identity: normalizeFileIdentity(file),
      kind: 'change'
    });
    await waitFor(() => getRecentJumpLogs().some(text => text.includes('py 变更 ')));

    expect(reads, '开关开启才解析(每版本一次)').toEqual([file]);
    const line = getRecentJumpLogs().find(text => text.includes('py 变更 '));
    expect(line, `索引日志应含元信息行: ${JSON.stringify(getRecentJumpLogs())}`).toBeDefined();
    expect(line).toContain('module=cell.Avatar');
    expect(line).toContain('process=cellapp');
    expect(line).toMatch(/sha256=[0-9a-f]{12}…/);
    expect(line).toMatch(/version=\d+(\.\d+)?:\d+/);
  });

  it('非 py 索引事件(watcher 面 **/*.{py,def,xml}):module=- package=-,不编造模块名', async () => {
    const { tmp, scripts } = realScriptFile();
    const defFile = path.join(scripts, 'cell', 'Avatar.def');
    fs.writeFileSync(defFile, '<root/>', 'utf8');
    const { deps, reads } = countingDeps(() => scripts, () => tmp);
    const resolver = createFileChangeMetaResolver(deps);
    setJumpLogEnabled(true);
    clearRecentJumpLogs();

    // 索引 watcher 面含 .def/.xml:非 py 事件真的会流进本腿——锁住元信息行
    // 不带模块名(module/package 仅 .py 解析),渲染层落 -,进程归属照常
    logIndexFileChangeMeta(resolver, {
      fsPath: defFile,
      identity: normalizeFileIdentity(defFile),
      kind: 'change'
    });
    await waitFor(() => getRecentJumpLogs().some(text => text.includes('Avatar.def')));

    expect(reads, '非 py 照读(sha256 口径不变)').toEqual([defFile]);
    const line = getRecentJumpLogs().find(text => text.includes('Avatar.def'));
    expect(line, `索引日志应含非 py 元信息行: ${JSON.stringify(getRecentJumpLogs())}`).toBeDefined();
    expect(line).toContain('module=-');
    expect(line).toContain('package=-');
    expect(line).toContain('process=cellapp');
  });
});
