/**
 * RUST-004-W2(2026-11-15 审核拆项)验收钉:SpaceData 索引就绪标注接消费端。
 *
 * 验收口径(todo.md RUST-004-W2):completion/pythonDefinition 从旧
 * queryFamiliesForSpace/queryFamilySites 转接 marked 接口并处理 ready;
 * 未就绪、空就绪、扫描完成、根移除四态可区分;现有补全与跳转正确性保留;
 * 不为取得 ready 阻塞等待全仓。
 *
 * 三面:
 *  - 四态(索引面):未就绪 partial-real(已蓄内容照流,ready:false)/
 *    空就绪(ready:true+空)/ 扫描完成(ready:true+全量)/ 弃置
 *    (ready:false+空);
 *  - 就绪竞速(awaitSpaceDataIndexReady 三态,与 awaitDataDictIndexReady
 *    同判据同预算):快扫描 ready / 挂死初扫预算耗尽 pending(预热仍在飞)/
 *    取消 cancelled / 无 token 离线语义照旧等全量;
 *  - 消费端 pending 面:补全出部分真实键族 + 列表 isIncomplete(编辑器
 *    后续输入重查,初扫完成后自然刷新);跳转/引用走 queryFamilySitesMarked
 *    出 {sites: 部分, ready:false},查空交回常规链既有口径。
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as vscode from 'vscode';
import { EntityMappingManager } from '../src/entityMapping';
import {
  KBEngineCompletionProvider,
  resolveSpaceDataSitesAtPosition
} from '../src/languageProviders';
import {
  awaitSpaceDataIndexReady
} from '../src/languageProviders/pythonDefinition';
import {
  getSpaceDataIndex,
  resetSpaceDataIndexForTests,
  setSpaceDataIndexEnabled,
  SpaceDataIndex
} from '../src/spaceDataIndex';

const stubManager = (): EntityMappingManager =>
  new EntityMappingManager({ subscriptions: [] } as never);

const WRITER_TEXT = 'import KBEngine\nKBEngine.setSpaceData(1, "cfg", "x")\n';
const READER_TEXT = 'import KBEngine\nvalue = KBEngine.getSpaceData(1, "cfg")\n';
const KEY_IN_READER = READER_TEXT.split('\n')[1].indexOf('"cfg"') + 1;

describe('RUST-004-W2 四态(索引面)', () => {
  let originalFind: typeof vscode.workspace.findFiles | undefined;
  let originalRead: typeof vscode.workspace.fs.readFile | undefined;

  beforeEach(() => {
    originalFind = vscode.workspace.findFiles;
    originalRead = vscode.workspace.fs.readFile;
    vscode.workspace.fs.readFile = async uri => fs.readFileSync(uri.fsPath);
  });

  afterEach(() => {
    if (originalFind) {
      vscode.workspace.findFiles = originalFind;
    }
    if (originalRead) {
      vscode.workspace.fs.readFile = originalRead;
    }
  });

  it('未就绪 partial-real:updateFile 已蓄内容照流,ready 如实 false(强制空族丢真实键在此红)', () => {
    const index = new SpaceDataIndex();
    try {
      // 事件驱动面无需初扫即可蓄内容(updateFile 同步提交)
      index.updateFile('/w/a.py', WRITER_TEXT);
      const families = index.queryFamiliesForSpaceMarked('1');
      expect(families.ready, '初扫未跑完必须如实标 ready:false').toBe(false);
      expect(families.families.map(family => family.keySignature), '部分真实内容照流').toEqual(['cfg']);
      const sites = index.queryFamilySitesMarked('1', 'cfg');
      expect(sites.ready).toBe(false);
      expect(sites.sites.map(site => site.fn)).toEqual(['setSpaceData']);
    } finally {
      index.dispose();
    }
  });

  it('空就绪:初扫完成 + 该空间无键 → ready:true + [](与未就绪可区分)', async () => {
    vscode.workspace.findFiles = async () => [];
    const index = new SpaceDataIndex();
    try {
      await index.ensureStarted();
      const marked = index.queryFamiliesForSpaceMarked('9');
      expect(marked.ready).toBe(true);
      expect(marked.families).toEqual([]);
    } finally {
      index.dispose();
    }
  });

  it('扫描完成:ready:true + 全量(与 plain query 同源)', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-sd-ready-'));
    const writer = path.join(root, 'writer.py');
    fs.writeFileSync(writer, WRITER_TEXT);
    vscode.workspace.findFiles = async () => [vscode.Uri.file(writer)];
    const index = new SpaceDataIndex();
    try {
      await index.ensureStarted();
      const marked = index.queryFamilySitesMarked('1', 'cfg');
      expect(marked.ready).toBe(true);
      expect(marked.sites.map(site => site.file)).toEqual(
        index.queryFamilySites('1', 'cfg').map(site => site.file)
      );
      expect(marked.sites).toHaveLength(1);
    } finally {
      index.dispose();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('弃置(根移除/收尾):ready:false + 空(与空就绪可区分)', () => {
    const index = new SpaceDataIndex();
    index.updateFile('/w/a.py', WRITER_TEXT);
    index.dispose();
    const marked = index.queryFamiliesForSpaceMarked('1');
    expect(marked.ready).toBe(false);
    expect(marked.families).toEqual([]);
    expect(index.queryFamilySitesMarked('1', 'cfg').sites).toEqual([]);
  });
});

describe('RUST-004-W2 就绪竞速三态(awaitSpaceDataIndexReady)', () => {
  let root = '';
  let writer = '';
  let originalFind: typeof vscode.workspace.findFiles | undefined;
  let originalRead: typeof vscode.workspace.fs.readFile | undefined;
  let releaseScan: (() => void) | null = null;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-sd-budget-'));
    writer = path.join(root, 'writer.py');
    fs.writeFileSync(writer, WRITER_TEXT);
    originalFind = vscode.workspace.findFiles;
    originalRead = vscode.workspace.fs.readFile;
    vscode.workspace.fs.readFile = async uri => fs.readFileSync(uri.fsPath);
    process.env.KODE_DATA_DICT_READY_BUDGET_MS = '40';
  });

  afterEach(async () => {
    // 释放可能仍挂着的扫描,免跨用例悬挂
    releaseScan?.();
    releaseScan = null;
    if (originalFind) {
      vscode.workspace.findFiles = originalFind;
    }
    if (originalRead) {
      vscode.workspace.fs.readFile = originalRead;
    }
    delete process.env.KODE_DATA_DICT_READY_BUDGET_MS;
    await new Promise(resolve => setTimeout(resolve, 60));
    fs.rmSync(root, { recursive: true, force: true });
  });

  /** 挂死扫描:findFiles 返回手工释放的 deferred(预算耗尽面用挂死形态)。 */
  const hangScan = (): void => {
    vscode.workspace.findFiles = () =>
      new Promise<vscode.Uri[]>(resolve => {
        releaseScan = () => resolve([vscode.Uri.file(writer)]);
      });
  };

  it('初扫在预算内完成 → ready(快路径与旧行为一致)', async () => {
    vscode.workspace.findFiles = async () => [vscode.Uri.file(writer)];
    const index = new SpaceDataIndex();
    try {
      const readiness = await awaitSpaceDataIndexReady(index, undefined as never, 40);
      expect(readiness).toBe('ready');
      expect(index.isReady).toBe(true);
    } finally {
      index.dispose();
    }
  });

  it('初扫挂死 → 预算耗尽 pending,后台预热已被踢出且仍在飞', async () => {
    hangScan();
    const index = new SpaceDataIndex();
    try {
      const t0 = Date.now();
      // pending 面须有请求上下文(带 token 才走预算竞速;undefined=离线语义等全量)
      const readiness = await awaitSpaceDataIndexReady(index, { isCancellationRequested: false } as never, 40);
      expect(readiness).toBe('pending');
      expect(Date.now() - t0).toBeLessThan(2000);
      // 预热单独调度:ensureStarted 已踢出,索引尚未就绪(扫描仍在后台飞)
      expect(index.isReady).toBe(false);
    } finally {
      index.dispose();
    }
  });

  it('pending 后初扫完成 → 下一次调用 ready 快路径(完成后正常刷新)', async () => {
    hangScan();
    const index = new SpaceDataIndex();
    try {
      expect(await awaitSpaceDataIndexReady(index, { isCancellationRequested: false } as never, 40)).toBe('pending');
      releaseScan?.();
      releaseScan = null;
      // 后台预热收敛(轮询免时序脆断)
      for (let i = 0; i < 100 && !index.isReady; i += 1) {
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      expect(index.isReady).toBe(true);
      expect(await awaitSpaceDataIndexReady(index, { isCancellationRequested: false } as never, 40)).toBe('ready');
    } finally {
      index.dispose();
    }
  });

  it('等待期间取消 → cancelled', async () => {
    hangScan();
    const index = new SpaceDataIndex();
    const subscriptions: Array<{ dispose(): void }> = [];
    const token = {
      isCancellationRequested: false,
      onCancellationRequested: (cb: () => void) => {
        subscriptions.push({ dispose: () => undefined });
        setTimeout(cb, 10);
        return { dispose: () => undefined };
      }
    };
    try {
      const readiness = await awaitSpaceDataIndexReady(index, token as never, 5000);
      expect(readiness).toBe('cancelled');
    } finally {
      index.dispose();
    }
  });

  it('无 token → 无视预算等全量(离线程序化语义不变)', async () => {
    // env 预算 40ms,扫描 ~120ms 后才放行:若 raced 预算会 pending,等全量则 ready
    hangScan();
    const index = new SpaceDataIndex();
    try {
      setTimeout(() => releaseScan?.(), 120);
      const readiness = await awaitSpaceDataIndexReady(index);
      expect(readiness).toBe('ready');
      expect(index.isReady).toBe(true);
    } finally {
      index.dispose();
    }
  });

  it('桩 token(无取消订阅面)+ 挂死初扫 → 退化预算竞速出 pending', async () => {
    hangScan();
    const index = new SpaceDataIndex();
    try {
      const readiness = await awaitSpaceDataIndexReady(index, { isCancellationRequested: false } as never, 40);
      expect(readiness).toBe('pending');
    } finally {
      index.dispose();
    }
  });
});

describe('RUST-004-W2 消费端 pending 面(补全 isIncomplete / 跳转引用 marked)', () => {
  let root = '';
  let writer = '';
  let originalFind: typeof vscode.workspace.findFiles | undefined;
  let originalRead: typeof vscode.workspace.fs.readFile | undefined;
  let releaseScan: (() => void) | null = null;

  const hangScan = (): void => {
    vscode.workspace.findFiles = () =>
      new Promise<vscode.Uri[]>(resolve => {
        releaseScan = () => resolve([vscode.Uri.file(writer)]);
      });
  };

  const setupReadyScan = (): void => {
    vscode.workspace.findFiles = async () => [vscode.Uri.file(writer)];
  };

  const completionDoc = (): { doc: vscode.TextDocument; position: vscode.Position } => {
    // 键位上下文:setSpaceData 第二实参引号内,光标在片段尾
    const text = 'import KBEngine\nKBEngine.setSpaceData(1, "cf\n';
    const doc = vscode.makeTextDocument(text, {
      fileName: path.join(root, 'open.py'),
      languageId: 'python'
    });
    const line = text.split('\n')[1];
    return { doc, position: new vscode.Position(1, line.length) };
  };

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-sd-pending-'));
    writer = path.join(root, 'writer.py');
    fs.writeFileSync(writer, WRITER_TEXT);
    originalFind = vscode.workspace.findFiles;
    originalRead = vscode.workspace.fs.readFile;
    vscode.workspace.fs.readFile = async uri => fs.readFileSync(uri.fsPath);
    resetSpaceDataIndexForTests();
    setSpaceDataIndexEnabled(true);
    process.env.KODE_DATA_DICT_READY_BUDGET_MS = '40';
  });

  afterEach(async () => {
    releaseScan?.();
    releaseScan = null;
    if (originalFind) {
      vscode.workspace.findFiles = originalFind;
    }
    if (originalRead) {
      vscode.workspace.fs.readFile = originalRead;
    }
    delete process.env.KODE_DATA_DICT_READY_BUDGET_MS;
    resetSpaceDataIndexForTests();
    setSpaceDataIndexEnabled(true);
    await new Promise(resolve => setTimeout(resolve, 60));
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('补全:挂死初扫 + 已蓄部分键族 → CompletionList isIncomplete:true 含部分族(不装终答不造假)', async () => {
    hangScan();
    const index = getSpaceDataIndex();
    const provider = new KBEngineCompletionProvider(stubManager());
    try {
      // 部分真实内容:事件驱动面无需初扫即可蓄内容(updateFile 同步提交)
      index.updateFile(writer, WRITER_TEXT);
      const { doc, position } = completionDoc();
      // 请求上下文:真实编辑器恒传 token;预算竞速只在带 token 的请求面生效
      const result = await provider.provideCompletionItems(
        doc,
        position,
        { isCancellationRequested: false } as never
      );
      expect(result, 'pending 面回 CompletionList').toBeInstanceOf(vscode.CompletionList);
      const list = result as vscode.CompletionList;
      expect(list.isIncomplete, '未就绪必须标 incomplete(可刷新),不装终答').toBe(true);
      expect(list.items.map(item => String(item.label))).toContain('cfg');
    } finally {
      index.dispose();
    }
  });

  it('补全:就绪后 → 普通数组全量键族(ready 路径不包 CompletionList)', async () => {
    setupReadyScan();
    const index = getSpaceDataIndex();
    const provider = new KBEngineCompletionProvider(stubManager());
    try {
      const { doc, position } = completionDoc();
      const result = await provider.provideCompletionItems(doc, position);
      expect(Array.isArray(result), '就绪路径保持既有数组形态').toBe(true);
      expect((result as vscode.CompletionItem[]).map(item => String(item.label))).toContain('cfg');
    } finally {
      index.dispose();
    }
  });

  it('补全:挂死初扫 + 无任何部分内容 → isIncomplete 空列表(冷空不装完整空结果)', async () => {
    hangScan();
    const index = getSpaceDataIndex();
    const provider = new KBEngineCompletionProvider(stubManager());
    try {
      const { doc, position } = completionDoc();
      const result = await provider.provideCompletionItems(
        doc,
        position,
        { isCancellationRequested: false } as never
      );
      expect(result).toBeInstanceOf(vscode.CompletionList);
      expect((result as vscode.CompletionList).isIncomplete).toBe(true);
      expect((result as vscode.CompletionList).items).toHaveLength(0);
    } finally {
      index.dispose();
    }
  });

  it('补全:取消 → provider 顶早退 null(既有口径不变)', async () => {
    hangScan();
    const index = getSpaceDataIndex();
    const provider = new KBEngineCompletionProvider(stubManager());
    try {
      const { doc, position } = completionDoc();
      const result = await provider.provideCompletionItems(
        doc,
        position,
        { isCancellationRequested: true } as never
      );
      expect(result).toBeNull();
    } finally {
      index.dispose();
    }
  });

  it('跳转/引用:挂死初扫 → {sites:部分真实(自档 syncDocument), ready:false}', async () => {
    hangScan();
    const index = getSpaceDataIndex();
    try {
      const doc = vscode.makeTextDocument(READER_TEXT, {
        fileName: path.join(root, 'reader.py'),
        languageId: 'python'
      });
      const token = { isCancellationRequested: false } as never;
      const hit = await resolveSpaceDataSitesAtPosition(doc, new vscode.Position(1, KEY_IN_READER), token);
      expect(hit).not.toBeNull();
      expect(hit!.ready, '初扫仍在飞必须如实标 ready:false').toBe(false);
      expect(hit!.call.fn).toBe('getSpaceData');
      expect(hit!.sites.length, '部分真实站点照常流出(partial-real)').toBeGreaterThan(0);
    } finally {
      index.dispose();
    }
  });

  it('跳转/引用:就绪后 → ready:true(与既有形态同源)', async () => {
    setupReadyScan();
    const index = getSpaceDataIndex();
    try {
      const doc = vscode.makeTextDocument(READER_TEXT, {
        fileName: path.join(root, 'reader.py'),
        languageId: 'python'
      });
      const token = { isCancellationRequested: false } as never;
      const hit = await resolveSpaceDataSitesAtPosition(doc, new vscode.Position(1, KEY_IN_READER), token);
      expect(hit).not.toBeNull();
      expect(hit!.ready).toBe(true);
      expect(hit!.sites.length).toBeGreaterThan(0);
    } finally {
      index.dispose();
    }
  });

  it('跳转/引用:取消 → null(既有口径不变)', async () => {
    hangScan();
    const index = getSpaceDataIndex();
    try {
      const doc = vscode.makeTextDocument(READER_TEXT, {
        fileName: path.join(root, 'reader.py'),
        languageId: 'python'
      });
      const hit = await resolveSpaceDataSitesAtPosition(
        doc,
        new vscode.Position(1, KEY_IN_READER),
        { isCancellationRequested: true } as never
      );
      expect(hit).toBeNull();
    } finally {
      index.dispose();
    }
  });
});
