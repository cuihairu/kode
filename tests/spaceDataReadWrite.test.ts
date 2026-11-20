/**
 * KSEM-DATA-06(SEM-047)空间数据读写关联 — 验收钉。
 *
 * 验收口径(todo.md SEM-047):可确定 spaceID 与 key 建索引/补全/跳转;
 * 动态空间不合并为同一确定对象,保护键写入有明确诊断。
 *
 * 面分解:
 *  - 纯核:三函数调用扫描(掩码剔注释/字符串伪调用;属性链不收;元数精确;
 *    跨行不判);spaceID 只收 int 字面量/模块级 int 常量绑定(冲突→动态);
 *    key 只收字符串字面量内部原文;_mapping 保护键发现(set/del 大小写不
 *    敏感,get 放行——引擎几何映射自读路径);键位补全上下文(引号内片段/
 *    未开引号插入位;闭调用/首参未完不判);
 *  - 索引:(spaceID, key) 全等归族;动态 spaceID 不建族——动态空间不合并
 *    为同一确定对象(验收硬面);不同 spaceID 同 key 也是不同族(逐空间
 *    存储,spacememory.cpp per-SpaceMemory);增量 updateFile/removeFile。
 *  - 面:键位补全(动态 sid→[],族 detail 数写点);F12 跳首个异类点
 *    (get→set;set→get/del);Shift+F12 全族含自身;保护键诊断(Error,
 *    get 不发)。
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { EntityMappingManager } from '../src/entityMapping';
import {
  KBEngineCompletionProvider,
  KBEngineReferencesProvider,
  PythonDefinitionProvider,
  resolveSpaceDataSitesAtPosition
} from '../src/languageProviders';
import {
  extractModuleIntConstantBindings,
  findKbeSpaceDataCallAtPosition,
  findKbeSpaceDataCalls,
  findSpaceDataProtectedKeyFindings,
  spaceDataFamilyKey,
  spaceDataKeyCompletionContext
} from '../src/backend/spaceDataIndexCore';
import {
  analyzeSpaceDataProtectedKeys,
  spaceDataProtectedKeyFindingToItem,
  SPACE_DATA_PROTECTED_KEY_DIAGNOSTIC_CODE
} from '../src/backend/spaceDataProtectedKeyCheck';
import {
  resetSpaceDataIndexForTests,
  setSpaceDataIndexEnabled,
  SpaceDataIndex
} from '../src/spaceDataIndex';

const ALIASES = new Set(['KBEngine', 'kbe']);

describe('KSEM-DATA-06 纯核:三函数调用扫描', () => {
  it('set/get/del 全收:fn/行/key 内容区间/sid;别名 kbe 同收', () => {
    const text = [
      'import KBEngine',
      'KBEngine.setSpaceData(1, "cfg", "hello")',
      "kbe.getSpaceData(1, 'cfg')",
      'KBEngine.delSpaceData(1, "cfg")'
    ].join('\n');
    const calls = findKbeSpaceDataCalls(text, ALIASES);
    expect(calls).toHaveLength(3);
    expect(calls[0]).toMatchObject({
      fn: 'setSpaceData', line: 1, spaceIdSignature: '1', keySignature: 'cfg'
    });
    const line = text.split('\n')[1];
    expect(calls[0].keyStart).toBe(line.indexOf('"cfg"') + 1);
    expect(calls[0].keyEnd).toBe(line.indexOf('"cfg"') + 1 + '"cfg"'.length - 2);
    expect(calls[1].fn).toBe('getSpaceData');
    expect(calls[2].fn).toBe('delSpaceData');
  });

  it('注释/字符串伪调用不收;`x.KBEngine.` 属性链不收;完闭调用带尾注释照收', () => {
    const commented = 'import KBEngine\n# KBEngine.setSpaceData(1, "k", "v")\n';
    expect(findKbeSpaceDataCalls(commented, ALIASES)).toHaveLength(0);
    const inString = 'import KBEngine\ns = "KBEngine.setSpaceData(1, \'k\', \'v\')"\n';
    expect(findKbeSpaceDataCalls(inString, ALIASES)).toHaveLength(0);
    const attrChain = 'import KBEngine\nx.KBEngine.setSpaceData(1, "k", "v")\n';
    expect(findKbeSpaceDataCalls(attrChain, ALIASES)).toHaveLength(0);
    // 完闭调用后跟注释:调用本体是真代码,照收;未闭调用跟注释:参数扫描
    // 边界不可靠,不判
    const trailing = 'import KBEngine\nKBEngine.setSpaceData(1, "k", "v")  # write\n';
    expect(findKbeSpaceDataCalls(trailing, ALIASES)).toHaveLength(1);
    const unclosed = 'import KBEngine\nKBEngine.setSpaceData(1, "k", "v"  # oops\n';
    expect(findKbeSpaceDataCalls(unclosed, ALIASES)).toHaveLength(0);
  });

  it('元数精确才收(set=3/get=2/del=2,引擎 argssize 口径);跨行调用不判', () => {
    const shortSet = 'import KBEngine\nKBEngine.setSpaceData(1, "k")\n';
    expect(findKbeSpaceDataCalls(shortSet, ALIASES)).toHaveLength(0);
    const extraGet = 'import KBEngine\nKBEngine.getSpaceData(1, "k", "v")\n';
    expect(findKbeSpaceDataCalls(extraGet, ALIASES)).toHaveLength(0);
    const multiline = 'import KBEngine\nKBEngine.setSpaceData(1,\n    "k", "v")\n';
    expect(findKbeSpaceDataCalls(multiline, ALIASES)).toHaveLength(0);
  });

  it('sid:int 字面量/负数收;标识符按 int 常量绑定解析;冲突绑定→动态;非字面量 key 不建族', () => {
    const bindings = extractModuleIntConstantBindings(
      'SPACE_ID = 7\nOTHER: int = 7\nDUP = 1\nDUP = 2\nNAME = "s"\nINDENT = 3\n'.replace(
        'INDENT = 3', '  INDENT = 3'
      )
    );
    expect(bindings.get('SPACE_ID')).toBe(7);
    expect(bindings.get('OTHER')).toBe(7); // 注解形态同收
    expect(bindings.get('DUP')).toBeNull(); // 冲突→动态
    expect(bindings.has('NAME')).toBe(false); // 非 int 不入表
    expect(bindings.has('INDENT')).toBe(false); // 缩进赋值不入表

    const byLiteral = findKbeSpaceDataCalls(
      'import KBEngine\nKBEngine.setSpaceData(-3, "k", "v")\n', ALIASES
    );
    expect(byLiteral[0].spaceIdSignature).toBe('-3');
    const bindingText = 'import KBEngine\nSPACE_ID = 7\nKBEngine.setSpaceData(SPACE_ID, "k", "v")\n';
    const byBinding = findKbeSpaceDataCalls(
      bindingText, ALIASES, extractModuleIntConstantBindings(bindingText)
    );
    expect(byBinding[0].spaceIdSignature).toBe('7');
    const byConflict = findKbeSpaceDataCalls(
      'import KBEngine\nDUP = 1\nDUP = 2\nKBEngine.setSpaceData(DUP, "k", "v")\n', ALIASES
    );
    expect(byConflict[0].spaceIdSignature).toBeNull();
    const dynamic = findKbeSpaceDataCalls(
      'import KBEngine\nKBEngine.setSpaceData(entity.spaceID, "k", "v")\n', ALIASES
    );
    expect(dynamic[0].spaceIdSignature).toBeNull();
    const nonLiteralKey = findKbeSpaceDataCalls(
      'import KBEngine\nKBEngine.setSpaceData(1, keyName, "v")\n', ALIASES
    );
    expect(nonLiteralKey[0].keySignature).toBeNull();
  });

  it('族键=spaceID\\u001fkey;转义不解义("a\\nb" 与 "a\\\\nb" 不同族)', () => {
    expect(spaceDataFamilyKey('1', 'cfg')).toBe('1\u001fcfg');
    const text = 'import KBEngine\nKBEngine.setSpaceData(1, "a\\nb", "v")\n';
    const calls = findKbeSpaceDataCalls(text, ALIASES);
    expect(calls[0].keySignature).toBe('a\\nb'); // 原文,不解转义
  });
});

describe('KSEM-DATA-06 纯核:_mapping 保护键发现(引擎 AssertionError 契约)', () => {
  it('set/del 大小写不敏感报;get 放行(引擎几何映射自读路径)', () => {
    const text = [
      'import KBEngine',
      'KBEngine.setSpaceData(1, "_mapping", "/maps/1")',
      'KBEngine.setSpaceData(1, "_MAPPING", "/maps/2")',
      "KBEngine.delSpaceData(1, '_Mapping')",
      'KBEngine.getSpaceData(1, "_mapping")',
      'KBEngine.setSpaceData(1, "normal", "v")'
    ].join('\n');
    const findings = findSpaceDataProtectedKeyFindings(text, ALIASES);
    expect(findings).toHaveLength(3);
    expect(findings[0].fn).toBe('setSpaceData');
    expect(findings[1].keyText).toBe('_MAPPING'); // 原文保留
    expect(findings[2].fn).toBe('delSpaceData');
    // get 不发(第三条 del 之后紧跟 get)
    expect(findings.some(f => f.fn === 'getSpaceData')).toBe(false);
  });

  it('非字面量键不判;动态 spaceID 的 set/del 照报(键保护与空间可解性正交)', () => {
    const nonLiteral = 'import KBEngine\nKBEngine.setSpaceData(1, keyName, "v")\n';
    expect(findSpaceDataProtectedKeyFindings(nonLiteral, ALIASES)).toHaveLength(0);
    const dynamicSid = 'import KBEngine\nKBEngine.delSpaceData(entity.spaceID, "_mapping")\n';
    const findings = findSpaceDataProtectedKeyFindings(dynamicSid, ALIASES);
    expect(findings).toHaveLength(1);
    expect(findings[0].fn).toBe('delSpaceData');
  });

  it('诊断项:Error 级,range 落 key 内容区间,code/source 固定', () => {
    const line = 'KBEngine.setSpaceData(1, "_mapping", "/m")';
    const items = analyzeSpaceDataProtectedKeys(
      `import KBEngine\n${line}\n`, ALIASES
    );
    expect(items).toHaveLength(1);
    expect(items[0].severity).toBe('Error');
    expect(items[0].source).toBe('kbengine');
    expect(items[0].code).toBe(SPACE_DATA_PROTECTED_KEY_DIAGNOSTIC_CODE);
    expect(items[0].range.start).toEqual({ line: 1, character: line.indexOf('"_mapping"') + 1 });
    expect(items[0].range.end).toEqual({ line: 1, character: line.indexOf('"_mapping"') + 1 + '_mapping'.length });
    expect(items[0].message).toContain('_mapping');
    expect(items[0].message).toContain('AssertionError');
    const converted = spaceDataProtectedKeyFindingToItem({
      fn: 'delSpaceData', line: 0, keyText: '_Mapping', keyStart: 5, keyEnd: 13
    });
    expect(converted.message).toContain('_Mapping');
  });
});

describe('KSEM-DATA-06 纯核:键位补全上下文', () => {
  it('引号内片段:partial/replaceStart 精确;未开引号:插入位=光标', () => {
    const line = 'KBEngine.setSpaceData(1, "cf';
    const ctx = spaceDataKeyCompletionContext(line, line.length, ALIASES)!;
    expect(ctx).not.toBeNull();
    expect(ctx.fn).toBe('setSpaceData');
    expect(ctx.spaceIdSignature).toBe('1');
    expect(ctx.partial).toBe('cf');
    expect(ctx.replaceStart).toBe(line.indexOf('"cf') + 1);
    const open = 'KBEngine.setSpaceData(1, ';
    const openCtx = spaceDataKeyCompletionContext(open, open.length, ALIASES)!;
    expect(openCtx.partial).toBe('');
    expect(openCtx.replaceStart).toBe(open.length);
  });

  it('动态 sid 上下文仍识别但签名 null(调用方不给项);单引号同收', () => {
    const dyn = 'KBEngine.setSpaceData(sid, ';
    expect(spaceDataKeyCompletionContext(dyn, dyn.length, ALIASES)?.spaceIdSignature).toBeNull();
    const sq = "KBEngine.getSpaceData(2, 'l";
    const ctx = spaceDataKeyCompletionContext(sq, sq.length, ALIASES)!;
    expect(ctx.partial).toBe('l');
    expect(ctx.fn).toBe('getSpaceData');
  });

  it('闭调用/首参未完/非键位:null', () => {
    const closed = 'KBEngine.setSpaceData(1, "cfg", "v")';
    expect(spaceDataKeyCompletionContext(closed, closed.length - 3, ALIASES)).toBeNull();
    const firstArg = 'KBEngine.setSpaceData(1';
    expect(spaceDataKeyCompletionContext(firstArg, firstArg.length, ALIASES)).toBeNull();
    const notCall = 'value = 1 + 2';
    expect(spaceDataKeyCompletionContext(notCall, notCall.length, ALIASES)).toBeNull();
  });

  it('光标键位探测:引号与内容列命中,键外不命中', () => {
    const text = 'import KBEngine\nKBEngine.setSpaceData(1, "cfg", "v")\n';
    const line = text.split('\n')[1];
    const onKey = findKbeSpaceDataCallAtPosition(text, 1, line.indexOf('cfg'), ALIASES);
    expect(onKey?.keySignature).toBe('cfg');
    const onQuote = findKbeSpaceDataCallAtPosition(text, 1, line.indexOf('"cfg"'), ALIASES);
    expect(onQuote?.keySignature).toBe('cfg');
    const offKey = findKbeSpaceDataCallAtPosition(text, 1, 0, ALIASES);
    expect(offKey).toBeNull();
  });
});

describe('KSEM-DATA-06 索引:族归并与动态空间不合并', () => {
  it('(spaceID, key) 全等归族;不同 spaceID 同 key 是不同族(逐空间存储)', () => {
    const index = new SpaceDataIndex();
    index.updateFile('/w/a.py', 'import KBEngine\nKBEngine.setSpaceData(1, "cfg", "x")\nKBEngine.getSpaceData(2, "cfg")\n');
    index.updateFile('/w/b.py', 'import KBEngine\nKBEngine.getSpaceData(1, "cfg")\n');
    expect(index.queryFamilySites('1', 'cfg').map(s => path.basename(s.file)).sort())
      .toEqual(['a.py', 'b.py']);
    expect(index.queryFamilySites('2', 'cfg')).toHaveLength(1);
    expect(index.queryFamiliesForSpace('1').map(f => f.keySignature)).toEqual(['cfg']);
    expect(index.queryFamiliesForSpace('2')).toHaveLength(1);
    index.dispose();
  });

  it('动态 spaceID 不建族不合并(验收硬面);updateFile 增量替换;removeFile 撤贡献', () => {
    const index = new SpaceDataIndex();
    index.updateFile('/w/dyn.py', 'import KBEngine\nKBEngine.setSpaceData(sid, "k", "v")\n');
    expect(index.familyCountForTests()).toBe(0);
    index.updateFile('/w/a.py', 'import KBEngine\nKBEngine.setSpaceData(1, "k", "v")\n');
    expect(index.queryFamilySites('1', 'k')).toHaveLength(1);
    // 同文件改键:旧族撤新族立
    index.updateFile('/w/a.py', 'import KBEngine\nKBEngine.setSpaceData(1, "k2", "v")\n');
    expect(index.queryFamilySites('1', 'k')).toHaveLength(0);
    expect(index.queryFamilySites('1', 'k2')).toHaveLength(1);
    index.removeFile('/w/a.py');
    expect(index.familyCountForTests()).toBe(0);
    index.dispose();
  });
});

describe('KSEM-DATA-06 面:补全 / F12 / Shift+F12 / 开关', () => {
  const setupWorkspace = () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sd06-'));
    const writer1 = path.join(root, 'cell', 'writer1.py');
    const writer2 = path.join(root, 'cell', 'writer2.py');
    const reader = path.join(root, 'cell', 'reader.py');
    const texts = new Map<string, string>();
    for (const [file, text] of [
      [writer1, 'import KBEngine\nKBEngine.setSpaceData(1, "cfg", "x")\n'],
      [writer2, 'import KBEngine\nKBEngine.setSpaceData(2, "cfg", "y")\nKBEngine.setSpaceData(1, "cfg", "z")\n'],
      [reader, 'import KBEngine\nvalue = KBEngine.getSpaceData(1, "cfg")\n']
    ] as const) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, text);
      texts.set(file, text);
    }
    const originalFind = vscode.workspace.findFiles;
    const originalRead = vscode.workspace.fs.readFile;
    vscode.workspace.findFiles = async () => [writer1, writer2, reader].map(f => vscode.Uri.file(f));
    vscode.workspace.fs.readFile = async uri => fs.readFileSync(uri.fsPath);
    return {
      root, writer1, writer2, reader, texts,
      restore: () => {
        vscode.workspace.findFiles = originalFind;
        vscode.workspace.fs.readFile = originalRead;
        fs.rmSync(root, { recursive: true, force: true });
      }
    };
  };

  beforeEach(() => {
    resetSpaceDataIndexForTests();
    setSpaceDataIndexEnabled(true);
  });

  afterEach(() => {
    resetSpaceDataIndexForTests();
    setSpaceDataIndexEnabled(true);
  });

  it('键位补全:同 spaceID 族列出(跨文件写点计数),异 spaceID 族不混入', async () => {
    const ws = setupWorkspace();
    try {
      const provider = new KBEngineCompletionProvider();
      const text = ws.texts.get(ws.reader)!;
      const line = text.split('\n')[1];
      const doc = vscode.makeTextDocument(text, { fileName: ws.reader, languageId: 'python' });
      const atOpenQuote = new vscode.Position(1, line.indexOf('"cfg"') + 1);
      const items = await provider.provideCompletionItems(doc, atOpenQuote) as vscode.CompletionItem[];
      expect(items).toHaveLength(1);
      expect(items[0].label).toBe('cfg');
      // 写点计数只数本空间:space 1 有 writer1:2 + writer2:3 两处
      expect(items[0].detail).toContain('writer1.py:2');
      // 异空间(space 2)的键位补全只出 space 2 族
      const text2 = ws.texts.get(ws.writer2)!;
      const line2 = text2.split('\n')[1];
      const doc2 = vscode.makeTextDocument(text2, { fileName: ws.writer2, languageId: 'python' });
      const items2 = await provider.provideCompletionItems(
        doc2, new vscode.Position(1, line2.indexOf('"cfg"') + 1)
      ) as vscode.CompletionItem[];
      expect(items2).toHaveLength(1);
      expect(items2[0].detail).toContain('writer2.py:2');
    } finally {
      ws.restore();
    }
  });

  it('动态 spaceID 键位不给项(不合并为同一确定对象)', async () => {
    const ws = setupWorkspace();
    try {
      const provider = new KBEngineCompletionProvider();
      const dynText = 'import KBEngine\nKBEngine.setSpaceData(entity.spaceID, "\n';
      const doc = vscode.makeTextDocument(dynText, { fileName: ws.reader, languageId: 'python' });
      const items = await provider.provideCompletionItems(
        doc, new vscode.Position(1, dynText.split('\n')[1].length)
      ) as vscode.CompletionItem[];
      expect(items).toEqual([]); // 键位接管但动态空间无键族,不造项
    } finally {
      ws.restore();
    }
  });

  it('F12:get/del 跳首个写点;set 跳首个异类点(读点);动态 sid 不导航', async () => {
    const ws = setupWorkspace();
    try {
      const manager = new EntityMappingManager({ subscriptions: [] } as never);
      const provider = new PythonDefinitionProvider(manager, undefined, undefined);
      const readerText = ws.texts.get(ws.reader)!;
      const readLine = readerText.split('\n')[1];
      const readDoc = vscode.makeTextDocument(readerText, { fileName: ws.reader, languageId: 'python' });
      const fromRead = await provider.provideDefinition(
        readDoc, new vscode.Position(1, readLine.indexOf('cfg') + 1)
      ) as vscode.Location | null;
      expect(fromRead?.uri.fsPath).toBe(ws.writer1); // reader 的 sid=1 首个写点=writer1:2
      expect(fromRead?.range.start.line).toBe(1);
      // set F12 → 首个异类点(同族 get):writer1 的 sid=1 set → reader get
      const w1Text = ws.texts.get(ws.writer1)!;
      const w1Line = w1Text.split('\n')[1];
      const w1Doc = vscode.makeTextDocument(w1Text, { fileName: ws.writer1, languageId: 'python' });
      const fromWrite = await provider.provideDefinition(
        w1Doc, new vscode.Position(1, w1Line.indexOf('cfg') + 1)
      ) as vscode.Location | null;
      expect(fromWrite?.uri.fsPath).toBe(ws.reader);
      // 动态 sid:不建族不导航(null 交回常规链)
      const dynText = 'import KBEngine\nKBEngine.getSpaceData(sid, "cfg")\n';
      fs.writeFileSync(ws.reader, dynText);
      const dynDoc = vscode.makeTextDocument(dynText, { fileName: ws.reader, languageId: 'python' });
      const dyn = await provider.provideDefinition(
        dynDoc, new vscode.Position(1, dynText.split('\n')[1].indexOf('cfg') + 1)
      );
      expect(dyn).toBeNull();
    } finally {
      ws.restore();
    }
  });

  it('Shift+F12:同族全部站点(含自身,跨文件);共享 resolver:开关关/取消即 null', async () => {
    const ws = setupWorkspace();
    try {
      const refs = new KBEngineReferencesProvider(
        new EntityMappingManager({ subscriptions: [] } as never)
      );
      const readerText = ws.texts.get(ws.reader)!;
      const readLine = readerText.split('\n')[1];
      const doc = vscode.makeTextDocument(readerText, { fileName: ws.reader, languageId: 'python' });
      const sites = await refs.provideReferences(
        doc, new vscode.Position(1, readLine.indexOf('cfg') + 1), {} as vscode.ReferenceContext
      );
      expect((sites ?? []).map(loc => path.basename(loc.uri.fsPath)).sort())
        .toEqual(['reader.py', 'writer1.py', 'writer2.py']); // sid=1 族三站点(writer2:3 也是 sid=1)
      // resolver 直测:开关关 null
      setSpaceDataIndexEnabled(false);
      expect(await resolveSpaceDataSitesAtPosition(
        doc, new vscode.Position(1, readLine.indexOf('cfg') + 1)
      )).toBeNull();
    } finally {
      ws.restore();
    }
  });

  it('开关关:键位补全不接管,族键不出现(落回常规链)', async () => {
    const ws = setupWorkspace();
    try {
      setSpaceDataIndexEnabled(false);
      const provider = new KBEngineCompletionProvider();
      const text = ws.texts.get(ws.reader)!;
      const line = text.split('\n')[1];
      const doc = vscode.makeTextDocument(text, { fileName: ws.reader, languageId: 'python' });
      const atOpenQuote = new vscode.Position(1, line.indexOf('"cfg"') + 1);
      const items = await provider.provideCompletionItems(doc, atOpenQuote) as vscode.CompletionItem[];
      // 门关 → 键位分支 null → 常规链接管:spaceData 族键('cfg')绝不出
      expect(items.some(item => item.label === 'cfg')).toBe(false);
    } finally {
      ws.restore();
    }
  });

  it('前缀不匹配的族被跳过(键位不造无关项)', async () => {
    const ws = setupWorkspace();
    try {
      const provider = new KBEngineCompletionProvider();
      const text = 'import KBEngine\nvalue = KBEngine.getSpaceData(1, "zz\n';
      const doc = vscode.makeTextDocument(text, { fileName: ws.reader, languageId: 'python' });
      const items = await provider.provideCompletionItems(
        doc, new vscode.Position(1, text.split('\n')[1].length)
      ) as vscode.CompletionItem[];
      // 族键 'cfg' 与片段 'zz' 无前缀关系:continue,一项不给
      expect(items).toEqual([]);
    } finally {
      ws.restore();
    }
  });

  it('纯读键族诚实标「无写点」', async () => {
    const ws = setupWorkspace();
    try {
      const provider = new KBEngineCompletionProvider();
      // reader 改成 get-only:首行完闭调用建族 family (5, "ro"),光标行
      // 另起(未闭合行不建族,只探测键位)——族内只有读点没有写点。
      const text = 'import KBEngine\nprev = KBEngine.getSpaceData(5, "ro")\nvalue = KBEngine.getSpaceData(5, "ro\n';
      fs.writeFileSync(ws.reader, text);
      const doc = vscode.makeTextDocument(text, { fileName: ws.reader, languageId: 'python' });
      const items = await provider.provideCompletionItems(
        doc, new vscode.Position(2, text.split('\n')[2].length)
      ) as vscode.CompletionItem[];
      expect(items.map(item => item.label)).toEqual(['ro']);
      expect(items[0].detail).toContain('no write site');
      expect(items[0].detail).toContain('0 write site');
    } finally {
      ws.restore();
    }
  });
});

// ---------------------------------------------------------------------------
// KSEM-DATA-06 纯核:参数扫描容错面 / 补全首参形态 / 光标探测边界
// ---------------------------------------------------------------------------

describe('KSEM-DATA-06 纯核:参数扫描容错面', () => {
  it('实参内转义与嵌套容器:引号态跳转义、深度回账,元数精确照收', () => {
    const text = [
      'import KBEngine',
      'KBEngine.setSpaceData(1, "a\\"b", {"depth": [1, 2]})'
    ].join('\n');
    const calls = findKbeSpaceDataCalls(text, ALIASES);
    expect(calls).toHaveLength(1);
    expect(calls[0].keySignature).toBe('a\\"b'); // 原文内部,不解转义(同族既定口径)
    expect(calls[0].spaceIdSignature).toBe('1');
  });

  it('实参两侧空白裁净;空白 key 位=非字面量记录;拼接串内嵌同引号拒绝', () => {
    const trailingText = 'import KBEngine\nKBEngine.getSpaceData(1, "cfg" )';
    const trailing = findKbeSpaceDataCalls(trailingText, ALIASES);
    expect(trailing).toHaveLength(1);
    expect(trailing[0].keySignature).toBe('cfg');

    const emptyText = 'import KBEngine\nKBEngine.setSpaceData(1, , 2)';
    const empty = findKbeSpaceDataCalls(emptyText, ALIASES);
    expect(empty).toHaveLength(1);
    expect(empty[0].keySignature).toBeNull(); // 空实参非字面量:记而不入族
    expect(empty[0].keyStart).toBe(emptyText.split('\n')[1].indexOf(', ,') + 2);

    const glueText = "import KBEngine\nKBEngine.setSpaceData(1, 'a' + 'b', 2)";
    const glue = findKbeSpaceDataCalls(glueText, ALIASES);
    expect(glue).toHaveLength(1);
    expect(glue[0].keySignature).toBeNull(); // 'a' + 'b' 内嵌同引号:非简单字面量
  });

  it('别名面:空别名集早退;名单外别名不收', () => {
    expect(findKbeSpaceDataCalls('KBEngine.setSpaceData(1, "k", "v")', new Set())).toEqual([]);
    expect(findKbeSpaceDataCalls('zzz.setSpaceData(1, "k", "v")', ALIASES)).toEqual([]);
  });
});

describe('KSEM-DATA-06 纯核:键位补全首实参形态', () => {
  it('转义字符串首参:跳转义、经闭引号与顶层逗号,sid 动态', () => {
    const line = 'KBEngine.setSpaceData("a\\"b", "';
    const context = spaceDataKeyCompletionContext(line, line.length, ALIASES);
    expect(context).not.toBeNull();
    expect(context?.fn).toBe('setSpaceData');
    expect(context?.spaceIdSignature).toBeNull(); // "a\"b" 既非 int 字面量也非标识符
    expect(context?.partial).toBe('');
  });

  it('首参引号未闭 / 含容器 opener → 无顶层逗号 → null;调用已闭合 → null', () => {
    const unterminated = 'KBEngine.setSpaceData("unterminated';
    expect(spaceDataKeyCompletionContext(unterminated, unterminated.length, ALIASES)).toBeNull();
    const bracketed = 'KBEngine.setSpaceData(["x", "';
    expect(spaceDataKeyCompletionContext(bracketed, bracketed.length, ALIASES)).toBeNull();
    const closed = 'KBEngine.setSpaceData(1)';
    expect(spaceDataKeyCompletionContext(closed, closed.length, ALIASES)).toBeNull();
  });

  it('属性链与名单外别名在补全面同不收;空别名集早退', () => {
    const chained = 'x.KBEngine.setSpaceData(1, "';
    expect(spaceDataKeyCompletionContext(chained, chained.length, ALIASES)).toBeNull();
    const unknownAlias = 'zzz.setSpaceData(1, "';
    expect(spaceDataKeyCompletionContext(unknownAlias, unknownAlias.length, ALIASES)).toBeNull();
    const noAlias = 'KBEngine.setSpaceData(1, "';
    expect(spaceDataKeyCompletionContext(noAlias, noAlias.length, new Set())).toBeNull();
  });
});

describe('KSEM-DATA-06 纯核:光标键位探测边界', () => {
  it('行/列越界与无调用行 → null;键内容列命中带回该调用', () => {
    const text = 'import KBEngine\nKBEngine.setSpaceData(1, "cfg", "hello")';
    expect(findKbeSpaceDataCallAtPosition(text, 99, 0, ALIASES)).toBeNull();
    expect(findKbeSpaceDataCallAtPosition(text, 1, 999, ALIASES)).toBeNull();
    expect(findKbeSpaceDataCallAtPosition(text, 0, 5, ALIASES)).toBeNull();
    const hit = findKbeSpaceDataCallAtPosition(text, 1, 26, ALIASES);
    expect(hit?.keySignature).toBe('cfg');
    expect(hit?.spaceIdSignature).toBe('1');
  });
});
