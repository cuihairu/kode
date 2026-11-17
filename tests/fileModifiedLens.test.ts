import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type * as vscode from 'vscode';
import { formatLocalClock, formatModifiedStamp, formatModifiedTimeLens } from '../src/backend/fileModifiedLens';
import {
  FileModifiedTimeCodeLensProvider,
  KBENGINE_PROCESS_OWNERSHIP_OPEN_BASE_COMMAND,
  KBENGINE_PROCESS_OWNERSHIP_OPEN_CELL_COMMAND,
  registerProcessOwnershipSwitchCommands
} from '../src/languageProviders';
import {
  commandRegistry,
  commands,
  configurationOverrides,
  makeTextDocument,
  messages,
  window as stubWindow,
  windowState,
  workspaceEvents
} from './helpers/vscodeStub';

// FILE-TIME-001(用户令 2026-11-17):「在文件顶部显示修改的时间」+
// base↔cell 同名文件快捷键切换。纯核半边=盘上 mtime 格式化(mtime 是盘上
// 事实,缓冲区未落盘只注记不重排);provider 半边=独立开关闸/stat 注入/
// 保存即刷新;命令半边=复用 buildProcessOwnershipSpec 同一条判定链。

interface CodeLensLike {
  range: { start: { line: number; character: number } };
  command?: { title: string; command?: string; tooltip?: string };
}

// 固定钟:今天=2026-11-17 10:20:30 本地时间,格式断言不随真时钟漂移。
const NOW = new Date(2026, 10, 17, 10, 20, 30).getTime();
const TODAY_90501 = new Date(2026, 10, 17, 9, 5, 1).getTime();
const YESTERDAY_235959 = new Date(2026, 10, 16, 23, 59, 59).getTime();

const pythonDoc = (fileName: string): ReturnType<typeof makeTextDocument> =>
  makeTextDocument('class Hero:\n    pass\n', { fileName, languageId: 'python' });

describe('formatModifiedTimeLens(纯核:mtime → 镜文字)', () => {
  it('同日只出钟点,零填充', () => {
    expect(formatLocalClock(TODAY_90501)).toBe('09:05:01');
    expect(formatModifiedStamp(TODAY_90501, NOW)).toBe('09:05:01');
  });

  it('跨日补月-日(比照最近一次落盘,同天读起来最短)', () => {
    expect(formatModifiedStamp(YESTERDAY_235959, NOW)).toBe('11-16 23:59:59');
  });

  it('mtime 缺失(stat 失败)=null,调用方不出镜不编造时间', () => {
    expect(formatModifiedTimeLens(undefined, false, NOW)).toBeNull();
  });

  it('盘上时间原样出镜;缓冲区未保存只追加注记,不改写时间', () => {
    expect(formatModifiedTimeLens(TODAY_90501, false, NOW)).toBe('$(clock) 修改 09:05:01');
    expect(formatModifiedTimeLens(TODAY_90501, true, NOW)).toBe('$(clock) 修改 09:05:01(未保存)');
  });
});

describe('FileModifiedTimeCodeLensProvider', () => {
  afterEach(() => {
    configurationOverrides.delete('kbengine');
  });

  it('stat 注入:line 0 单镜,tooltip 指向热更状态点(热更时间不重复出镜)', async () => {
    const provider = new FileModifiedTimeCodeLensProvider({
      stat: async () => ({ mtimeMs: TODAY_90501 }),
      now: () => NOW
    });
    const lenses = (await provider.provideCodeLenses(
      pythonDoc('/ws/scripts/base/Hero.py') as unknown as vscode.TextDocument
    )) as unknown as CodeLensLike[];
    expect(lenses).toHaveLength(1);
    expect(lenses[0].range.start.line).toBe(0);
    expect(lenses[0].command?.title).toBe('$(clock) 修改 09:05:01');
    expect(lenses[0].command?.tooltip).toContain('热更状态点');
    provider.dispose();
  });

  it('kbengine.codeLens.fileModifiedTime 关闭整类不出镜(批154 惯例:每类镜一枚开关)', async () => {
    const provider = new FileModifiedTimeCodeLensProvider({
      stat: async () => ({ mtimeMs: TODAY_90501 }),
      now: () => NOW
    });
    const document = pythonDoc('/ws/scripts/base/Hero.py') as unknown as vscode.TextDocument;
    expect(await provider.provideCodeLenses(document)).toHaveLength(1);
    configurationOverrides.set('kbengine', { 'codeLens.fileModifiedTime': false });
    try {
      expect(await provider.provideCodeLenses(document)).toEqual([]);
    } finally {
      configurationOverrides.delete('kbengine');
    }
    provider.dispose();
  });

  it('stat 失败(删除/不可及)不出镜,不编造时间', async () => {
    const provider = new FileModifiedTimeCodeLensProvider({
      stat: async () => {
        throw new Error('ENOENT');
      },
      now: () => NOW
    });
    const lenses = await provider.provideCodeLenses(
      pythonDoc('/ws/scripts/base/Gone.py') as unknown as vscode.TextDocument
    );
    expect(lenses).toEqual([]);
    provider.dispose();
  });

  it('isDirty:镜文含「(未保存)」注记', async () => {
    const provider = new FileModifiedTimeCodeLensProvider({
      stat: async () => ({ mtimeMs: TODAY_90501 }),
      now: () => NOW
    });
    const document = pythonDoc('/ws/scripts/base/Hero.py') as unknown as vscode.TextDocument;
    (document as { isDirty?: boolean }).isDirty = true;
    const lenses = (await provider.provideCodeLenses(document)) as unknown as CodeLensLike[];
    expect(lenses[0].command?.title).toBe('$(clock) 修改 09:05:01(未保存)');
    provider.dispose();
  });

  it('保存事件触发重询(盘上 mtime 只在落盘时变)', () => {
    const provider = new FileModifiedTimeCodeLensProvider({
      stat: async () => ({ mtimeMs: TODAY_90501 }),
      now: () => NOW
    });
    let fired = 0;
    const subscription = provider.onDidChangeCodeLenses(() => {
      fired += 1;
    });
    workspaceEvents.documentSaved.fire({ fileName: '/ws/scripts/base/Hero.py' });
    expect(fired).toBe(1);
    subscription.dispose();
    provider.dispose();
    expect(fired).toBe(1); // dispose 后不再收事件
  });
});

describe('base↔cell 切换命令(FILE-TIME-001 快捷键半边)', () => {
  let root = '';

  const makeTree = (): string => {
    const dir = mkdtempSync(join(tmpdir(), 'kode-filetime-'));
    mkdirSync(join(dir, 'scripts', 'base'), { recursive: true });
    mkdirSync(join(dir, 'scripts', 'cell'), { recursive: true });
    writeFileSync(join(dir, 'scripts', 'base', 'Hero.py'), 'class Hero:\n    pass\n');
    writeFileSync(join(dir, 'scripts', 'cell', 'Hero.py'), 'class Hero:\n    pass\n');
    return dir;
  };

  const register = (): void => {
    const subscriptions: Array<{ dispose(): void }> = [];
    registerProcessOwnershipSwitchCommands({ subscriptions } as unknown as vscode.ExtensionContext);
  };

  afterEach(() => {
    delete (stubWindow as { activeTextEditor?: unknown }).activeTextEditor;
    commandRegistry.reset();
    windowState.reset();
    if (root) {
      rmSync(root, { recursive: true, force: true });
      root = '';
    }
  });

  it('双命令注册在案(package.json keybindings 消费)', () => {
    register();
    const ids = commandRegistry.registeredCommandIds();
    expect(ids).toContain(KBENGINE_PROCESS_OWNERSHIP_OPEN_CELL_COMMAND);
    expect(ids).toContain(KBENGINE_PROCESS_OWNERSHIP_OPEN_BASE_COMMAND);
  });

  it('base 编辑态跑 openCell:打开同名 cell 文件', async () => {
    root = makeTree();
    register();
    stubWindow.activeTextEditor = {
      document: { fileName: join(root, 'scripts', 'base', 'Hero.py') }
    } as never;
    await commands.executeCommand(KBENGINE_PROCESS_OWNERSHIP_OPEN_CELL_COMMAND);
    expect(windowState.showTextDocumentCalls).toHaveLength(1);
    const opened = windowState.showTextDocumentCalls[0].document as { fsPath: string };
    expect(opened.fsPath).toBe(join(root, 'scripts', 'cell', 'Hero.py'));
  });

  it('反向 cell→base 同链(openBase)', async () => {
    root = makeTree();
    register();
    stubWindow.activeTextEditor = {
      document: { fileName: join(root, 'scripts', 'cell', 'Hero.py') }
    } as never;
    await commands.executeCommand(KBENGINE_PROCESS_OWNERSHIP_OPEN_BASE_COMMAND);
    const opened = windowState.showTextDocumentCalls[0].document as { fsPath: string };
    expect(opened.fsPath).toBe(join(root, 'scripts', 'base', 'Hero.py'));
  });

  it('目标缺位:如实提示不静默', async () => {
    root = makeTree();
    unlinkSync(join(root, 'scripts', 'cell', 'Hero.py'));
    register();
    stubWindow.activeTextEditor = {
      document: { fileName: join(root, 'scripts', 'base', 'Hero.py') }
    } as never;
    await commands.executeCommand(KBENGINE_PROCESS_OWNERSHIP_OPEN_CELL_COMMAND);
    expect(windowState.showTextDocumentCalls).toHaveLength(0);
    expect(messages.info.join('\n')).toContain('未找到同名 cellapp');
  });

  it('判不出进程归属(scripts 根级):提示判据', async () => {
    root = makeTree();
    writeFileSync(join(root, 'scripts', 'Loose.py'), 'class Loose:\n    pass\n');
    register();
    stubWindow.activeTextEditor = {
      document: { fileName: join(root, 'scripts', 'Loose.py') }
    } as never;
    await commands.executeCommand(KBENGINE_PROCESS_OWNERSHIP_OPEN_CELL_COMMAND);
    expect(windowState.showTextDocumentCalls).toHaveLength(0);
    expect(messages.info.join('\n')).toContain('判不出进程归属');
  });

  it('无活动编辑器:静默返回(不提示不打扰)', async () => {
    root = makeTree();
    register();
    await commands.executeCommand(KBENGINE_PROCESS_OWNERSHIP_OPEN_CELL_COMMAND);
    expect(windowState.showTextDocumentCalls).toHaveLength(0);
    expect(messages.info).toHaveLength(0);
  });
});
