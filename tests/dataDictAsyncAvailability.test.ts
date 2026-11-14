/**
 * KSEM-DATA-04(SEM-045)表达异步可用性 — 验收钉。
 *
 * 验收口径(todo.md SEM-045):共享数据发现写点不代表读时已存在;get/
 * default、删除及进程域对类型和提示产生影响。
 *
 * 面分解:
 *  - 纯核:del 下标=delete 态(伪 del 注释/字符串不判;.get 臂恒 read,
 *    `del x.get(k)` 非法语法不判);`.get(K, D)` 第二参捕获 defaultText
 *    (valueText 恒 null,与写点记录面不混);
 *  - 读点有效类型 = 同键写点类型 union ∪ default 类型(inlay/hover 双面);
 *  - 可用性:读点悬停恒带运行时序 caveat(写点可能晚于读点执行);删除点
 *    计数入悬停、不入类型 union、不出 inlay;
 *  - 进程域(baseAppData=base / cellAppData=cell,引擎真域):查询文件出域
 *    → 悬停机制说明(运行期无此属性)、inlay 全跳、补全键位无项;跨域写点
 *    不入类型面(计数如实);导航面不收窄(globalData 全进程不收窄)。
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import * as vscode from 'vscode';
import { EntityMappingManager } from '../src/entityMapping';
import { KBEngineCompletionProvider, KBEngineHoverProvider } from '../src/languageProviders';
import { PythonTypeInlayHintsProvider } from '../src/typeInlayHints';
import { GlobalDataDictIndex } from '../src/globalDataIndex';
import { findKbeDataDictAccesses } from '../src/backend/globalDataIndexCore';
import { dataDictProcessDomain, dataDictSiteInDomain } from '../src/backend/pythonProcess';

const ALIASES = new Set(['KBEngine', 'kbe']);
const stubManager = (): EntityMappingManager =>
  new EntityMappingManager({ subscriptions: [] } as never);

const hoverText = (hover: vscode.Hover | null): string => {
  if (!hover) {
    return '';
  }
  const contents = hover.contents as { value: string } | Array<{ value: string }>;
  return Array.isArray(contents) ? contents.map(item => item.value).join('') : contents.value;
};

/** 文件清单工作区:rel 相对 root,mk 自动建目录;桩 findFiles/readFile/folders。 */
const setup = (files: Array<{ rel: string; text: string }>) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'da04-'));
  const paths = files.map(spec => {
    const file = path.join(root, spec.rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, spec.text);
    return file;
  });
  const originalFind = vscode.workspace.findFiles;
  const originalRead = vscode.workspace.fs.readFile;
  const originalFolders = vscode.workspace.workspaceFolders;
  vscode.workspace.findFiles = async () => paths.map(file => vscode.Uri.file(file));
  vscode.workspace.fs.readFile = async uri => fs.readFileSync(uri.fsPath);
  vscode.workspace.workspaceFolders = [{ uri: vscode.Uri.file(root), name: 'ws', index: 0 }];
  const restore = () => {
    vscode.workspace.findFiles = originalFind;
    vscode.workspace.fs.readFile = originalRead;
    vscode.workspace.workspaceFolders = originalFolders;
    fs.rmSync(root, { recursive: true, force: true });
  };
  return { root, paths, restore };
};

const lineOf = (text: string): string => text.split('\n')[1];

const readHoverOf = async (
  provider: KBEngineHoverProvider,
  reader: string,
  text: string
): Promise<string> => {
  const doc = vscode.makeTextDocument(text, { fileName: reader, languageId: 'python' });
  return hoverText(await provider.provideHover(
    doc,
    new vscode.Position(1, lineOf(text).indexOf('k') + 1)
  ) as vscode.Hover | null);
};

const inlayLabelsOf = async (
  inlay: PythonTypeInlayHintsProvider,
  doc: vscode.TextDocument,
  text: string
): Promise<Array<string | vscode.InlayHintLabelPart[]>> => {
  const hints = await inlay.provideInlayHints(
    doc,
    new vscode.Range(1, 0, 1, lineOf(text).length)
  );
  return hints.map(h => h.label);
};

describe('KSEM-DATA-04 纯核:del 删除态与 get 默认值捕获', () => {
  it('del 下标=delete 态(valueText null);普通下标读写不受影响', () => {
    const sites = findKbeDataDictAccesses(
      'import KBEngine\ndel KBEngine.globalData["k"]\n',
      ALIASES
    );
    expect(sites).toHaveLength(1);
    expect(sites[0].kind).toBe('delete');
    expect(sites[0].keySignature).toBe('k');
    expect(sites[0].valueText).toBeNull();
    const write = findKbeDataDictAccesses(
      'import KBEngine\nKBEngine.globalData["k"] = 1\n',
      ALIASES
    );
    expect(write[0].kind).toBe('write');
  });

  it('注释/字符串里的伪 del 不判(词法掩码);del 前无边界不成令牌', () => {
    const commented = 'import KBEngine\n# del KBEngine.globalData["k"]\n';
    expect(findKbeDataDictAccesses(commented, ALIASES)).toHaveLength(0);
    const inString = 'import KBEngine\ns = "del KBEngine.globalData[\'k\']"\n';
    expect(findKbeDataDictAccesses(inString, ALIASES)).toHaveLength(0);
    // `mydel = ...`:del 前是 \w,不成独立 del 令牌,照常按普通访问入索引
    const glued = 'import KBEngine\nmydel = KBEngine.globalData["k"]\n';
    const sites = findKbeDataDictAccesses(glued, ALIASES);
    expect(sites).toHaveLength(1);
    expect(sites[0].kind).toBe('read');
  });

  it('.get 臂恒 read(`del x.get(k)` 非法语法不判删除)', () => {
    const sites = findKbeDataDictAccesses(
      'import KBEngine\nv = KBEngine.globalData.get("k")\n',
      ALIASES
    );
    expect(sites).toHaveLength(1);
    expect(sites[0].kind).toBe('read');
  });

  it('defaultText 捕获第二参:字面量/调用形态;单参 null;超参只取第二参', () => {
    const two = findKbeDataDictAccesses(
      'import KBEngine\nv = KBEngine.globalData.get("k", "fallback")\n',
      ALIASES
    );
    expect(two[0].kind).toBe('read');
    expect(two[0].valueText).toBeNull();
    expect(two[0].defaultText).toBe('"fallback"');
    const call = findKbeDataDictAccesses(
      'import KBEngine\nv = KBEngine.globalData.get("k", default_value())\n',
      ALIASES
    );
    expect(call[0].defaultText).toBe('default_value()');
    const one = findKbeDataDictAccesses(
      'import KBEngine\nv = KBEngine.globalData.get("k")\n',
      ALIASES
    );
    expect(one[0].defaultText).toBeNull();
    const over = findKbeDataDictAccesses(
      'import KBEngine\nv = KBEngine.globalData.get("k", 1, 2)\n',
      ALIASES
    );
    expect(over[0].defaultText).toBe('1');
    // 嵌套括号内的逗号不劈参
    const nested = findKbeDataDictAccesses(
      'import KBEngine\nv = KBEngine.globalData.get("k", {"a": 1, "b": 2})\n',
      ALIASES
    );
    expect(nested[0].defaultText).toBe('{"a": 1, "b": 2}');
    // 写点记录不设 defaultText(与读点面不混)
    const write = findKbeDataDictAccesses(
      'import KBEngine\nKBEngine.globalData["k"] = 1\n',
      ALIASES
    );
    expect(write[0].defaultText).toBeUndefined();
  });

  it('进程域纯核:baseAppData=base / cellAppData=cell / globalData 不收窄;角色不可知不声称出域', () => {
    expect(dataDictProcessDomain('baseAppData')?.has('base')).toBe(true);
    expect(dataDictProcessDomain('baseAppData')?.has('cell')).toBe(false);
    expect(dataDictProcessDomain('cellAppData')?.has('cell')).toBe(true);
    expect(dataDictProcessDomain('globalData')).toBeNull();
    // scripts/ 之外角色不可知:恒真(不猜)
    expect(dataDictSiteInDomain('/tmp/nowhere/writer.py', 'cellAppData')).toBe(true);
  });
});

describe('KSEM-DATA-04 读点有效类型:get default 并入 union(vscode 桩)', () => {
  it('写点 int + .get 默认值 "fb":inlay `: int | str`', async () => {
    const { paths, restore } = setup([
      { rel: 'base/writer.py', text: 'import KBEngine\nKBEngine.globalData["k"] = 1\n' },
      { rel: 'cell/reader.py', text: 'import KBEngine\nv = KBEngine.globalData.get("k", "fb")\n' }
    ]);
    const index = new GlobalDataDictIndex();
    const inlay = new PythonTypeInlayHintsProvider(stubManager(), index);
    try {
      const text = 'import KBEngine\nv = KBEngine.globalData.get("k", "fb")\n';
      const doc = vscode.makeTextDocument(text, { fileName: paths[1], languageId: 'python' });
      expect(await inlayLabelsOf(inlay, doc, text)).toEqual([': int | str']);
    } finally {
      index.dispose();
      restore();
    }
  });

  it('纯默认值(无写点):读点仍出 default 类型(inlay/hover 双面)', async () => {
    const { paths, restore } = setup([
      { rel: 'cell/reader.py', text: 'import KBEngine\nv = KBEngine.globalData.get("k", "fb")\n' }
    ]);
    const index = new GlobalDataDictIndex();
    const inlay = new PythonTypeInlayHintsProvider(stubManager(), index);
    const hover = new KBEngineHoverProvider(stubManager(), index);
    try {
      const text = 'import KBEngine\nv = KBEngine.globalData.get("k", "fb")\n';
      const doc = vscode.makeTextDocument(text, { fileName: paths[0], languageId: 'python' });
      expect(await inlayLabelsOf(inlay, doc, text)).toEqual([': str']);
      const body = await readHoverOf(hover, paths[0], text);
      expect(body).toContain('`: str**');
      expect(body).toContain('读点 · 同键写点 0 处');
    } finally {
      index.dispose();
      restore();
    }
  });

  it('读点悬停恒带可用性 caveat(发现写点不代表读时已存在)', async () => {
    const { paths, restore } = setup([
      { rel: 'base/writer.py', text: 'import KBEngine\nKBEngine.globalData["k"] = 1\n' },
      { rel: 'cell/reader.py', text: 'import KBEngine\nv = KBEngine.globalData.get("k")\n' }
    ]);
    const index = new GlobalDataDictIndex();
    const hover = new KBEngineHoverProvider(stubManager(), index);
    try {
      const text = 'import KBEngine\nv = KBEngine.globalData.get("k")\n';
      const body = await readHoverOf(hover, paths[1], text);
      expect(body).toContain('`: int**');
      expect(body).toContain('写点运行时可能晚于本读点执行');
    } finally {
      index.dispose();
      restore();
    }
  });
});

describe('KSEM-DATA-04 删除点:计数入悬停,不入类型 union/不出 inlay', () => {
  it('写点+删除点:悬停含删除计数,union/inlay 照常单类型', async () => {
    const { paths, restore } = setup([
      { rel: 'base/writer.py', text: 'import KBEngine\nKBEngine.globalData["k"] = 1\n' },
      { rel: 'cell/remover.py', text: 'import KBEngine\ndel KBEngine.globalData["k"]\n' },
      { rel: 'cell/reader.py', text: 'import KBEngine\nv = KBEngine.globalData.get("k")\n' }
    ]);
    const index = new GlobalDataDictIndex();
    const hover = new KBEngineHoverProvider(stubManager(), index);
    const inlay = new PythonTypeInlayHintsProvider(stubManager(), index);
    try {
      const text = 'import KBEngine\nv = KBEngine.globalData.get("k")\n';
      const doc = vscode.makeTextDocument(text, { fileName: paths[2], languageId: 'python' });
      const body = await readHoverOf(hover, paths[2], text);
      expect(body).toContain('`: int**');
      expect(body).toContain('同键删除点 1 处');
      expect(body).toContain('读取可能落在删除之后');
      expect(body).not.toContain('- int ←');
      expect(await inlayLabelsOf(inlay, doc, text)).toEqual([': int']);
      // 删除位自身无类型面(不出「读点」标注/union):悬停落回普通链,inlay 无提示
      const delText = 'import KBEngine\ndel KBEngine.globalData["k"]\n';
      const delDoc = vscode.makeTextDocument(delText, { fileName: paths[1], languageId: 'python' });
      const delBody = await readHoverOf(hover, paths[1], delText);
      expect(delBody).not.toContain('读点 ·');
      expect(delBody).not.toContain('`: int**');
      expect(await inlayLabelsOf(inlay, delDoc, delText)).toEqual([]);
    } finally {
      index.dispose();
      restore();
    }
  });
});

describe('KSEM-DATA-04 进程域对类型和提示产生影响(vscode 桩)', () => {
  it('base 文件读 cellAppData:悬停=机制说明(运行期无此属性),非类型面', async () => {
    const { paths, restore } = setup([
      { rel: 'scripts/cell/writer.py', text: 'import KBEngine\nKBEngine.cellAppData["k"] = 1\n' },
      { rel: 'scripts/base/reader.py', text: 'import KBEngine\nv = KBEngine.cellAppData.get("k")\n' }
    ]);
    const index = new GlobalDataDictIndex();
    const hover = new KBEngineHoverProvider(stubManager(), index);
    try {
      const text = 'import KBEngine\nv = KBEngine.cellAppData.get("k")\n';
      const body = await readHoverOf(hover, paths[1], text);
      expect(body).toContain('运行期无此属性');
      expect(body).toContain('cell');
      expect(body).not.toContain('读点 ·');
      expect(body).not.toContain('`: int**');
    } finally {
      index.dispose();
      restore();
    }
  });

  it('域内 cell 读 cellAppData:类型面照常(hover `: int` / inlay `: int`)', async () => {
    const { paths, restore } = setup([
      { rel: 'scripts/cell/writer.py', text: 'import KBEngine\nKBEngine.cellAppData["k"] = 1\n' },
      { rel: 'scripts/cell/reader.py', text: 'import KBEngine\nv = KBEngine.cellAppData.get("k")\n' }
    ]);
    const index = new GlobalDataDictIndex();
    const hover = new KBEngineHoverProvider(stubManager(), index);
    const inlay = new PythonTypeInlayHintsProvider(stubManager(), index);
    try {
      const text = 'import KBEngine\nv = KBEngine.cellAppData.get("k")\n';
      const doc = vscode.makeTextDocument(text, { fileName: paths[1], languageId: 'python' });
      const body = await readHoverOf(hover, paths[1], text);
      expect(body).toContain('`: int**');
      expect(body).not.toContain('运行期无此属性');
      expect(await inlayLabelsOf(inlay, doc, text)).toEqual([': int']);
    } finally {
      index.dispose();
      restore();
    }
  });

  it('出域文档 inlay 全跳(含写点形态);globalData 不收窄照常出', async () => {
    const { root, restore } = setup([
      { rel: 'scripts/cell/writer.py', text: 'import KBEngine\nKBEngine.cellAppData["k"] = 1\n' }
    ]);
    const index = new GlobalDataDictIndex();
    const inlay = new PythonTypeInlayHintsProvider(stubManager(), index);
    try {
      // base 文档写 cellAppData:运行期无此属性,inlay 不出类型
      const baseText = 'import KBEngine\nKBEngine.cellAppData["k"] = 1\n';
      const baseDoc = vscode.makeTextDocument(baseText, {
        fileName: path.join(root, 'scripts', 'base', 'writer.py'),
        languageId: 'python'
      });
      expect(await inlayLabelsOf(inlay, baseDoc, baseText)).toEqual([]);
      // 同位置写 globalData:全进程字典,照常出
      const globalText = 'import KBEngine\nKBEngine.globalData["k"] = 1\n';
      const globalDoc = vscode.makeTextDocument(globalText, {
        fileName: path.join(root, 'scripts', 'base', 'writer.py'),
        languageId: 'python'
      });
      expect(await inlayLabelsOf(inlay, globalDoc, globalText)).toEqual([': int']);
    } finally {
      index.dispose();
      restore();
    }
  });

  it('跨进程域写点不入类型面并如实计数;域内写点类型照常', async () => {
    const { paths, restore } = setup([
      { rel: 'scripts/cell/writerC.py', text: 'import KBEngine\nKBEngine.cellAppData["k"] = 1\n' },
      { rel: 'scripts/base/writerB.py', text: 'import KBEngine\nKBEngine.cellAppData["k"] = "s"\n' },
      { rel: 'scripts/cell/reader.py', text: 'import KBEngine\nv = KBEngine.cellAppData.get("k")\n' }
    ]);
    const index = new GlobalDataDictIndex();
    const hover = new KBEngineHoverProvider(stubManager(), index);
    const inlay = new PythonTypeInlayHintsProvider(stubManager(), index);
    try {
      const text = 'import KBEngine\nv = KBEngine.cellAppData.get("k")\n';
      const doc = vscode.makeTextDocument(text, { fileName: paths[2], languageId: 'python' });
      const body = await readHoverOf(hover, paths[2], text);
      expect(body).toContain('`: int**');
      expect(body).not.toContain('| str');
      expect(body).toContain('另有 1 处跨进程域写点不入类型');
      expect(body).toContain('首个写点 writerC.py:2');
      expect(await inlayLabelsOf(inlay, doc, text)).toEqual([': int']);
    } finally {
      index.dispose();
      restore();
    }
  });

  it('补全键位:出域文档无项;域内文档只列域内写点 detail', async () => {
    const { root, paths, restore } = setup([
      { rel: 'scripts/cell/writerC.py', text: 'import KBEngine\nKBEngine.cellAppData["k"] = 1\n' },
      { rel: 'scripts/base/writerB.py', text: 'import KBEngine\nKBEngine.cellAppData["k"] = "s"\n' }
    ]);
    const index = new GlobalDataDictIndex();
    const provider = new KBEngineCompletionProvider(stubManager(), index);
    try {
      const text = 'import KBEngine\nKBEngine.cellAppData["\n';
      const line = lineOf(text);
      // 域内(cell 文档):键族在,写点只数域内(cell 的 1 处)
      const cellDoc = vscode.makeTextDocument(text, {
        fileName: paths[0].replace('writerC.py', 'open.py'),
        languageId: 'python'
      });
      const cellItems = (await provider.provideCompletionItems(
        cellDoc,
        new vscode.Position(1, line.length)
      )) ?? [];
      expect(cellItems.map(item => String(item.label))).toEqual(['k']);
      expect(cellItems[0].detail).toContain('1 write site(s)');
      expect(cellItems[0].detail).toContain('writerC.py:2');
      // 出域(base 文档):键位不给项
      const baseDoc = vscode.makeTextDocument(text, {
        fileName: path.join(root, 'scripts', 'base', 'open.py'),
        languageId: 'python'
      });
      const baseItems = await provider.provideCompletionItems(
        baseDoc,
        new vscode.Position(1, line.length)
      );
      expect(baseItems ?? []).toEqual([]);
    } finally {
      index.dispose();
      restore();
    }
  });
});
