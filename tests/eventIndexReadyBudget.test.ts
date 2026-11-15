/**
 * RUST-004-W3(2026-11-15 审核拆项)验收钉:事件索引冷启动等待接预算与取消,
 * 消费端(CodeLens)接线就绪/取消语义。
 *
 * 验收口径(todo.md RUST-004-W3):不能只新增 allEventCallsMarked 而不改
 * 调用者;在途首扫被屏障阻塞时可中途取消;未就绪有显式状态;完成后能刷新。
 *
 * 四面:
 *  - 竞速三态(allEventCallsMarked):快扫描 ready / 挂死初扫预算耗尽
 *    pending(后台预热仍在飞)/ 取消 cancelled / 无 token 离线等全量;
 *  - partial-real:初扫挂死期间 noteSaved 已蓄的真实调用照流(ready:false),
 *    不再强制空族(强制空=丢事件驱动面已蓄真实内容,W1 审计同款);
 *  - 完成后刷新:onReady 就绪通知 → provider onDidChangeCodeLenses 重渲染;
 *  - 消费端:pending 面出部分真实监听镜 / 取消退本地镜 / 初扫失败退本地镜 /
 *    就绪面全量 / 弃置广播。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as vscode from 'vscode';
import { EventCodeLensProvider } from '../src/eventApi';
import { WorkspaceIndex } from '../src/workspaceIndex';
import { makeTextDocument } from './fake-vscode/core';

const WARM_TEXT = "self.addEvent('EV_A', self.on_a)\n";
const SCAN_TEXT = "self.addEvent('EV_A', self.on_watch)\n";

const tick = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

/** 桩 token:只有旗标面(无取消订阅)→ 竞速退化预算形态 */
const stubToken = { isCancellationRequested: false } as never;

/** 真取消 token:delayMs 后置位(经订阅面) */
const cancelSoonToken = (delayMs = 10): never =>
  ({
    isCancellationRequested: false,
    onCancellationRequested: (cb: () => void) => {
      setTimeout(cb, delayMs);
      return { dispose: () => undefined };
    }
  }) as never;

const lensTitle = (lens: vscode.CodeLens): string => (lens.command as { title: string }).title;

describe('RUST-004-W3 事件索引竞速(allEventCallsMarked 三态+partial-real)', () => {
  let originalFind: typeof vscode.workspace.findFiles | undefined;
  let originalRead: typeof vscode.workspace.fs.readFile | undefined;
  let releaseScan: (() => void) | null = null;
  let uri: vscode.Uri;
  let warmDoc: vscode.TextDocument;

  const hangScan = (): void => {
    vscode.workspace.findFiles = () =>
      new Promise<vscode.Uri[]>(resolve => {
        releaseScan = () => resolve([uri]);
      });
  };

  const setupReadyScan = (): void => {
    vscode.workspace.findFiles = async () => [uri];
  };

  beforeEach(() => {
    originalFind = vscode.workspace.findFiles;
    originalRead = vscode.workspace.fs.readFile;
    uri = vscode.Uri.file('/ws/scan.py');
    warmDoc = makeTextDocument(WARM_TEXT, { fileName: '/ws/warm.py', languageId: 'python' }) as unknown as vscode.TextDocument;
    vscode.workspace.fs.readFile = async file =>
      file.fsPath === '/ws/scan.py' ? Buffer.from(SCAN_TEXT) : Buffer.from(WARM_TEXT);
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
    await tick(60);
  });

  it('初扫在预算内完成 → ready:true + 全量(快路径与旧硬等同果)', async () => {
    setupReadyScan();
    const index = new WorkspaceIndex();
    try {
      const marked = await index.allEventCallsMarked(stubToken);
      expect(marked).not.toBeNull();
      expect(marked!.ready).toBe(true);
      expect(marked!.calls.map(call => call.call.event)).toEqual(['EV_A']);
    } finally {
      index.dispose();
    }
  });

  it('初扫挂死 → 预算耗尽 pending;noteSaved 已蓄真实调用照流(强制空族在此红)', async () => {
    hangScan();
    const index = new WorkspaceIndex();
    try {
      index.noteSaved(warmDoc);
      const t0 = Date.now();
      const marked = await index.allEventCallsMarked(stubToken);
      expect(marked, '预算耗尽出 pending 面,不返回 null').not.toBeNull();
      expect(marked!.ready, '初扫仍在飞必须如实标 ready:false').toBe(false);
      expect(marked!.calls.map(call => call.call.event), '部分真实内容照流(partial-real)').toEqual(['EV_A']);
      expect(Date.now() - t0).toBeLessThan(2000);
      expect(index.isReady).toBe(false);
    } finally {
      index.dispose();
    }
  });

  it('pending 后释放扫描 → onReady 就绪通知触发,下一次调用 ready 快路径', async () => {
    hangScan();
    const index = new WorkspaceIndex();
    try {
      index.noteSaved(warmDoc);
      expect((await index.allEventCallsMarked(stubToken))!.ready).toBe(false);
      let readyFired = 0;
      index.onReady(() => {
        readyFired += 1;
      });
      releaseScan?.();
      releaseScan = null;
      for (let i = 0; i < 100 && !index.isReady; i += 1) {
        await tick(20);
      }
      expect(index.isReady).toBe(true);
      expect(readyFired, '初扫完成必须广播就绪').toBeGreaterThanOrEqual(1);
      const marked = await index.allEventCallsMarked(stubToken);
      expect(marked!.ready).toBe(true);
      // 预热(warm.py 已蓄)+ 扫描(scan.py)两文件贡献都入查询
      expect(marked!.calls).toHaveLength(2);
    } finally {
      index.dispose();
    }
  });

  it('等待期间取消 → null(在途首扫被屏障阻塞时可中途取消)', async () => {
    hangScan();
    const index = new WorkspaceIndex();
    try {
      index.noteSaved(warmDoc);
      const marked = await index.allEventCallsMarked(cancelSoonToken(), 5000);
      expect(marked, '取消先到必须出 cancelled=null,不装 pending 面').toBeNull();
    } finally {
      index.dispose();
    }
  });

  it('无 token → 无视预算等全量(离线程序化语义不变)', async () => {
    hangScan();
    const index = new WorkspaceIndex();
    try {
      // env 预算 40ms,扫描 ~120ms 后才放行:竞速预算会 pending,离线语义等全量出 ready
      setTimeout(() => releaseScan?.(), 120);
      const marked = await index.allEventCallsMarked();
      expect(marked!.ready).toBe(true);
      expect(index.isReady).toBe(true);
    } finally {
      index.dispose();
    }
  });

  it('桩 token(无取消订阅面)+ 挂死初扫 → 退化预算竞速出 pending', async () => {
    hangScan();
    const index = new WorkspaceIndex();
    try {
      const marked = await index.allEventCallsMarked({ isCancellationRequested: false } as never);
      expect(marked!.ready).toBe(false);
    } finally {
      index.dispose();
    }
  });

  it('入口已取消 token → null 早退(既有 provider 顶早退口径)', async () => {
    const index = new WorkspaceIndex();
    try {
      const marked = await index.allEventCallsMarked({ isCancellationRequested: true } as never);
      expect(marked).toBeNull();
    } finally {
      index.dispose();
    }
  });
});

describe('RUST-004-W3 消费端(CodeLens pending/取消/失败/刷新)', () => {
  let originalFind: typeof vscode.workspace.findFiles | undefined;
  let originalRead: typeof vscode.workspace.fs.readFile | undefined;
  let releaseScan: (() => void) | null = null;
  let uri: vscode.Uri;
  let warmDoc: vscode.TextDocument;
  let emitDoc: vscode.TextDocument;

  const hangScan = (): void => {
    vscode.workspace.findFiles = () =>
      new Promise<vscode.Uri[]>(resolve => {
        releaseScan = () => resolve([uri]);
      });
  };

  const setupReadyScan = (): void => {
    vscode.workspace.findFiles = async () => [uri];
  };

  beforeEach(() => {
    originalFind = vscode.workspace.findFiles;
    originalRead = vscode.workspace.fs.readFile;
    uri = vscode.Uri.file('/ws/scan.py');
    warmDoc = makeTextDocument(WARM_TEXT, { fileName: '/ws/warm.py', languageId: 'python' }) as unknown as vscode.TextDocument;
    // 发射文档:本地回调镜(def on_a 被回调)+监听镜(emitEvent)双面
    emitDoc = makeTextDocument(
      [
        'class E:',
        '    def on_a(self):',
        '        pass',
        '',
        '    def setup(self):',
        '        self.registerEvent("EV_A", self.on_a)',
        '        self.emitEvent("EV_A")',
        ''
      ].join('\n'),
      { fileName: '/ws/emit.py', languageId: 'python' }
    ) as unknown as vscode.TextDocument;
    vscode.workspace.fs.readFile = async file =>
      file.fsPath === '/ws/scan.py' ? Buffer.from(SCAN_TEXT) : Buffer.from(WARM_TEXT);
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
    await tick(60);
  });

  it('pending 面:部分真实监听镜照流 + 本地回调镜保留(partial-real 不装完整)', async () => {
    hangScan();
    const index = new WorkspaceIndex();
    const provider = new EventCodeLensProvider(index);
    try {
      index.noteSaved(warmDoc);
      const lenses = await provider.provideCodeLenses(emitDoc, stubToken);
      const local = lenses.filter(lens => lensTitle(lens).includes('事件回调'));
      const listener = lenses.filter(lens => lensTitle(lens).includes('处监听'));
      expect(local, '本地回调镜不依赖索引,冷启动照出').toHaveLength(1);
      expect(listener, '已蓄真实监听照流(partial-real,强制空在此红)').toHaveLength(1);
      expect(listener[0] && lensTitle(listener[0])).toContain('1 处监听');
    } finally {
      provider.dispose();
      index.dispose();
    }
  });

  it('取消 → 监听镜缺席,本地回调镜保留(退本地面)', async () => {
    hangScan();
    const index = new WorkspaceIndex();
    const provider = new EventCodeLensProvider(index);
    try {
      index.noteSaved(warmDoc);
      const lenses = await provider.provideCodeLenses(emitDoc, { isCancellationRequested: true } as never);
      expect(lenses.filter(lens => lensTitle(lens).includes('事件回调'))).toHaveLength(1);
      expect(lenses.filter(lens => lensTitle(lens).includes('处监听')), '取消面不出监听镜').toHaveLength(0);
    } finally {
      provider.dispose();
      index.dispose();
    }
  });

  it('初扫失败 → 退本地镜不抛(provider 不因冷索引失败整体缺席)', async () => {
    vscode.workspace.findFiles = async () => {
      throw new Error('discovery failed');
    };
    const index = new WorkspaceIndex();
    const provider = new EventCodeLensProvider(index);
    try {
      const lenses = await provider.provideCodeLenses(emitDoc, stubToken);
      expect(lenses.filter(lens => lensTitle(lens).includes('事件回调'))).toHaveLength(1);
      expect(lenses.filter(lens => lensTitle(lens).includes('处监听'))).toHaveLength(0);
    } finally {
      provider.dispose();
      index.dispose();
    }
  });

  it('就绪面:扫描索引贡献监听镜(全量,ready 路径)', async () => {
    setupReadyScan();
    const index = new WorkspaceIndex();
    const provider = new EventCodeLensProvider(index);
    try {
      const lenses = await provider.provideCodeLenses(emitDoc, stubToken);
      const listener = lenses.filter(lens => lensTitle(lens).includes('处监听'));
      expect(listener, '扫描到的监听进镜').toHaveLength(1);
      expect(lensTitle(listener[0])).toContain('1 处监听');
    } finally {
      provider.dispose();
      index.dispose();
    }
  });

  it('pending → 就绪:onReady 广播触发 provider 重渲染信号,重查出全量', async () => {
    hangScan();
    const index = new WorkspaceIndex();
    const provider = new EventCodeLensProvider(index);
    try {
      index.noteSaved(warmDoc);
      const pendingLenses = await provider.provideCodeLenses(emitDoc, stubToken);
      expect(lensTitle(pendingLenses.filter(lens => lensTitle(lens).includes('处监听'))[0])).toContain('1 处监听');
      let fired = 0;
      provider.onDidChangeCodeLenses(() => {
        fired += 1;
      });
      releaseScan?.();
      releaseScan = null;
      for (let i = 0; i < 100 && !index.isReady; i += 1) {
        await tick(20);
      }
      expect(fired, '完成后能刷新:onReady→重渲染信号').toBeGreaterThanOrEqual(1);
      const fullLenses = await provider.provideCodeLenses(emitDoc, stubToken);
      const listener = fullLenses.filter(lens => lensTitle(lens).includes('处监听'));
      expect(listener).toHaveLength(1);
      expect(lensTitle(listener[0])).toContain('2 处监听');
    } finally {
      provider.dispose();
      index.dispose();
    }
  });

  it('索引弃置 → 就绪广播仍触发(provider 收通知重渲染,重查得空面)', async () => {
    setupReadyScan();
    const index = new WorkspaceIndex();
    const provider = new EventCodeLensProvider(index);
    try {
      let fired = 0;
      provider.onDidChangeCodeLenses(() => {
        fired += 1;
      });
      index.dispose();
      expect(fired, '弃置也广播(消费端不遗留陈旧镜)').toBe(1);
    } finally {
      provider.dispose();
    }
  });
});
