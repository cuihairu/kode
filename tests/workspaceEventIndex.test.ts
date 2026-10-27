import { expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { WorkspaceIndex } from '../src/workspaceIndex';
import { EventCodeLensProvider } from '../src/eventApi';
import { configurationOverrides, lastFileSystemWatcher, makeTextDocument, workspaceEvents } from './helpers/vscodeStub';
import { resetScanRootCache } from '../src/scanRoots';

it('事件首扫后台读取文件，不打开其他文档并保留行号', async () => {
  const originalFind = vscode.workspace.findFiles;
  const originalRead = vscode.workspace.fs.readFile;
  const originalOpen = vscode.workspace.openTextDocument;
  const uri = vscode.Uri.file('/ws/listener.py');
  const open = vi.fn(originalOpen);
  vscode.workspace.findFiles = async () => [uri];
  vscode.workspace.fs.readFile = async () => Buffer.from('# heading\r\nself.addEvent(EV, self.on_ev)');
  vscode.workspace.openTextDocument = open;
  const index = new WorkspaceIndex();
  try {
    expect(await index.allEventCalls()).toMatchObject([{ file: uri.fsPath, line: 1 }]);
    expect(open).not.toHaveBeenCalled();
  } finally {
    index.dispose();
    vscode.workspace.findFiles = originalFind;
    vscode.workspace.fs.readFile = originalRead;
    vscode.workspace.openTextDocument = originalOpen;
  }
});

it('事件首扫包含外部 assetsRoot 并排除共享规则中的目录', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-events-roots-'));
  const workspaceRoot = path.join(root, 'workspace');
  const assetsRoot = path.join(root, 'assets');
  fs.mkdirSync(workspaceRoot);
  fs.mkdirSync(path.join(assetsRoot, 'venv'), { recursive: true });
  fs.mkdirSync(path.join(assetsRoot, 'third_party'));
  fs.writeFileSync(path.join(assetsRoot, 'listener.py'), 'self.addEvent(EV, self.on_ev)');
  fs.writeFileSync(path.join(assetsRoot, 'venv', 'excluded.py'), 'self.addEvent(BAD, self.on_ev)');
  fs.writeFileSync(path.join(assetsRoot, 'third_party', 'excluded.py'), 'self.addEvent(BAD, self.on_ev)');
  const originalFolders = vscode.workspace.workspaceFolders;
  const originalFind = vscode.workspace.findFiles;
  const originalRead = vscode.workspace.fs.readFile;
  vscode.workspace.workspaceFolders = [{ uri: vscode.Uri.file(workspaceRoot), name: 'ws', index: 0 }];
  configurationOverrides.set('kbengine', { assetsRoot });
  vscode.workspace.findFiles = async () => [];
  vscode.workspace.fs.readFile = async uri => fs.promises.readFile(uri.fsPath);
  resetScanRootCache();
  const index = new WorkspaceIndex();
  try {
    const calls = await index.allEventCalls();
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ file: path.join(assetsRoot, 'listener.py'), call: { event: 'EV' } });
  } finally {
    index.dispose();
    vscode.workspace.workspaceFolders = originalFolders;
    vscode.workspace.findFiles = originalFind;
    vscode.workspace.fs.readFile = originalRead;
    configurationOverrides.delete('kbengine');
    resetScanRootCache();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

it('事件首扫限制并发并在索引取消后停止启动读取', async () => {
  const originalFind = vscode.workspace.findFiles;
  const originalRead = vscode.workspace.fs.readFile;
  const files = Array.from({ length: 24 }, (_, i) => vscode.Uri.file(`/ws/${i}.py`));
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let active = 0;
  let peak = 0;
  const read = vi.fn(async () => {
    active += 1;
    peak = Math.max(peak, active);
    await gate;
    active -= 1;
    return Buffer.from('pass');
  });
  vscode.workspace.findFiles = async () => files;
  vscode.workspace.fs.readFile = read;
  const index = new WorkspaceIndex();
  try {
    const pending = index.allEventCalls();
    await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(8));
    expect(peak).toBe(8);
    index.dispose();
    release();
    await pending;
    expect(read).toHaveBeenCalledTimes(8);
  } finally {
    index.dispose();
    vscode.workspace.findFiles = originalFind;
    vscode.workspace.fs.readFile = originalRead;
  }
});

it('事件首扫在并发上限下处理所有文件', async () => {
  const originalFind = vscode.workspace.findFiles;
  const originalRead = vscode.workspace.fs.readFile;
  const files = Array.from({ length: 20 }, (_, i) => vscode.Uri.file(`/ws/${i}.py`));
  let active = 0;
  let peak = 0;
  vscode.workspace.findFiles = async () => files;
  vscode.workspace.fs.readFile = async () => {
    active += 1;
    peak = Math.max(peak, active);
    await Promise.resolve();
    active -= 1;
    return Buffer.from('self.addEvent(EV, self.on_ev)');
  };
  const index = new WorkspaceIndex();
  try {
    expect(await index.allEventCalls()).toHaveLength(files.length);
    expect(peak).toBeLessThanOrEqual(8);
  } finally {
    index.dispose();
    vscode.workspace.findFiles = originalFind;
    vscode.workspace.fs.readFile = originalRead;
  }
});

it('编辑缓冲区增删事件后查询立即看到新版本', async () => {
  const originalFind = vscode.workspace.findFiles;
  vscode.workspace.findFiles = async () => [];
  const index = new WorkspaceIndex();
  try {
    await index.allEventCalls();
    const fileName = '/ws/listener.py';
    const added = makeTextDocument('self.addEvent(EV, self.on_ev)', { fileName, languageId: 'python' });
    workspaceEvents.documentChanged.fire({ document: added });
    expect(await index.allEventCalls()).toMatchObject([{ file: fileName, call: { event: 'EV' } }]);
    const removed = makeTextDocument('pass', { fileName, languageId: 'python' });
    workspaceEvents.documentChanged.fire({ document: removed });
    expect(await index.allEventCalls()).toEqual([]);
  } finally {
    index.dispose();
    vscode.workspace.findFiles = originalFind;
  }
});

it('首扫旧磁盘读取结束时不能覆盖期间的编辑', async () => {
  const originalFind = vscode.workspace.findFiles;
  const originalRead = vscode.workspace.fs.readFile;
  const uri = vscode.Uri.file('/ws/listener.py');
  let release!: (bytes: Uint8Array) => void;
  let start!: () => void;
  const started = new Promise<void>(resolve => { start = resolve; });
  const reading = new Promise<Uint8Array>(resolve => { release = resolve; });
  vscode.workspace.findFiles = async () => [uri];
  vscode.workspace.fs.readFile = () => { start(); return reading; };
  const index = new WorkspaceIndex();
  try {
    const pending = index.allEventCalls();
    await started;
    const edited = makeTextDocument('self.addEvent(NEW, self.on_ev)', { fileName: uri.fsPath, languageId: 'python' });
    workspaceEvents.documentChanged.fire({ document: edited });
    release(Buffer.from('self.addEvent(OLD, self.on_ev)'));
    expect(await pending).toMatchObject([{ call: { event: 'NEW' } }]);
  } finally {
    index.dispose();
    vscode.workspace.findFiles = originalFind;
    vscode.workspace.fs.readFile = originalRead;
  }
});

it('首扫发现文件期间发生的编辑不会被后续磁盘读取覆盖', async () => {
  const originalFind = vscode.workspace.findFiles;
  const originalRead = vscode.workspace.fs.readFile;
  const uri = vscode.Uri.file('/ws/listener.py');
  let release!: (files: vscode.Uri[]) => void;
  vscode.workspace.findFiles = () => new Promise(resolve => { release = resolve; });
  const read = vi.fn(async () => Buffer.from('self.addEvent(OLD, self.on_ev)'));
  vscode.workspace.fs.readFile = read;
  const index = new WorkspaceIndex();
  try {
    const pending = index.allEventCalls();
    const edited = makeTextDocument('self.addEvent(NEW, self.on_ev)', { fileName: uri.fsPath, languageId: 'python' });
    workspaceEvents.documentChanged.fire({ document: edited });
    release([uri]);
    expect(await pending).toMatchObject([{ call: { event: 'NEW' } }]);
    expect(read).not.toHaveBeenCalled();
  } finally {
    index.dispose();
    vscode.workspace.findFiles = originalFind;
    vscode.workspace.fs.readFile = originalRead;
  }
});

it('删除监听文件后事件记录消失', async () => {
  const originalFind = vscode.workspace.findFiles;
  const originalRead = vscode.workspace.fs.readFile;
  const uri = vscode.Uri.file('/ws/listener.py');
  vscode.workspace.findFiles = async () => [uri];
  vscode.workspace.fs.readFile = async () => Buffer.from('self.addEvent(EV, self.on_ev)');
  const index = new WorkspaceIndex();
  try {
    expect(await index.allEventCalls()).toHaveLength(1);
    const provider = new EventCodeLensProvider(index);
    const emitter = makeTextDocument('self.emitEvent(EV)', { fileName: '/ws/emitter.py', languageId: 'python' }) as vscode.TextDocument;
    expect(await provider.provideCodeLenses(emitter)).toHaveLength(1);
    lastFileSystemWatcher.current!.fireDelete(uri);
    expect(await index.allEventCalls()).toEqual([]);
    expect(await provider.provideCodeLenses(emitter)).toEqual([]);
    provider.dispose();
  } finally {
    index.dispose();
    vscode.workspace.findFiles = originalFind;
    vscode.workspace.fs.readFile = originalRead;
  }
});

it('重命名监听文件后只跳转新路径', async () => {
  const originalFind = vscode.workspace.findFiles;
  const originalRead = vscode.workspace.fs.readFile;
  const oldUri = vscode.Uri.file('/ws/old.py');
  const newUri = vscode.Uri.file('/ws/new.py');
  vscode.workspace.findFiles = async () => [oldUri];
  vscode.workspace.fs.readFile = async () => Buffer.from('self.addEvent(EV, self.on_ev)');
  const index = new WorkspaceIndex();
  const provider = new EventCodeLensProvider(index);
  try {
    await index.allEventCalls();
    workspaceEvents.filesRenamed.fire({ files: [{ oldUri, newUri }] });
    expect(await index.allEventCalls()).toMatchObject([{ file: newUri.fsPath }]);
    const emitter = makeTextDocument('self.emitEvent(EV)', { fileName: '/ws/emitter.py', languageId: 'python' }) as vscode.TextDocument;
    const lenses = await provider.provideCodeLenses(emitter);
    expect(lenses).toHaveLength(1);
    expect(lenses[0].command?.arguments?.[0]).toMatchObject({ fsPath: newUri.fsPath });
  } finally {
    provider.dispose();
    index.dispose();
    vscode.workspace.findFiles = originalFind;
    vscode.workspace.fs.readFile = originalRead;
  }
});

it('并发事件查询等待同一次首扫完成', async () => {
  const originalFind = vscode.workspace.findFiles;
  const originalRead = vscode.workspace.fs.readFile;
  const uri = vscode.Uri.file('/ws/listener.py');
  let release!: (files: vscode.Uri[]) => void;
  const discovery = new Promise<vscode.Uri[]>(resolve => { release = resolve; });
  const find = vi.fn(() => discovery);
  vscode.workspace.findFiles = find;
  vscode.workspace.fs.readFile = async () => Buffer.from('self.addEvent(EV, self.on_ev)');
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
    vscode.workspace.fs.readFile = originalRead;
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
  const originalRead = vscode.workspace.fs.readFile;
  const uri = vscode.Uri.file('/ws/listener.py');
  let release!: (bytes: Uint8Array) => void;
  const reading = new Promise<Uint8Array>(resolve => { release = resolve; });
  vscode.workspace.findFiles = async () => [uri];
  vscode.workspace.fs.readFile = () => reading;
  const watcher = vi.spyOn(vscode.workspace, 'createFileSystemWatcher');
  const index = new WorkspaceIndex();
  try {
    const query = index.allEventCalls();
    await Promise.resolve();
    index.dispose();
    release(Buffer.from('self.addEvent(EV, self.on_ev)'));
    expect(await query).toEqual([]);
    expect(await index.allEventCalls()).toEqual([]);
    expect(watcher).not.toHaveBeenCalled();
  } finally {
    index.dispose();
    watcher.mockRestore();
    vscode.workspace.findFiles = originalFind;
    vscode.workspace.fs.readFile = originalRead;
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
  const providerIndex = new WorkspaceIndex();
  const provider = new EventCodeLensProvider(providerIndex);
  try {
    const doc = makeTextDocument('self.emitEvent(EV)', { fileName: '/ws/a.py', languageId: 'python' }) as vscode.TextDocument;
    await provider.provideCodeLenses(doc);
    provider.dispose();
    providerIndex.dispose();
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(await provider.provideCodeLenses(doc)).toEqual([]);
  } finally {
    vscode.workspace.findFiles = originalFind;
    vscode.workspace.createFileSystemWatcher = originalWatcher;
  }
});

it('共享同一索引的多个 provider 只扫一次仓(统一索引复用)', async () => {
  const originalFind = vscode.workspace.findFiles;
  const originalRead = vscode.workspace.fs.readFile;
  const uri = vscode.Uri.file('/ws/listener.py');
  const findFiles = vi.fn(async () => [uri]);
  vscode.workspace.findFiles = findFiles as unknown as typeof originalFind;
  vscode.workspace.fs.readFile = async () => Buffer.from('self.addEvent(EV, self.on_ev)');
  const shared = new WorkspaceIndex();
  try {
    const a = new EventCodeLensProvider(shared);
    const b = new EventCodeLensProvider(shared);
    const docA = makeTextDocument('self.emitEvent(EV)\n', { fileName: '/ws/a.py', languageId: 'python' }) as vscode.TextDocument;
    const docB = makeTextDocument('self.emitEvent(EV)\n', { fileName: '/ws/b.py', languageId: 'python' }) as vscode.TextDocument;
    await a.provideCodeLenses(docA);
    await b.provideCodeLenses(docB);
    await a.provideCodeLenses(docA);
    // 全仓扫描入口只有共享索引一个:多 provider/多次调用不再触发第二次首扫
    expect(findFiles).toHaveBeenCalledTimes(1);
  } finally {
    shared.dispose();
    vscode.workspace.findFiles = originalFind;
    vscode.workspace.fs.readFile = originalRead;
  }
});
