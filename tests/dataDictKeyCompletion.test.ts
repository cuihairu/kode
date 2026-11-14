/**
 * KSEM-DATA-02(SEM-043)补共享数据键补全 — 验收钉。
 *
 * 验收口径(todo.md SEM-043):按工程和共享数据域列 key 与写入来源,静态
 * 常量按真实绑定解析,不把同名标识符恒当同一键值。
 *
 * 三面:
 *  - 键位上下文(纯核 dataDictKeyCompletionContext):`alias.globalData[“…`
 *    / `.get(“…` / 光标刚过 `[` 的键位识别 + 属性链/非字典接收者拒接;
 *  - 模块常量真实绑定(纯核 extractModuleConstantBindings + 扫描/查询双
 *    侧同口径):顶格字面量赋值→值;同名不同文件绑不同值→不同键族;冲突
 *    重绑/缩进赋值/非字面量 RHS→诚实退回标识符名;
 *  - 补全面(KBEngineCompletionProvider + GlobalDataDictIndex):同根同
 *    字典键族列表 + 写点来源 detail + 部分键过滤 + 工程隔离 + 开关静默。
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import * as vscode from 'vscode';
import { EntityMappingManager } from '../src/entityMapping';
import { KBEngineCompletionProvider, setPythonDataDictIndexEnabled } from '../src/languageProviders';
import { GlobalDataDictIndex } from '../src/globalDataIndex';
import {
  dataDictKeyCompletionContext,
  extractModuleConstantBindings,
  findKbeDataDictAccesses,
  getDataDictAccessInCodeContext
} from '../src/backend/globalDataIndexCore';
import { getKbeAliases } from '../src/kbeModuleIndex';

const ALIASES = new Set(['KBEngine', 'kbe']);
const stubManager = (): EntityMappingManager =>
  new EntityMappingManager({ subscriptions: [] } as never);

describe('KSEM-DATA-02 键位上下文(纯核)', () => {
  it('引号内片段:dict/部分键/替换起点三件齐', () => {
    const line = 'value = KBEngine.globalData["ser';
    const ctx = dataDictKeyCompletionContext(line, line.length, ALIASES);
    expect(ctx).not.toBeNull();
    expect(ctx!.dict).toBe('globalData');
    expect(ctx!.partial).toBe('ser');
    // 替换起点 = 引号后(不含引号)
    expect(ctx!.replaceStart).toBe(line.length - 3);
  });

  it('光标刚过 `[` 与 `.get(`:空片段即插位', () => {
    const bracket = 'KBEngine.globalData[';
    expect(dataDictKeyCompletionContext(bracket, bracket.length, ALIASES)).toEqual({
      dict: 'globalData',
      partial: '',
      replaceStart: bracket.length
    });
    const getCall = 'KBEngine.cellAppData.get("';
    expect(dataDictKeyCompletionContext(getCall, getCall.length, ALIASES)).toEqual({
      dict: 'cellAppData',
      partial: '',
      replaceStart: getCall.length
    });
  });

  it('kbe 别名与 baseAppData 域照常识别', () => {
    const line = 'kbe.baseAppData["bk';
    const ctx = dataDictKeyCompletionContext(line, line.length, ALIASES);
    expect(ctx?.dict).toBe('baseAppData');
    expect(ctx?.partial).toBe('bk');
  });

  it('属性链(x.KBEngine.globalData)与非字典接收者不接管', () => {
    const chained = 'x.KBEngine.globalData["k';
    expect(dataDictKeyCompletionContext(chained, chained.length, ALIASES)).toBeNull();
    const plain = 'mydict["k';
    expect(dataDictKeyCompletionContext(plain, plain.length, ALIASES)).toBeNull();
  });

  it('别名集为空:无键位(诚实边界)', () => {
    const line = 'KBEngine.globalData["k';
    expect(dataDictKeyCompletionContext(line, line.length, new Set())).toBeNull();
  });
});

describe('KSEM-DATA-02 模块常量真实绑定(纯核,扫描/查询双侧)', () => {
  it('顶格字面量赋值入绑定;注解形态同;尾注释剥;冲突重绑→null', () => {
    const text = [
      'KEY = "server_id"',
      'OTHER: str = "gate"  # trailing comment',
      'KEY = "server_id"',
      'CONFLICT = "a"',
      'CONFLICT = "b"',
      'DYN = getConfig()',
      'F = f"srv_{i}"'
    ].join('\n');
    const bindings = extractModuleConstantBindings(text);
    expect(bindings.get('KEY')).toBe('server_id');
    expect(bindings.get('OTHER')).toBe('gate');
    expect(bindings.get('CONFLICT')).toBeNull();
    expect(bindings.has('DYN')).toBe(false);
    expect(bindings.has('F')).toBe(false);
  });

  it('缩进赋值(函数体)不是模块作用域:不入绑定', () => {
    const text = 'def f():\n    KEY = "inner"\n    return KEY\n';
    expect(extractModuleConstantBindings(text).size).toBe(0);
  });

  it('扫描侧:globalData[KEY] 按真实绑定解析为绑定值签名', () => {
    const text = 'import KBEngine\nKEY = "server_id"\nKBEngine.globalData[KEY] = 1\n';
    const sites = findKbeDataDictAccesses(text, ALIASES);
    expect(sites).toHaveLength(1);
    expect(sites[0].keySignature).toBe('server_id');
  });

  it('无绑定/冲突/缩进三种退化:签名退回标识符名(不猜)', () => {
    const unbound = 'import KBEngine\nKBEngine.globalData[KEY] = 1\n';
    expect(findKbeDataDictAccesses(unbound, ALIASES)[0].keySignature).toBe('KEY');
    const conflict = 'import KBEngine\nKEY = "a"\nKEY = "b"\nKBEngine.globalData[KEY] = 1\n';
    expect(findKbeDataDictAccesses(conflict, ALIASES)[0].keySignature).toBe('KEY');
    const indented = 'import KBEngine\ndef f():\n    KEY = "a"\nKBEngine.globalData[KEY] = 1\n';
    expect(findKbeDataDictAccesses(indented, ALIASES)[0].keySignature).toBe('KEY');
  });

  it('查询侧同口径:读点位置查询解析出同一绑定签名(否则索引面失配)', () => {
    const text = 'import KBEngine\nKEY = "server_id"\nv = KBEngine.globalData[KEY]\n';
    const line = text.split('\n')[2];
    const access = getDataDictAccessInCodeContext(text, 2, line.indexOf('KEY') + 1, ALIASES);
    expect(access?.keySignature).toBe('server_id');
  });
});

describe('KSEM-DATA-02 键补全面(vscode 桩工作区)', () => {
  /** 单根:writer 绑定常量写 + reader 字面量读 + 纯读 ghost + baseAppData 写。 */
  const setup = () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'da02-'));
    const mk = (rel: string, text: string): string => {
      const file = path.join(root, rel);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, text);
      return file;
    };
    const writer = mk('base/writer.py', 'import KBEngine\nKEY = "server_id"\nKBEngine.globalData[KEY] = {"gold": 1}\n');
    const reader = mk('cell/reader.py', 'import KBEngine\nv = KBEngine.globalData.get("cfg")\n');
    const ghost = mk('cell/ghost.py', 'import KBEngine\nw = KBEngine.globalData["ghost"]\n');
    const baseWriter = mk('base/bwriter.py', 'import KBEngine\nKBEngine.baseAppData["bk"] = 1\n');
    const originalFind = vscode.workspace.findFiles;
    const originalRead = vscode.workspace.fs.readFile;
    const originalFolders = vscode.workspace.workspaceFolders;
    vscode.workspace.findFiles = async () =>
      [writer, reader, ghost, baseWriter].map(file => vscode.Uri.file(file));
    vscode.workspace.fs.readFile = async uri => fs.readFileSync(uri.fsPath);
    vscode.workspace.workspaceFolders = [{ uri: vscode.Uri.file(root), name: 'ws', index: 0 }];
    const restore = () => {
      vscode.workspace.findFiles = originalFind;
      vscode.workspace.fs.readFile = originalRead;
      vscode.workspace.workspaceFolders = originalFolders;
      fs.rmSync(root, { recursive: true, force: true });
    };
    return { root, writer, reader, restore };
  };

  const keyDoc = (text: string, fileName: string): vscode.TextDocument =>
    vscode.makeTextDocument(text, { fileName, languageId: 'python' });

  it('键位列出本工程同字典键族:标识符键按绑定出,detail 带写点来源', async () => {
    const { root, restore } = setup();
    const index = new GlobalDataDictIndex();
    const provider = new KBEngineCompletionProvider(stubManager(), index);
    try {
      const text = 'import KBEngine\nKBEngine.globalData["\n';
      const doc = keyDoc(text, path.join(root, 'base', 'open.py'));
      const line = text.split('\n')[1];
      const items = await provider.provideCompletionItems(doc, new vscode.Position(1, line.length));
      const labels = (items ?? []).map(item => String(item.label)).sort();
      // 标识符键按 writer 真实绑定解析为 server_id(不是 KEY);同域字面量键照常
      expect(labels).toEqual(['cfg', 'ghost', 'server_id']);
      const sid = (items ?? []).find(item => item.label === 'server_id');
      expect(sid?.detail).toContain('1 write site(s)');
      expect(sid?.detail).toContain('writer.py:3');
      // 纯读键族:诚实标无写点,不造来源
      const ghostItem = (items ?? []).find(item => item.label === 'ghost');
      expect(ghostItem?.detail).toContain('0 write site(s)');
      expect(ghostItem?.detail).toContain('no write site');
    } finally {
      index.dispose();
      restore();
    }
  });

  it('部分键过滤与跨字典隔离:前缀筛族;cellAppData 键位不混入 baseAppData', async () => {
    const { root, restore } = setup();
    const index = new GlobalDataDictIndex();
    const provider = new KBEngineCompletionProvider(stubManager(), index);
    try {
      const text = 'import KBEngine\nKBEngine.globalData["ser\n';
      const doc = keyDoc(text, path.join(root, 'base', 'open.py'));
      const line = text.split('\n')[1];
      const items = (await provider.provideCompletionItems(doc, new vscode.Position(1, line.length))) ?? [];
      expect(items.map(item => String(item.label))).toEqual(['server_id']);
      // 替换范围 = 引号内片段区间(不含引号)
      expect(items[0].range).toEqual(new vscode.Range(1, line.length - 3, 1, line.length));

      const cellText = 'import KBEngine\nKBEngine.cellAppData["\n';
      const cellDoc = keyDoc(cellText, path.join(root, 'cell', 'open.py'));
      const cellLine = cellText.split('\n')[1];
      const cellItems = await provider.provideCompletionItems(cellDoc, new vscode.Position(1, cellLine.length));
      expect(cellItems ?? []).toEqual([]); // 无 cellAppData 键族:不给项,不混入 baseAppData 的 bk
    } finally {
      index.dispose();
      restore();
    }
  });

  it('开关关闭:键位不接管(交回既有链,无键族项)', async () => {
    const { root, restore } = setup();
    const index = new GlobalDataDictIndex();
    const provider = new KBEngineCompletionProvider(stubManager(), index);
    try {
      setPythonDataDictIndexEnabled(false);
      const text = 'import KBEngine\nKBEngine.globalData["\n';
      const doc = keyDoc(text, path.join(root, 'base', 'open.py'));
      const line = text.split('\n')[1];
      const items = await provider.provideCompletionItems(doc, new vscode.Position(1, line.length));
      expect((items ?? []).some(item => item.label === 'server_id')).toBe(false);
    } finally {
      setPythonDataDictIndexEnabled(true);
      index.dispose();
      restore();
    }
  });

  it('工程隔离:根 B 键位只见根 B 键族(AUD-068 根身份键)', async () => {
    const rootA = fs.mkdtempSync(path.join(os.tmpdir(), 'da02-a-'));
    const rootB = fs.mkdtempSync(path.join(os.tmpdir(), 'da02-b-'));
    const writerA = path.join(rootA, 'writer.py');
    const writerB = path.join(rootB, 'writer.py');
    fs.writeFileSync(writerA, 'import KBEngine\nKBEngine.globalData["ka"] = 1\n');
    fs.writeFileSync(writerB, 'import KBEngine\nKBEngine.globalData["kb"] = 2\n');
    const originalFind = vscode.workspace.findFiles;
    const originalRead = vscode.workspace.fs.readFile;
    const originalFolders = vscode.workspace.workspaceFolders;
    vscode.workspace.findFiles = async () => [writerA, writerB].map(file => vscode.Uri.file(file));
    vscode.workspace.fs.readFile = async uri => fs.readFileSync(uri.fsPath);
    vscode.workspace.workspaceFolders = [
      { uri: vscode.Uri.file(rootA), name: 'A', index: 0 },
      { uri: vscode.Uri.file(rootB), name: 'B', index: 1 }
    ];
    const index = new GlobalDataDictIndex();
    const provider = new KBEngineCompletionProvider(stubManager(), index);
    try {
      const text = 'import KBEngine\nKBEngine.globalData["\n';
      const doc = keyDoc(text, path.join(rootA, 'open.py'));
      const line = text.split('\n')[1];
      const items = await provider.provideCompletionItems(doc, new vscode.Position(1, line.length));
      expect((items ?? []).map(item => String(item.label))).toEqual(['ka']);
    } finally {
      index.dispose();
      vscode.workspace.findFiles = originalFind;
      vscode.workspace.fs.readFile = originalRead;
      vscode.workspace.workspaceFolders = originalFolders;
      fs.rmSync(rootA, { recursive: true, force: true });
      fs.rmSync(rootB, { recursive: true, force: true });
    }
  });
});

describe('KSEM-DATA-02 标识符键索引/导航面(vscode 桩工作区)', () => {
  it('同名标识符绑不同值:两文件两个键族,不并作一族(验收句钉)', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'da02-key-'));
    const writerA = path.join(root, 'writerA.py');
    const writerB = path.join(root, 'writerB.py');
    fs.writeFileSync(writerA, 'import KBEngine\nKEY = "alpha"\nKBEngine.globalData[KEY] = 1\n');
    fs.writeFileSync(writerB, 'import KBEngine\nKEY = "beta"\nKBEngine.globalData[KEY] = 2\n');
    const originalFind = vscode.workspace.findFiles;
    const originalRead = vscode.workspace.fs.readFile;
    const originalFolders = vscode.workspace.workspaceFolders;
    vscode.workspace.findFiles = async () => [writerA, writerB].map(file => vscode.Uri.file(file));
    vscode.workspace.fs.readFile = async uri => fs.readFileSync(uri.fsPath);
    vscode.workspace.workspaceFolders = [{ uri: vscode.Uri.file(root), name: 'ws', index: 0 }];
    const index = new GlobalDataDictIndex();
    const provider = new KBEngineCompletionProvider(stubManager(), index);
    try {
      await index.ensureStarted();
      const families = index.queryKeyFamilies('globalData', root)
        .map(family => family.keySignature).sort();
      expect(families).toEqual(['alpha', 'beta']);
      // 补全面同步可见两族(键位列 key)
      const text = 'import KBEngine\nKBEngine.globalData["\n';
      const doc = vscode.makeTextDocument(text, { fileName: writerA, languageId: 'python' });
      const line = text.split('\n')[1];
      const items = await provider.provideCompletionItems(doc, new vscode.Position(1, line.length));
      expect((items ?? []).map(item => String(item.label)).sort()).toEqual(['alpha', 'beta']);
    } finally {
      index.dispose();
      vscode.workspace.findFiles = originalFind;
      vscode.workspace.fs.readFile = originalRead;
      vscode.workspace.workspaceFolders = originalFolders;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
