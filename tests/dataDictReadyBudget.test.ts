/**
 * RUST-004-W1(2026-11-15 审计拆项)验收钉:GlobalData 索引就绪标注接消费端。
 *
 * 验收口径(todo.md RUST-004-W1):挂住首次扫描时请求在预算内返回可解释的
 * 未就绪/不完整状态,完成后正常刷新,不把冷空集当已完整或伪造不存在诊断。
 *
 * 三面:
 *  - 预算解析(纯核):缺省/env 覆盖/非法回缺省;
 *  - 就绪竞速(awaitDataDictIndexReady 三态):快扫描 ready / 挂死初扫预算
 *    耗尽 pending(后台预热仍在飞) / 取消 cancelled / 无 token 离线语义
 *    照旧等全量;
 *  - 消费端 pending 面:补全走 queryKeyFamiliesMarked 出部分真实键族 + 列表
 *    isIncomplete(编辑器继续输入重查,初扫完成后自然刷新);跳转/引用走
 *    marked 路由出 {sites: 部分, ready:false},查空交回常规链既有口径。
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as vscode from 'vscode';
import { EntityMappingManager } from '../src/entityMapping';
import { KBEngineCompletionProvider } from '../src/languageProviders';
import { GlobalDataDictIndex } from '../src/globalDataIndex';
import {
  DATA_DICT_READY_DEFAULT_BUDGET_MS,
  resolveColdIndexReadyBudgetMs as resolveDataDictReadyBudgetMs
} from '../src/coldIndexReadiness';
import {
  awaitDataDictIndexReady,
  resolveDataDictSitesAtPosition
} from '../src/languageProviders/pythonDefinition';

const stubManager = (): EntityMappingManager =>
  new EntityMappingManager({ subscriptions: [] } as never);

const WRITER_TEXT = 'import KBEngine\nKBEngine.globalData["cfg"] = 1\n';
const READER_TEXT = 'import KBEngine\nv = KBEngine.globalData["cfg"]\n';

describe('RUST-004-W1 预算解析(纯核)', () => {
  const originalEnv = process.env.KODE_DATA_DICT_READY_BUDGET_MS;

  const restoreEnv = (): void => {
    if (originalEnv === undefined) {
      delete process.env.KODE_DATA_DICT_READY_BUDGET_MS;
    } else {
      process.env.KODE_DATA_DICT_READY_BUDGET_MS = originalEnv;
    }
  };

  it('缺省 1500ms', () => {
    delete process.env.KODE_DATA_DICT_READY_BUDGET_MS;
    expect(resolveDataDictReadyBudgetMs()).toBe(DATA_DICT_READY_DEFAULT_BUDGET_MS);
    expect(DATA_DICT_READY_DEFAULT_BUDGET_MS).toBe(1500);
    restoreEnv();
  });

  it('env 覆盖生效;非法/零/负诚实回缺省', () => {
    delete process.env.KODE_DATA_DICT_READY_BUDGET_MS;
    process.env.KODE_DATA_DICT_READY_BUDGET_MS = '250';
    expect(resolveDataDictReadyBudgetMs()).toBe(250);
    for (const bad of ['abc', '0', '-5', 'Infinity']) {
      process.env.KODE_DATA_DICT_READY_BUDGET_MS = bad;
      expect(resolveDataDictReadyBudgetMs()).toBe(DATA_DICT_READY_DEFAULT_BUDGET_MS);
    }
    restoreEnv();
  });
});

describe('RUST-004-W1 就绪竞速三态(awaitDataDictIndexReady)', () => {
  let root = '';
  let writer = '';
  let reader = '';
  let originalFind: typeof vscode.workspace.findFiles | undefined;
  let originalRead: typeof vscode.workspace.fs.readFile | undefined;
  let releaseScan: (() => void) | null = null;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-dd-budget-'));
    writer = path.join(root, 'writer.py');
    reader = path.join(root, 'reader.py');
    fs.writeFileSync(writer, WRITER_TEXT);
    fs.writeFileSync(reader, READER_TEXT);
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
        releaseScan = () => resolve([vscode.Uri.file(writer), vscode.Uri.file(reader)]);
      });
  };

  it('初扫在预算内完成 → ready(快路径与旧行为一致)', async () => {
    vscode.workspace.findFiles = async () => [vscode.Uri.file(writer)];
    const index = new GlobalDataDictIndex();
    try {
      const readiness = await awaitDataDictIndexReady(index, undefined as never, 40);
      expect(readiness).toBe('ready');
      expect(index.isReady).toBe(true);
    } finally {
      index.dispose();
    }
  });

  it('初扫挂死 → 预算耗尽 pending,后台预热已被踢出且仍在飞', async () => {
    hangScan();
    const index = new GlobalDataDictIndex();
    try {
      const t0 = Date.now();
      // pending 面须有请求上下文(带 token 才走预算竞速;undefined=离线语义等全量)
      const readiness = await awaitDataDictIndexReady(index, { isCancellationRequested: false } as never, 40);
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
    const index = new GlobalDataDictIndex();
    try {
      expect(await awaitDataDictIndexReady(index, { isCancellationRequested: false } as never, 40)).toBe('pending');
      releaseScan?.();
      releaseScan = null;
      // 后台预热收敛(轮询免时序脆断)
      for (let i = 0; i < 100 && !index.isReady; i += 1) {
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      expect(index.isReady).toBe(true);
      expect(await awaitDataDictIndexReady(index, { isCancellationRequested: false } as never, 40)).toBe('ready');
    } finally {
      index.dispose();
    }
  });

  it('等待期间取消 → cancelled', async () => {
    hangScan();
    const index = new GlobalDataDictIndex();
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
      const readiness = await awaitDataDictIndexReady(index, token as never, 5000);
      expect(readiness).toBe('cancelled');
    } finally {
      index.dispose();
    }
  });

  it('无 token → 无视预算等全量(离线程序化语义不变)', async () => {
    // env 预算 40ms,扫描 ~120ms 后才放行:若 raced 预算会 pending,等全量则 ready
    hangScan();
    const index = new GlobalDataDictIndex();
    try {
      setTimeout(() => releaseScan?.(), 120);
      const readiness = await awaitDataDictIndexReady(index);
      expect(readiness).toBe('ready');
      expect(index.isReady).toBe(true);
    } finally {
      index.dispose();
    }
  });

  it('桩 token(无取消订阅面)+ 挂死初扫 → 退化预算竞速出 pending', async () => {
    hangScan();
    const index = new GlobalDataDictIndex();
    try {
      const readiness = await awaitDataDictIndexReady(index, { isCancellationRequested: false } as never, 40);
      expect(readiness).toBe('pending');
    } finally {
      index.dispose();
    }
  });
});

describe('RUST-004-W1 消费端 pending 面(补全 isIncomplete / 跳转引用 marked)', () => {
  let root = '';
  let writer = '';
  let reader = '';
  let originalFind: typeof vscode.workspace.findFiles | undefined;
  let originalRead: typeof vscode.workspace.fs.readFile | undefined;
  let originalFolders: typeof vscode.workspace.workspaceFolders | undefined;
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

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-dd-pending-'));
    // 进程角色目录(DATA-02 同款):键族站点须在域内才出项,顶层文件被域过滤
    writer = path.join(root, 'base', 'writer.py');
    reader = path.join(root, 'base', 'reader.py');
    fs.mkdirSync(path.dirname(writer), { recursive: true });
    fs.writeFileSync(writer, WRITER_TEXT);
    fs.writeFileSync(reader, READER_TEXT);
    originalFind = vscode.workspace.findFiles;
    originalRead = vscode.workspace.fs.readFile;
    originalFolders = vscode.workspace.workspaceFolders;
    vscode.workspace.fs.readFile = async uri => fs.readFileSync(uri.fsPath);
    vscode.workspace.workspaceFolders = [{ uri: vscode.Uri.file(root), name: 'ws', index: 0 }];
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
    if (originalFolders !== undefined) {
      vscode.workspace.workspaceFolders = originalFolders;
    }
    delete process.env.KODE_DATA_DICT_READY_BUDGET_MS;
    await new Promise(resolve => setTimeout(resolve, 60));
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('补全:挂死初扫 + noteSaved 部分真实键族 → CompletionList isIncomplete:true 含部分族(不装终答不造假)', async () => {
    hangScan();
    const index = new GlobalDataDictIndex();
    const provider = new KBEngineCompletionProvider(stubManager(), index);
    try {
      // 部分真实内容:事件驱动面无需初扫即可蓄内容(noteSaved 同步提交)
      index.noteSaved(
        vscode.makeTextDocument(WRITER_TEXT, { fileName: writer, languageId: 'python' })
      );
      const text = 'import KBEngine\nKBEngine.globalData["\n';
      const doc = vscode.makeTextDocument(text, {
        fileName: path.join(root, 'base', 'open.py'),
        languageId: 'python'
      });
      const line = text.split('\n')[1];
      // 请求上下文:真实编辑器恒传 token;预算竞速只在带 token 的请求面生效
      const result = await provider.provideCompletionItems(
        doc,
        new vscode.Position(1, line.length),
        { isCancellationRequested: false } as never
      );
      expect(result, 'pending 面回 CompletionList').toBeInstanceOf(vscode.CompletionList);
      const list = result as vscode.CompletionList;
      expect(list.isIncomplete, '未就绪必须标 incomplete(可刷新),不装终答').toBe(true);
      const labels = list.items.map(item => String(item.label));
      expect(labels).toContain('cfg');
    } finally {
      index.dispose();
    }
  });

  it('补全:就绪后 → 普通数组全量键族(ready 路径不包 CompletionList)', async () => {
    setupReadyScan();
    const index = new GlobalDataDictIndex();
    const provider = new KBEngineCompletionProvider(stubManager(), index);
    try {
      const text = 'import KBEngine\nKBEngine.globalData["\n';
      const doc = vscode.makeTextDocument(text, {
        fileName: path.join(root, 'base', 'open.py'),
        languageId: 'python'
      });
      const line = text.split('\n')[1];
      const result = await provider.provideCompletionItems(doc, new vscode.Position(1, line.length));
      expect(Array.isArray(result), '就绪路径保持既有数组形态').toBe(true);
      expect((result as vscode.CompletionItem[]).map(item => String(item.label))).toContain('cfg');
    } finally {
      index.dispose();
    }
  });

  it('补全:挂死初扫 + 无任何部分内容 → isIncomplete 空列表(冷空不装完整空结果)', async () => {
    hangScan();
    const index = new GlobalDataDictIndex();
    const provider = new KBEngineCompletionProvider(stubManager(), index);
    try {
      const text = 'import KBEngine\nKBEngine.globalData["\n';
      const doc = vscode.makeTextDocument(text, {
        fileName: path.join(root, 'base', 'open.py'),
        languageId: 'python'
      });
      const line = text.split('\n')[1];
      const result = await provider.provideCompletionItems(
        doc,
        new vscode.Position(1, line.length),
        { isCancellationRequested: false } as never
      );
      expect(result).toBeInstanceOf(vscode.CompletionList);
      expect((result as vscode.CompletionList).isIncomplete).toBe(true);
      expect((result as vscode.CompletionList).items).toHaveLength(0);
    } finally {
      index.dispose();
    }
  });

  it('跳转/引用:挂死初扫 + noteSaved 部分内容 → {sites:部分真实, ready:false}', async () => {
    hangScan();
    const index = new GlobalDataDictIndex();
    try {
      index.noteSaved(
        vscode.makeTextDocument(WRITER_TEXT, { fileName: writer, languageId: 'python' })
      );
      index.noteSaved(
        vscode.makeTextDocument(READER_TEXT, {
          fileName: path.join(root, 'base', 'reader.py'),
          languageId: 'python'
        })
      );
      const doc = vscode.makeTextDocument(READER_TEXT, {
        fileName: path.join(root, 'base', 'reader.py'),
        languageId: 'python'
      });
      const line = READER_TEXT.split('\n')[1];
      const token = { isCancellationRequested: false } as never;
      const hit = await resolveDataDictSitesAtPosition(index, doc, new vscode.Position(1, line.indexOf('cfg') + 1), token);
      expect(hit).not.toBeNull();
      expect(hit!.ready, '初扫仍在飞必须如实标 ready:false').toBe(false);
      expect(hit!.sites.length, '部分真实站点照常流出(partial-real)').toBeGreaterThan(0);
      // 签名归一口径与 DATA-02 键族标签同源(字面量键去引号)
      expect(hit!.sites.every(site => site.keySignature === 'cfg')).toBe(true);
    } finally {
      index.dispose();
    }
  });

  it('跳转/引用:就绪后 → ready:true(与既有形态同源)', async () => {
    setupReadyScan();
    const index = new GlobalDataDictIndex();
    try {
      const doc = vscode.makeTextDocument(READER_TEXT, {
        fileName: path.join(root, 'base', 'reader2.py'),
        languageId: 'python'
      });
      fs.writeFileSync(path.join(root, 'base', 'reader2.py'), READER_TEXT);
      const line = READER_TEXT.split('\n')[1];
      const token = { isCancellationRequested: false } as never;
      const hit = await resolveDataDictSitesAtPosition(index, doc, new vscode.Position(1, line.indexOf('cfg') + 1), token);
      expect(hit).not.toBeNull();
      expect(hit!.ready).toBe(true);
      expect(hit!.sites.length).toBeGreaterThan(0);
    } finally {
      index.dispose();
    }
  });

  it('跳转/引用:取消 → null(既有口径不变)', async () => {
    hangScan();
    const index = new GlobalDataDictIndex();
    try {
      const doc = vscode.makeTextDocument(READER_TEXT, {
        fileName: path.join(root, 'base', 'reader.py'),
        languageId: 'python'
      });
      const line = READER_TEXT.split('\n')[1];
      const hit = await resolveDataDictSitesAtPosition(
        index,
        doc,
        new vscode.Position(1, line.indexOf('cfg') + 1),
        { isCancellationRequested: true } as never
      );
      expect(hit).toBeNull();
    } finally {
      index.dispose();
    }
  });
});
