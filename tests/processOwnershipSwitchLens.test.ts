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

/** 注入编辑器变化事件替身(默认 stub 无该事件),记录监听器供用例手动派发,
 * 模拟真机里用户手动切回某个 tab 的导航。 */
const installEditorChangeHook = (): { fire: (fileName: string) => void } => {
  let listener: ((editor: unknown) => void) | null = null;
  (stubWindow as unknown as Record<string, unknown>).onDidChangeActiveTextEditor = (
    callback: (editor: unknown) => void
  ): { dispose(): void } => {
    listener = callback;
    return { dispose: (): void => undefined };
  };
  return {
    fire: (fileName: string): void => {
      if (!listener) {
        throw new Error('editor change listener was not registered');
      }
      listener({ document: { fileName } });
    }
  };
};

describe('base↔cell 切换连按竞态(SWITCH-DEGRADE-001)', () => {
  let root = '';

  afterEach(() => {
    delete (stubWindow as { activeTextEditor?: unknown }).activeTextEditor;
    delete (stubWindow as { onDidChangeActiveTextEditor?: unknown }).onDidChangeActiveTextEditor;
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

  // Prove-red(SWITCH-DEGRADE-001 ⑥):删掉 registerProcessOwnershipSwitchCommands
  // 内的 onDidChangeActiveTextEditor 账作废 → 本例红(误报「未找到同名 baseapp」、
  // 零次新打开);保留账作废则绿。复现用户报「手动切回来源后再按仍失效」。
  it('用户手动切回上一轮来源文件后:作废停泊账,以当前编辑器为准', async () => {
    root = makeTree();
    const editorHook = installEditorChangeHook();
    const subscriptions: Array<{ dispose(): void }> = [];
    registerProcessOwnershipSwitchCommands({ subscriptions } as unknown as never);
    const cellFile = join(root, 'scripts', 'cell', 'Hero.py');
    const baseFile = join(root, 'scripts', 'base', 'Hero.py');
    stubWindow.activeTextEditor = { document: { fileName: cellFile } } as never;
    // 首跳 B:cell → base(编辑器在 stub 里不自动翻转)
    await commands.executeCommand(KBENGINE_PROCESS_OWNERSHIP_OPEN_BASE_COMMAND);
    expect(windowState.showTextDocumentCalls).toHaveLength(1);
    // 真机里 showTextDocument 会翻转编辑器,用户随后手动切回 cell tab →
    // 事件必须作废停泊账;下一次 B 应当重新从 cell 跳 base。
    stubWindow.activeTextEditor = { document: { fileName: cellFile } } as never;
    editorHook.fire(cellFile);
    await commands.executeCommand(KBENGINE_PROCESS_OWNERSHIP_OPEN_BASE_COMMAND);
    expect(windowState.showTextDocumentCalls.map(c => (c.document as { fsPath: string }).fsPath))
      .toEqual([baseFile, baseFile]);
    expect(messages.info.join('\n')).not.toContain('未找到同名');
  });

  // Prove-red:把递归续跳的 runSwitch(next, openedPath) 改回 runSwitch(next)
  // (丢 sourceFile 穿透) → 续跳重新读陈旧编辑器 cell,本例第二次打开变 base,
  // 断言 [base, cell] 失败。钉「续跳以刚打开的文件为源」。
  it('续跳以刚打开的文件为源:sourceFile 穿透递归,不重读在途编辑器变化', async () => {
    root = makeTree();
    const editorHook = installEditorChangeHook();
    const subscriptions: Array<{ dispose(): void }> = [];
    registerProcessOwnershipSwitchCommands({ subscriptions } as unknown as never);
    stubWindow.activeTextEditor = {
      document: { fileName: join(root, 'scripts', 'cell', 'Hero.py') }
    } as never;
    const slow = deferShowTextDocument();
    const press1 = commands.executeCommand(KBENGINE_PROCESS_OWNERSHIP_OPEN_BASE_COMMAND);
    const press2 = commands.executeCommand(KBENGINE_PROCESS_OWNERSHIP_OPEN_BASE_COMMAND);
    await new Promise(resolve => setTimeout(resolve, 0));
    // 在途期间用户跳到 scripts 外的第三处(账因真实导航作废):续跳仍须以
    // 刚打开的 base 文件为源,不能误读编辑器(否则会从「判不出」的第三处
    // 报错)。2026-11-27 同侧翻转后,B 从 base 翻回 cell → 第二次真打开
    // cell(若误读编辑器则两次都停在 base 或报「判不出」)。
    const elsewhere = join(root, 'elsewhere', 'Hero.py');
    stubWindow.activeTextEditor = { document: { fileName: elsewhere } } as never;
    editorHook.fire(elsewhere);
    await slow.releaseAll();
    await Promise.all([press1, press2]);
    expect(slow.calls.map(call => call.fsPath)).toEqual([
      join(root, 'scripts', 'base', 'Hero.py'),
      join(root, 'scripts', 'cell', 'Hero.py')
    ]);
    expect(messages.info.join('\n')).not.toContain('判不出进程归属');
  });

  // Prove-red:把 latestQueued=process 改成首次入队不覆盖(if (!latestQueued))
  // → 第三发 B 被先到的 C 压住,续跳打开 cell,本例「只开一次」断言失败。
  it('在途连按 B→C→B:只认最新一次(B),不是首个入队请求', async () => {
    root = makeTree();
    const subscriptions: Array<{ dispose(): void }> = [];
    registerProcessOwnershipSwitchCommands({ subscriptions } as unknown as never);
    stubWindow.activeTextEditor = {
      document: { fileName: join(root, 'scripts', 'cell', 'Hero.py') }
    } as never;
    const slow = deferShowTextDocument();
    const press1 = commands.executeCommand(KBENGINE_PROCESS_OWNERSHIP_OPEN_BASE_COMMAND);
    const press2 = commands.executeCommand(KBENGINE_PROCESS_OWNERSHIP_OPEN_CELL_COMMAND);
    const press3 = commands.executeCommand(KBENGINE_PROCESS_OWNERSHIP_OPEN_BASE_COMMAND);
    await slow.releaseAll();
    await Promise.all([press1, press2, press3]);
    // 首跳 cell→base;最新请求仍是 B,2026-11-27 同侧翻转后从 base 翻回
    // cell → 第二次真打开 cell(钉「只认最新 B」而不是首个入队的 C:若取
    // C 则从 base 跨侧打开 base 自己,断言仍对;故另钉末态落在 cell)。
    expect(slow.calls.map(call => call.fsPath)).toEqual([
      join(root, 'scripts', 'base', 'Hero.py'),
      join(root, 'scripts', 'cell', 'Hero.py')
    ]);
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

  it('同向连按 B,B:续跳以刚打开的 base 为源,同侧翻转落 cell(停泊侧账)', async () => {
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
    // 第一发打开 base;续跳 B 以刚打开的 base 为源(sourceFile 穿透,若误读
    // 陈旧编辑器 cell 则第二次又开 base)→ 2026-11-27 同侧翻转落 cell。
    // 注:toggle 语义下「只认最新 B/C」的方向区分已退化(从 base 侧两键都
    // 落 cell),本例钉「入队续跳恰好执行一次且落翻转目标」,双开/零开都红。
    expect(slow.calls.map(call => call.fsPath)).toEqual([
      join(root, 'scripts', 'base', 'Hero.py'),
      join(root, 'scripts', 'cell', 'Hero.py')
    ]);
  });
});
