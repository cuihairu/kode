import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type * as vscode from 'vscode';
import { formatLocalClock, formatModifiedStamp, formatModifiedTimeLens } from '../src/backend/fileModifiedLens';
import {
  KBENGINE_PROCESS_OWNERSHIP_OPEN_BASE_COMMAND,
  KBENGINE_PROCESS_OWNERSHIP_OPEN_CELL_COMMAND,
  registerProcessOwnershipSwitchCommands
} from '../src/languageProviders';
import {
  commandRegistry,
  commands,
  messages,
  window as stubWindow,
  windowState
} from './helpers/vscodeStub';

// FILE-TIME-001(用户令 2026-11-17):「在文件顶部显示修改的时间」+
// base↔cell 同名文件快捷键切换。2026-11-25 修改时间镜并入热更状态镜
// (用户裁定首行一条完整热更信息):独立 provider 退役,本文件留纯核
// 格式化半边 + 切换命令半边;mtime 呈现面用例在 hotReloadFileStateLens。

// 固定钟:今天=2026-11-17 10:20:30 本地时间,格式断言不随真时钟漂移。
const NOW = new Date(2026, 10, 17, 10, 20, 30).getTime();
const TODAY_90501 = new Date(2026, 10, 17, 9, 5, 1).getTime();
const YESTERDAY_235959 = new Date(2026, 10, 16, 23, 59, 59).getTime();

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

  it('同侧键翻转:已在 cell 侧按 openCell → 跳另一侧 base(2026-11-27 用户令)', async () => {
    root = makeTree();
    register();
    stubWindow.activeTextEditor = {
      document: { fileName: join(root, 'scripts', 'cell', 'Hero.py') }
    } as never;
    await commands.executeCommand(KBENGINE_PROCESS_OWNERSHIP_OPEN_CELL_COMMAND);
    expect(windowState.showTextDocumentCalls).toHaveLength(1);
    const opened = windowState.showTextDocumentCalls[0].document as { fsPath: string };
    expect(opened.fsPath).toBe(join(root, 'scripts', 'base', 'Hero.py'));
  });

  it('同侧键翻转:已在 base 侧按 openBase → 跳另一侧 cell', async () => {
    root = makeTree();
    register();
    stubWindow.activeTextEditor = {
      document: { fileName: join(root, 'scripts', 'base', 'Hero.py') }
    } as never;
    await commands.executeCommand(KBENGINE_PROCESS_OWNERSHIP_OPEN_BASE_COMMAND);
    const opened = windowState.showTextDocumentCalls[0].document as { fsPath: string };
    expect(opened.fsPath).toBe(join(root, 'scripts', 'cell', 'Hero.py'));
  });

  it('同侧键对端缺位:按翻转后的侧如实提示', async () => {
    root = makeTree();
    unlinkSync(join(root, 'scripts', 'base', 'Hero.py'));
    register();
    stubWindow.activeTextEditor = {
      document: { fileName: join(root, 'scripts', 'cell', 'Hero.py') }
    } as never;
    await commands.executeCommand(KBENGINE_PROCESS_OWNERSHIP_OPEN_CELL_COMMAND);
    expect(windowState.showTextDocumentCalls).toHaveLength(0);
    expect(messages.info.join('\n')).toContain('未找到同名 baseapp');
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
