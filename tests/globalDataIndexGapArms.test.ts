import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GlobalDataDictIndex } from '../src/globalDataIndex';
import { resetScanRootCache } from '../src/scanRoots';
import * as vscode from 'vscode';
import { workspaceEvents } from './helpers/vscodeStub';
import { configurationOverrides } from './fake-vscode/workspaceState';

// globalDataIndex 缺口臂(2026-11-09 覆盖率扫尾):关闭文档监听(已销毁/非
// py/脏缓冲释放+盘重扫)、重命名到非 py 后缀、根移除(整根撤贡献/仍属他
// 根重建/脏文档缓冲优先)、调用键跨文件依赖重扫(函数定义变化触发引用方
// 重扫、调用键移除清依赖边)。

const tmpRoots: string[] = [];
const makeTmp = (label: string): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `kode-gdi-gap-${label}-`));
  tmpRoots.push(dir);
  return dir;
};

let originalFind: typeof vscode.workspace.findFiles;
let originalRead: typeof vscode.workspace.fs.readFile;
let originalFolders: typeof vscode.workspace.workspaceFolders;

const wireFs = (files: string[]) => {
  vscode.workspace.findFiles = (async () => files.map(file => vscode.Uri.file(file))) as typeof vscode.workspace.findFiles;
  vscode.workspace.fs.readFile = (async (uri: { fsPath: string }) => fs.readFileSync(uri.fsPath)) as typeof vscode.workspace.fs.readFile;
};

const makeIndex = async (files: string[]): Promise<GlobalDataDictIndex> => {
  wireFs(files);
  const index = new GlobalDataDictIndex();
  await index.ensureStarted();
  return index;
};

beforeEach(() => {
  originalFind = vscode.workspace.findFiles;
  originalRead = vscode.workspace.fs.readFile;
  originalFolders = vscode.workspace.workspaceFolders;
});

afterEach(() => {
  vscode.workspace.findFiles = originalFind;
  vscode.workspace.fs.readFile = originalRead;
  vscode.workspace.workspaceFolders = originalFolders;
  configurationOverrides.delete('kbengine');
  resetScanRootCache();
  for (const dir of tmpRoots.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('globalDataIndex 缺口臂:关闭文档监听', () => {
  it('已销毁索引关闭文档:监听器早退,零副作用', async () => {
    const root = makeTmp('close-disposed');
    const py = path.join(root, 'a.py');
    fs.writeFileSync(py, 'import KBEngine\nKBEngine.globalData["k"] = 1\n');
    vscode.workspace.workspaceFolders = [{ uri: vscode.Uri.file(root), name: 'ws', index: 0 }];
    const index = await makeIndex([py]);
    index.dispose();
    workspaceEvents.documentClosed.fire({ uri: vscode.Uri.file(py) });
    expect(index.query('globalData', 'k')).toEqual([]); // 已销毁:查询静默空
  });

  it('非 py 文件关闭:监听器早退,不碰 editBuffers', async () => {
    const root = makeTmp('close-nonpy');
    const txt = path.join(root, 'notes.txt');
    fs.writeFileSync(txt, 'hello');
    vscode.workspace.workspaceFolders = [{ uri: vscode.Uri.file(root), name: 'ws', index: 0 }];
    const index = await makeIndex([txt]);
    index.noteSaved({ uri: { fsPath: txt }, getText: () => 'hello' } as never);
    workspaceEvents.documentClosed.fire({ uri: vscode.Uri.file(txt) });
    expect(index.query('globalData', 'k')).toEqual([]);
  });

  it('py 脏文档关闭:缓冲释放,盘版本重扫覆盖索引', async () => {
    const root = makeTmp('close-dirty');
    const py = path.join(root, 'a.py');
    // 盘上:键 k;脏缓冲(未保存):键 z
    fs.writeFileSync(py, 'import KBEngine\nKBEngine.globalData["k"] = 1\n');
    vscode.workspace.workspaceFolders = [{ uri: vscode.Uri.file(root), name: 'ws', index: 0 }];
    const index = await makeIndex([py]);
    // 倒排键带根身份(query 默认 root='' 只命中无根/外部扫描根;单工作区根下
    // 文件按 resolveScopeRoot=根 入键,查询必须带同名根)
    expect(index.query('globalData', 'k', root).length).toBeGreaterThan(0);
    // isDirty 标记为脏:close 监听按 dirtyDocs 门(盘版本重扫)走
    index.noteSaved({ uri: { fsPath: py }, getText: () => 'import KBEngine\nKBEngine.globalData["z"] = 2\n', isDirty: true } as never);
    expect(index.query('globalData', 'z', root).length).toBeGreaterThan(0);
    // 关文档:脏缓冲弃,盘版本(k)重扫回索引
    workspaceEvents.documentClosed.fire({ uri: vscode.Uri.file(py) });
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(index.query('globalData', 'k', root).length).toBeGreaterThan(0);
    expect(index.query('globalData', 'z', root)).toEqual([]);
  });
});

describe('globalDataIndex 缺口臂:重命名与根移除', () => {
  it('重命名到非 py 后缀:函数定义表旧键摘除,不倒排迁移', async () => {
    const root = makeTmp('rename-nonpy');
    const py = path.join(root, 'a.py');
    const txt = path.join(root, 'a.txt');
    fs.writeFileSync(py, 'import KBEngine\nKBEngine.globalData["k"] = 1\n');
    vscode.workspace.workspaceFolders = [{ uri: vscode.Uri.file(root), name: 'ws', index: 0 }];
    const index = await makeIndex([py]);
    workspaceEvents.filesRenamed.fire({
      files: [{ oldUri: vscode.Uri.file(py), newUri: vscode.Uri.file(txt) }]
    });
    await new Promise(resolve => setTimeout(resolve, 20));
    // 非 py 新路径:倒排旧键撤除
    expect(index.query('globalData', 'k')).toEqual([]);
  });

  it('根移除:整根贡献撤回,文件仍属他根则重建', async () => {
    const rootA = makeTmp('root-a');
    const rootB = makeTmp('root-b');
    const aPy = path.join(rootA, 'a.py');
    const bPy = path.join(rootB, 'b.py');
    fs.writeFileSync(aPy, 'import KBEngine\nKBEngine.globalData["k"] = 1\n');
    fs.writeFileSync(bPy, 'import KBEngine\nv = KBEngine.globalData.get("k")\n');
    vscode.workspace.workspaceFolders = [
      { uri: vscode.Uri.file(rootA), name: 'A', index: 0 },
      { uri: vscode.Uri.file(rootB), name: 'B', index: 1 }
    ];
    const index = await makeIndex([aPy, bPy]);
    // 两文件分属两根:各自按根身份入键
    expect(index.query('globalData', 'k', rootA).map(s => s.kind)).toEqual(['write']);
    expect(index.query('globalData', 'k', rootB).map(s => s.kind)).toEqual(['read']);
    // 移除根 A:A 下 a.py 贡献撤回,只剩 B 读点
    vscode.workspace.workspaceFolders = [{ uri: vscode.Uri.file(rootB), name: 'B', index: 0 }];
    workspaceEvents.foldersChanged.fire({
      removed: [{ uri: vscode.Uri.file(rootA) }],
      added: []
    });
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(index.query('globalData', 'k', rootA)).toEqual([]); // A 根撤回
    const sites = index.query('globalData', 'k', rootB);
    expect(sites.map(s => s.kind)).toEqual(['read']);
    expect(sites[0].file).toBe(bPy);
  });
});

describe('globalDataIndex 缺口臂:调用键跨文件依赖重扫', () => {
  it('函数定义变化触发引用方重扫:调用键解析出新签名', async () => {
    const root = makeTmp('callkey');
    const defPy = path.join(root, 'defs.py');
    const usePy = path.join(root, 'use.py');
    // defs.py:返回 "cfg";use.py:KBEngine.globalData[k()] 调用键
    fs.writeFileSync(defPy, 'def k():\n    return "cfg"\n');
    fs.writeFileSync(usePy, 'import KBEngine\nKBEngine.globalData[k()] = 1\n');
    vscode.workspace.workspaceFolders = [{ uri: vscode.Uri.file(root), name: 'ws', index: 0 }];
    const index = await makeIndex([defPy, usePy]);
    // 基线:调用键经 k→cfg 解析,use.py 写点挂在 cfg
    const before = index.query('globalData', 'cfg', root);
    expect(before.some(s => s.kind === 'write' && s.file === usePy)).toBe(true);
    // defs.py 改 k→other:引用方 use.py 重扫,写点迁 other
    fs.writeFileSync(defPy, 'def k():\n    return "other"\n');
    index.noteSaved({ uri: { fsPath: defPy }, getText: () => fs.readFileSync(defPy, 'utf8') } as never);
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(index.query('globalData', 'other', root).some(s => s.kind === 'write' && s.file === usePy)).toBe(true);
    expect(index.query('globalData', 'cfg', root).some(s => s.kind === 'write' && s.file === usePy)).toBe(false);
  });

  it('调用键从文件移除:依赖边清除,文件不再重扫', async () => {
    const root = makeTmp('callkey-drop');
    const defPy = path.join(root, 'defs.py');
    const usePy = path.join(root, 'use.py');
    fs.writeFileSync(defPy, 'def k():\n    return "cfg"\n');
    fs.writeFileSync(usePy, 'import KBEngine\nKBEngine.globalData[k()] = 1\n');
    vscode.workspace.workspaceFolders = [{ uri: vscode.Uri.file(root), name: 'ws', index: 0 }];
    const index = await makeIndex([defPy, usePy]);
    expect(index.query('globalData', 'cfg', root).some(s => s.kind === 'write' && s.file === usePy)).toBe(true);
    // use.py 改字面量(去掉调用键)→ cfg 写点按字面量仍挂 use.py(键未变),
    // 但依赖边 k→use 已清
    const literal = 'import KBEngine\nKBEngine.globalData["cfg"] = 2\n';
    index.noteSaved({ uri: { fsPath: usePy }, getText: () => literal } as never);
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(index.query('globalData', 'cfg', root).some(s => s.kind === 'write' && s.file === usePy)).toBe(true);
    // defs.py 再改 k→zzz:use.py 已无调用键,不应再被重扫(仍挂 cfg)
    fs.writeFileSync(defPy, 'def k():\n    return "zzz"\n');
    index.noteSaved({ uri: { fsPath: defPy }, getText: () => fs.readFileSync(defPy, 'utf8') } as never);
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(index.query('globalData', 'cfg', root).some(s => s.kind === 'write' && s.file === usePy)).toBe(true);
  });
});
