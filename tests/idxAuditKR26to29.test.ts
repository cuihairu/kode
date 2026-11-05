import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import * as vscode from 'vscode';
import { Uri } from './fake-vscode/core';
import { workspace as stubWorkspace } from './fake-vscode/workspaceState';
import { GlobalDataDictIndex } from '../src/globalDataIndex';
import { getActiveOperationCounts } from '../src/languageServiceMetrics';
import { PythonClassIndex } from '../src/pythonClassIndex';
import { WorkspaceIndex } from '../src/workspaceIndex';

// KR-AUD-26/27/28/29(索引域外部审核落地)prove-red 用例:
// 每条先在未修复实现上红、修复后绿,口径与 docs/review/external-deep-audit-2026-11-04.md
// IDX-2/IDX-3/IDX-4/IDX-5 的证据段一一对应。

const settle = async (times = 4): Promise<void> => {
  for (let i = 0; i < times; i += 1) {
    await new Promise(resolve => setImmediate(resolve));
  }
};

const waitFor = async (probe: () => boolean, timeoutMs = 3000): Promise<boolean> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (probe()) { return true; }
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  return probe();
};

// ---------------------------------------------------------------------------
// KR-AUD-26(IDX-2):ensureCompositionRoots 连续让位 8 次后只打日志——
// rootsMap 不落地 / metrics 不 end / rootsPromise 不清 → 组合根查询永久空。
// 注入:assignmentsToken 每次调用返回新值 → 每个派生尝试的「起手快照」与
// 「落地复核」必不同 → 稳定复现 8 连让位 fall-through(边缘场景注入)。
// ---------------------------------------------------------------------------
describe('KR-AUD-26 组合根派生连续让位 8 次后正确收尾', () => {
  it('fall-through 按最后快照落地:rootsMap 落地 + metrics end + rootsPromise 清理', async () => {
    const FIXTURE = path.join(__dirname, 'fixtures', 'kbengine-demo-assets');
    const ORIGINAL = stubWorkspace.findFiles;
    const matcherFor = (pattern?: string): ((name: string) => boolean) =>
      pattern && pattern.includes('entities.xml') ? (name => name === 'entities.xml')
        : pattern && pattern.includes('*.def') ? (name => name.endsWith('.def'))
          : pattern && pattern.includes('types.xml') ? (name => name === 'types.xml')
            : (name => name.endsWith('.py'));
    stubWorkspace.findFiles = (async (pattern?: string): Promise<Uri[]> => {
      const out: Uri[] = [];
      const matches = matcherFor(pattern);
      const walk = (dir: string): void => {
        let entries: fs.Dirent[];
        try {
          entries = fs.readdirSync(dir, { withFileTypes: true });
        } catch {
          return;
        }
        for (const entry of entries) {
          const full = path.join(dir, entry.name);
          if (entry.isDirectory()) { walk(full); } else if (matches(entry.name)) { out.push(Uri.file(full)); }
        }
      };
      walk(FIXTURE);
      return out;
    }) as unknown as typeof stubWorkspace.findFiles;
    try {
      const index = new PythonClassIndex();
      const anyIndex = index as unknown as {
        assignmentsToken: () => string;
        rootsMap: { roots: string[] } | null;
        rootsPromise: Promise<void> | null;
      };
      const originalToken = anyIndex.assignmentsToken.bind(index);
      let calls = 0;
      anyIndex.assignmentsToken = (): string => `storm-${calls++}`;
      try {
        const roleRoots = await index.rootsContaining('ROLE');
        expect(roleRoots, '让位风暴结束后组合根应按最后快照落地(旧实现恒空)').toContain('Avatar');
        expect(anyIndex.rootsMap, 'rootsMap 应在 fall-through 后落地').toBeTruthy();
        expect(anyIndex.rootsMap?.roots.length ?? 0).toBeGreaterThan(0);
        expect(anyIndex.rootsPromise, 'rootsPromise 应在 fall-through 后清理').toBeNull();
        expect(getActiveOperationCounts()['python-composition-roots'] ?? 0,
          '组合根派生 metrics 应 end(不留活动任务)').toBe(0);
      } finally {
        anyIndex.assignmentsToken = originalToken;
      }
      // 落地结果真实可用:派生输入稳定后查询正常
      expect(await index.rootsContaining('Monster')).toContain('Monster');
    } finally {
      stubWorkspace.findFiles = ORIGINAL;
    }
  });
});

// ---------------------------------------------------------------------------
// KR-AUD-27(IDX-3):WorkspaceIndex watcher 晚于首扫 await 挂载——初扫窗口内
// 磁盘变更既无监听又无 revision 提升,永久漏事件。对齐 AUD-074 口径:
// watcher 先于 findFiles/首扫挂载 + change 升 revision(监听与全扫互不覆盖)。
// ---------------------------------------------------------------------------
describe('KR-AUD-27 workspaceIndex watcher 先于初扫挂载', () => {
  it('初扫窗口内的磁盘变更即刻入账,watcher 创建先于文件发现', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kr27-'));
    const aPath = path.join(root, 'a.py');
    const bPath = path.join(root, 'b.py');
    const disk = new Map<string, string>([
      [aPath, 'self.addEvent(EV_A, self.on_a)\n'],
      [bPath, 'self.addEvent(EV_B_OLD, self.on_old)\n']
    ]);
    const uriA = vscode.Uri.file(aPath);
    const uriB = vscode.Uri.file(bPath);
    const originalFind = vscode.workspace.findFiles;
    const originalRead = vscode.workspace.fs.readFile;
    const originalWatcher = stubWorkspace.createFileSystemWatcher;
    const events: string[] = [];
    let watcherRef: { fireChange(uri: typeof uriB): void } | null = null;
    let releaseA!: () => void;
    const gateA = new Promise<void>(resolve => { releaseA = resolve; });
    vscode.workspace.findFiles = (async (): Promise<Uri[]> => {
      events.push('find');
      return [uriA, uriB];
    }) as unknown as typeof vscode.workspace.findFiles;
    stubWorkspace.createFileSystemWatcher = ((pattern?: unknown) => {
      events.push('watcher');
      watcherRef = originalWatcher(pattern as never) as typeof watcherRef;
      return watcherRef;
    }) as typeof stubWorkspace.createFileSystemWatcher;
    vscode.workspace.fs.readFile = (async (uri: typeof uriB): Promise<Buffer> => {
      if (uri.fsPath === aPath) { await gateA; }
      return Buffer.from(disk.get(uri.fsPath) ?? '', 'utf8');
    }) as typeof vscode.workspace.fs.readFile;
    const index = new WorkspaceIndex();
    try {
      const scanPromise = index.allEventCalls();
      const anyIndex = index as unknown as { cache: Map<string, unknown> };
      expect(await waitFor(() => anyIndex.cache.has(bPath)), 'b 应在初扫窗口内先行入索引').toBe(true);
      // 初扫仍在飞(等 a 的读):磁盘真实变更 + watcher 事件。旧实现此时
      // watcher 未挂载 → 事件丢失且无 revision 提升 → 旧内容永久滞留。
      disk.set(bPath, 'self.addEvent(EV_B_NEW, self.on_new)\n');
      watcherRef?.fireChange(uriB);
      releaseA();
      await scanPromise;
      // 排序门:watcher 先于 findFiles 挂载(AUD-074 口径)
      expect(events.indexOf('watcher'), 'watcher 应已挂载').toBeGreaterThanOrEqual(0);
      expect(events.indexOf('watcher'), 'watcher 创建必须先于文件发现').toBeLessThan(events.indexOf('find'));
      // 行为门:窗口内变更被记账,最新内容入索引
      let finalCalls: readonly { call: { event: string } }[] = [];
      const newDeadline = Date.now() + 3000;
      while (Date.now() < newDeadline) {
        finalCalls = await index.allEventCalls();
        if (finalCalls.some(item => item.call.event === 'EV_B_NEW')) { break; }
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      expect(finalCalls.some(item => item.call.event === 'EV_B_NEW'),
        '初扫窗口内的变更应被 watcher 入账(最新内容)').toBe(true);
      expect(finalCalls.some(item => item.call.event === 'EV_B_OLD'),
        '旧内容不得滞留(监听与全扫互不覆盖)').toBe(false);
    } finally {
      index.dispose();
      vscode.workspace.findFiles = originalFind;
      vscode.workspace.fs.readFile = originalRead;
      stubWorkspace.createFileSystemWatcher = originalWatcher;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// KR-AUD-28(IDX-4):onDocumentClosed → invalidate 推进整扫描代 → 每关一个
// .py 下次查询全仓重发现 + 全量重解析。修复口径:关闭的是编辑器文档、文件仍在
// 盘——只按盘重载该文件,不推进扫描代。
// ---------------------------------------------------------------------------
describe('KR-AUD-28 关闭单个文档不触发全仓重发现/重解析', () => {
  it('onDocumentClosed 只按盘重载该文件,扫描代不前进', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kr28-'));
    const files = ['a.py', 'b.py', 'c.py'].map(name => path.join(root, name));
    files.forEach((file, i) => {
      fs.writeFileSync(file, `class Alpha${i}:\n\tdef meth(self):\n\t\tpass\n`);
    });
    const originalFind = vscode.workspace.findFiles;
    vscode.workspace.findFiles = (async (): Promise<Uri[]> =>
      files.map(file => vscode.Uri.file(file))) as unknown as typeof vscode.workspace.findFiles;
    try {
      const index = new PythonClassIndex();
      await index.findClassesByName('Alpha0'); // 首扫收敛
      const anyIndex = index as unknown as {
        ensureDiscovered: (generation: number) => Promise<Uri[]>;
        loadFile: (filePath: string, version: number) => Promise<boolean>;
      };
      const originalDiscover = anyIndex.ensureDiscovered.bind(index);
      const originalLoad = anyIndex.loadFile.bind(index);
      let discovered = 0;
      const loads: string[] = [];
      anyIndex.ensureDiscovered = async generation => {
        discovered += 1;
        return originalDiscover(generation);
      };
      anyIndex.loadFile = async (filePath, version) => {
        loads.push(filePath);
        return originalLoad(filePath, version);
      };
      const doc = vscode.makeTextDocument(
        'class Alpha0:\n\tdef meth(self):\n\t\tpass\n',
        { fileName: files[0], languageId: 'python' }
      );
      index.onDocumentClosed(doc);
      await index.findClassesByName('Alpha0');
      expect(discovered, '关闭单文件不得重跑全仓发现').toBe(0);
      expect(loads.filter(filePath => filePath !== files[0]),
        '关闭单文件不得重读其他文件').toEqual([]);
      expect(loads, '关闭文件本身应按盘重载一次(盘为真相源)').toEqual([files[0]]);
      expect((await index.findClassesByName('Alpha0')).map(cls => cls.filePath))
        .toEqual([files[0]]);
    } finally {
      vscode.workspace.findFiles = originalFind;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// KR-AUD-29(IDX-5):globalDataIndex scanWorker 循环头只复核 revisions 不复核
// generation → 初扫中 removeRoot 后,尚未认领的文件以新一代通过 indexFile 守卫
// (:1718),以空根身份提交复活,违反 AUD-071。修复口径:循环头 generation 复核。
// ---------------------------------------------------------------------------
describe('KR-AUD-29 globalDataIndex 初扫循环头 generation 复核', () => {
  it('初扫中 removeRoot 后,未认领文件不再以空根身份复活', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kr29-'));
    const files = Array.from({ length: 10 }, (_, i) => path.join(root, `f${i}.py`));
    const text = 'import KBEngine\nKBEngine.globalData["cfg"] = {"gold": 1}\n';
    for (const file of files) { fs.writeFileSync(file, text); }
    const originalFind = vscode.workspace.findFiles;
    const originalRead = vscode.workspace.fs.readFile;
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    vscode.workspace.findFiles = (async (): Promise<Uri[]> =>
      files.map(file => vscode.Uri.file(file))) as unknown as typeof vscode.workspace.findFiles;
    vscode.workspace.fs.readFile = (async (uri: { fsPath: string }): Promise<Buffer> => {
      await gate; // 全部读盘挂起:8 个 worker 全部在飞,f8/f9 未被认领
      return fs.readFileSync(uri.fsPath);
    }) as typeof vscode.workspace.fs.readFile;
    const index = new GlobalDataDictIndex();
    try {
      const anyIndex = index as unknown as {
        building: Map<string, Promise<unknown>>;
        cache: Map<string, unknown>;
        byKey: Map<string, unknown>;
      };
      const started = index.ensureStarted();
      expect(await waitFor(() => anyIndex.building.size >= 8),
        '初扫 8 并发 worker 应全部在飞').toBe(true);
      // AUD-071:根撤回 + generation 前进(此刻 cache 为空,撤回无对象,
      // 但在飞初扫不得把未认领文件以空根身份复活)
      index.removeRoot(root);
      release();
      await started;
      expect(anyIndex.cache.size, '已移除根的文件不得复活进缓存').toBe(0);
      expect(anyIndex.byKey.size, '倒排不得出现空根身份的复活写点').toBe(0);
    } finally {
      index.dispose();
      vscode.workspace.findFiles = originalFind;
      vscode.workspace.fs.readFile = originalRead;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
