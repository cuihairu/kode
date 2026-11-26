// 面包屑对端跳转按钮纯核测试(PROC-BREADCRUMB-002,2026-11-25):判得出归属
// 且对端存在才出按钮;按钮 command 指向已注册的 openCell/openBase;无对端=
// 零按钮不猜。provider 是薄 vscode 面,直接构造真 DocumentSymbol 输入面测。
import { describe, expect, it } from 'vitest';
import * as vscode from 'vscode';

import {
  ProcessOwnershipSwitchCodeLensProvider,
  KBENGINE_PROCESS_OWNERSHIP_OPEN_CELL_COMMAND,
  KBENGINE_PROCESS_OWNERSHIP_OPEN_BASE_COMMAND
} from '../src/languageProviders/processOwnership';

/** 最小 vscode.TextDocument 替身(只供给 provider 读的面) */
function fakeDocument(fileName: string): vscode.TextDocument {
  return {
    fileName,
    getText: () => 'x = 1\n',
    positionAt: (offset: number) => new vscode.Position(0, offset)
  } as unknown as vscode.TextDocument;
}

describe('ProcessOwnershipSwitchCodeLensProvider', () => {
  const cellFile = '/proj/scripts/cell/Hero.py';
  const baseFile = '/proj/scripts/base/Hero.py';

  it('cell 文件 + base 对端存在 → 出「跳 base →」按钮指向 openBase', () => {
    const provider = new ProcessOwnershipSwitchCodeLensProvider({
      fileExists: candidate => candidate === baseFile
    });
    const lenses = provider.provideCodeLenses(fakeDocument(cellFile))!;
    expect(lenses.length).toBe(1);
    expect(lenses[0].command!.command).toBe(KBENGINE_PROCESS_OWNERSHIP_OPEN_BASE_COMMAND);
    expect(lenses[0].command!.title.includes('base'));
    expect(lenses[0].command!.tooltip!.includes(baseFile));
  });

  it('判不出归属(scripts 外)→ 零按钮', () => {
    const provider = new ProcessOwnershipSwitchCodeLensProvider({ fileExists: () => true });
    const lenses = provider.provideCodeLenses(fakeDocument('/proj/elsewhere/Hero.py'))!;
    expect(lenses.length).toBe(0);
  });

  it('归属判得出但无对端 → 零按钮不猜', () => {
    const provider = new ProcessOwnershipSwitchCodeLensProvider({ fileExists: () => false });
    const lenses = provider.provideCodeLenses(fakeDocument(cellFile))!;
    expect(lenses.length).toBe(0);
  });

  it('双向:base 文件 + cell 对端存在 → 按钮指向 openCell', () => {
    const provider = new ProcessOwnershipSwitchCodeLensProvider({
      fileExists: candidate => candidate === cellFile
    });
    const lenses = provider.provideCodeLenses(fakeDocument(baseFile))!;
    expect(lenses.length).toBe(1);
    expect(lenses[0].command!.command).toBe(KBENGINE_PROCESS_OWNERSHIP_OPEN_CELL_COMMAND);
  });
});

// SWITCH-DEGRADE-001(用户报「第一次正常,切换几次后失效」):连按竞态回归。
// 场景=s showTextDocument 在途期间 activeTextEditor 仍是旧文件(stub 特意不
// 翻转编辑器,复现真机连按窗口),旧实现每次现问编辑器 → 方向漂移/误报
// 「未找到同名」;新实现=在途互斥+只认最新一次+续跳以刚打开的文件为源+
// 停泊侧记账(编辑器停在上一轮来源文件时以停泊侧为准)。
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { registerProcessOwnershipSwitchCommands } from '../src/languageProviders';
import {
  commandRegistry,
  commands,
  messages,
  window as stubWindow,
  windowState
} from './helpers/vscodeStub';

const makeTree = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'kode-switchrace-'));
  mkdirSync(join(dir, 'scripts', 'base'), { recursive: true });
  mkdirSync(join(dir, 'scripts', 'cell'), { recursive: true });
  writeFileSync(join(dir, 'scripts', 'base', 'Hero.py'), 'class Hero:\n    pass\n');
  writeFileSync(join(dir, 'scripts', 'cell', 'Hero.py'), 'class Hero:\n    pass\n');
  return dir;
};

/** 慢速 showTextDocument:记账但立即返回可手动放行的延迟 promise;
 * 刻意不更新 activeTextEditor——真机连按窗口内编辑器就是没翻转。 */
const deferShowTextDocument = (): {
  calls: Array<{ fsPath: string }>;
  releaseAll: () => Promise<void>;
} => {
  const calls: Array<{ fsPath: string }> = [];
  const pending: Array<() => void> = [];
  (stubWindow as unknown as Record<string, unknown>).showTextDocument = async (
    document: { fsPath: string }
  ): Promise<unknown> => {
    calls.push({ fsPath: document.fsPath });
    await new Promise<void>(resolve => {
      pending.push(resolve);
    });
    return { revealRange: (): void => undefined };
  };
  return {
    calls,
    releaseAll: async () => {
      while (pending.length > 0) {
        pending.shift()!();
        await new Promise(resolve => setTimeout(resolve, 0));
      }
    }
  };
};

const originalShowTextDocument = stubWindow.showTextDocument;
const restoreShowTextDocument = (): void => {
  (stubWindow as unknown as Record<string, unknown>).showTextDocument = originalShowTextDocument;
};

describe('base↔cell 切换连按竞态(SWITCH-DEGRADE-001)', () => {
  let root = '';

  afterEach(() => {
    delete (stubWindow as { activeTextEditor?: unknown }).activeTextEditor;
    restoreShowTextDocument();
    commandRegistry.reset();
    windowState.reset();
    if (root) {
      rmSync(root, { recursive: true, force: true });
      root = '';
    }
  });

  it('交替连按 B/C/B/C(在途不等待):最终停在对侧,零「未找到同名」误报', async () => {
    root = makeTree();
    const subscriptions: Array<{ dispose(): void }> = [];
    registerProcessOwnershipSwitchCommands({ subscriptions } as unknown as never);
    stubWindow.activeTextEditor = {
      document: { fileName: join(root, 'scripts', 'cell', 'Hero.py') }
    } as never;
    const slow = deferShowTextDocument();

    // 连按四发不等上一发(showTextDocument 全程在途,activeTextEditor 恒旧)
    const press1 = commands.executeCommand(KBENGINE_PROCESS_OWNERSHIP_OPEN_BASE_COMMAND);
    const press2 = commands.executeCommand(KBENGINE_PROCESS_OWNERSHIP_OPEN_CELL_COMMAND);
    const press3 = commands.executeCommand(KBENGINE_PROCESS_OWNERSHIP_OPEN_BASE_COMMAND);
    const press4 = commands.executeCommand(KBENGINE_PROCESS_OWNERSHIP_OPEN_CELL_COMMAND);
    await slow.releaseAll();
    await Promise.all([press1, press2, press3, press4]);

    // 链式交替:cell→base→cell;末发 C 把用户送回 cell 侧,不卡在 base
    expect(slow.calls.map(call => call.fsPath)).toEqual([
      join(root, 'scripts', 'base', 'Hero.py'),
      join(root, 'scripts', 'cell', 'Hero.py')
    ]);
    expect(messages.info.join('\n')).not.toContain('未找到同名');
  });

  it('静止后的下一次按键仍正确:以停泊侧为源,不重读陈旧编辑器', async () => {
    root = makeTree();
    const subscriptions: Array<{ dispose(): void }> = [];
    registerProcessOwnershipSwitchCommands({ subscriptions } as unknown as never);
    stubWindow.activeTextEditor = {
      document: { fileName: join(root, 'scripts', 'cell', 'Hero.py') }
    } as never;
    // 单跳 B(stub 不翻转编辑器=编辑器仍停在 cell 文件)
    await commands.executeCommand(KBENGINE_PROCESS_OWNERSHIP_OPEN_BASE_COMMAND);
    expect(windowState.showTextDocumentCalls).toHaveLength(1);
    // 间隔后再按 C:编辑器还是旧 cell 文件(陈旧值),状态机以停泊侧 base 为源
    await commands.executeCommand(KBENGINE_PROCESS_OWNERSHIP_OPEN_CELL_COMMAND);
    const second = windowState.showTextDocumentCalls[1].document as { fsPath: string };
    expect(second.fsPath).toBe(join(root, 'scripts', 'cell', 'Hero.py'));
    expect(messages.info.join('\n')).not.toContain('未找到同名');
  });

  it('用户手动跳到第三处:以编辑器为准(状态机不覆盖真实导航)', async () => {
    root = makeTree();
    mkdirSync(join(root, 'scripts', 'base'), { recursive: true });
    writeFileSync(join(root, 'scripts', 'base', 'Other.py'), 'class Other:\n    pass\n');
    const subscriptions: Array<{ dispose(): void }> = [];
    registerProcessOwnershipSwitchCommands({ subscriptions } as unknown as never);
    stubWindow.activeTextEditor = {
      document: { fileName: join(root, 'scripts', 'cell', 'Hero.py') }
    } as never;
    await commands.executeCommand(KBENGINE_PROCESS_OWNERSHIP_OPEN_BASE_COMMAND);
    // 手动跳到无对端的其他 base 文件(≠上一轮来源 cell)
    stubWindow.activeTextEditor = {
      document: { fileName: join(root, 'scripts', 'base', 'Other.py') }
    } as never;
    await commands.executeCommand(KBENGINE_PROCESS_OWNERSHIP_OPEN_CELL_COMMAND);
    expect(messages.info.join('\n')).toContain('未找到同名 cellapp');
    expect(windowState.showTextDocumentCalls).toHaveLength(1);
  });

  it('同向连按 B,B:只认最新一次,续跳从停泊侧如实报「已在 base 侧」', async () => {
    root = makeTree();
    const subscriptions: Array<{ dispose(): void }> = [];
    registerProcessOwnershipSwitchCommands({ subscriptions } as unknown as never);
    stubWindow.activeTextEditor = {
      document: { fileName: join(root, 'scripts', 'cell', 'Hero.py') }
    } as never;
    const slow = deferShowTextDocument();
    const press1 = commands.executeCommand(KBENGINE_PROCESS_OWNERSHIP_OPEN_BASE_COMMAND);
    const press2 = commands.executeCommand(KBENGINE_PROCESS_OWNERSHIP_OPEN_BASE_COMMAND);
    await slow.releaseAll();
    await Promise.all([press1, press2]);
    // 第一发打开 base;续跳 B 以 base 为源→base 侧没有 baseapp 对端,如实提示
    expect(slow.calls).toHaveLength(1);
    expect(messages.info.join('\n')).toContain('未找到同名 baseapp');
  });
});
