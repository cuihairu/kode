import { expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import { WorkspaceIndex } from '../src/workspaceIndex';
import { makeTextDocument } from './helpers/vscodeStub';

it('并发事件查询等待同一次首扫完成', async () => {
  const originalFind = vscode.workspace.findFiles;
  const originalOpen = vscode.workspace.openTextDocument;
  const uri = vscode.Uri.file('/ws/listener.py');
  let release!: (files: vscode.Uri[]) => void;
  const discovery = new Promise<vscode.Uri[]>(resolve => { release = resolve; });
  const find = vi.fn(() => discovery);
  vscode.workspace.findFiles = find;
  vscode.workspace.openTextDocument = async () => makeTextDocument('self.addEvent(EV, self.on_ev)', {
    fileName: uri.fsPath, languageId: 'python'
  }) as vscode.TextDocument;
  const index = new WorkspaceIndex();
  try {
    const first = index.allEventCalls();
    let secondDone = false;
    const second = index.allEventCalls().then(value => { secondDone = true; return value; });
    await Promise.resolve();
    expect(secondDone).toBe(false);
    expect(find).toHaveBeenCalledTimes(1);
    release([uri]);
    const [a, b] = await Promise.all([first, second]);
    expect(a).toHaveLength(1);
    expect(b).toEqual(a);
  } finally {
    index.dispose();
    vscode.workspace.findFiles = originalFind;
    vscode.workspace.openTextDocument = originalOpen;
  }
});
