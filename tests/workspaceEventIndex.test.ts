import { expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import { WorkspaceIndex } from '../src/workspaceIndex';
import { EventCodeLensProvider } from '../src/eventApi';
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

it('首扫发现失败后，下次事件查询可重新初始化', async () => {
  const originalFind = vscode.workspace.findFiles;
  const find = vi.fn()
    .mockRejectedValueOnce(new Error('discovery failed'))
    .mockResolvedValueOnce([]);
  vscode.workspace.findFiles = find;
  const index = new WorkspaceIndex();
  try {
    await expect(index.allEventCalls()).rejects.toThrow('discovery failed');
    await expect(index.allEventCalls()).resolves.toEqual([]);
    expect(find).toHaveBeenCalledTimes(2);
  } finally {
    index.dispose();
    vscode.workspace.findFiles = originalFind;
  }
});

it('销毁后在途文件读取不能重新发布事件索引或创建 watcher', async () => {
  const originalFind = vscode.workspace.findFiles;
  const originalOpen = vscode.workspace.openTextDocument;
  const uri = vscode.Uri.file('/ws/listener.py');
  let release!: (doc: vscode.TextDocument) => void;
  const reading = new Promise<vscode.TextDocument>(resolve => { release = resolve; });
  vscode.workspace.findFiles = async () => [uri];
  vscode.workspace.openTextDocument = () => reading;
  const watcher = vi.spyOn(vscode.workspace, 'createFileSystemWatcher');
  const index = new WorkspaceIndex();
  try {
    const query = index.allEventCalls();
    await Promise.resolve();
    index.dispose();
    release(makeTextDocument('self.addEvent(EV, self.on_ev)', {
      fileName: uri.fsPath, languageId: 'python'
    }) as vscode.TextDocument);
    expect(await query).toEqual([]);
    expect(await index.allEventCalls()).toEqual([]);
    expect(watcher).not.toHaveBeenCalled();
  } finally {
    index.dispose();
    watcher.mockRestore();
    vscode.workspace.findFiles = originalFind;
    vscode.workspace.openTextDocument = originalOpen;
  }
});

it('事件 provider 销毁时释放自己的 watcher', async () => {
  const originalFind = vscode.workspace.findFiles;
  const originalWatcher = vscode.workspace.createFileSystemWatcher;
  const dispose = vi.fn();
  const listen = () => ({ dispose: () => {} });
  vscode.workspace.findFiles = async () => [];
  vscode.workspace.createFileSystemWatcher = () => ({
    onDidCreate: listen, onDidChange: listen, onDidDelete: listen, dispose
  }) as unknown as vscode.FileSystemWatcher;
  const provider = new EventCodeLensProvider();
  try {
    const doc = makeTextDocument('self.emitEvent(EV)', { fileName: '/ws/a.py', languageId: 'python' }) as vscode.TextDocument;
    await provider.provideCodeLenses(doc);
    provider.dispose();
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(await provider.provideCodeLenses(doc)).toEqual([]);
  } finally {
    vscode.workspace.findFiles = originalFind;
    vscode.workspace.createFileSystemWatcher = originalWatcher;
  }
});
