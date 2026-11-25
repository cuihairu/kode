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
