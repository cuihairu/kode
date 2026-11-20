import { expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { WorkspaceIndex } from '../src/workspaceIndex';
import { setScanStageProgressClockForTests } from '../src/backend/scanStageProgress';

// WARM-VISIBILITY-004 刀 A:共享事件索引首扫的逐文件节流进度。
// ensureStarted(onProgress) 注入回调 → 冷扫/缓存恢复两条路径的扫描环
// 经 createScanProgressReporter 节流上报「事件/方法索引 N/M」。
// 时钟钉死:断言确定性(真实时钟下快机 500ms 闸拦尽/慢机放行分叉)。

const makeBody = (): Buffer => Buffer.from([
  'import KBEngine',
  'class Hero(KBEngine.Entity):',
  '    def onDie(self):',
  '        pass'
].join('\n'));

it('冷首扫逐文件进度:计数边界 10 报一档,终报 N/N 收口', async () => {
  const originalFind = vscode.workspace.findFiles;
  const originalRead = vscode.workspace.fs.readFile;
  const files = Array.from({ length: 25 }, (_, i) => vscode.Uri.file(`/ws/prog${i}.py`));
  const body = makeBody();
  vscode.workspace.findFiles = async () => files;
  vscode.workspace.fs.readFile = async () => body;
  setScanStageProgressClockForTests(() => 1000);
  const index = new WorkspaceIndex();
  const details: string[] = [];
  try {
    await index.ensureStarted(detail => { details.push(detail); });
  } finally {
    index.dispose();
    setScanStageProgressClockForTests(null);
    vscode.workspace.findFiles = originalFind;
    vscode.workspace.fs.readFile = originalRead;
  }
  // 钉死时钟:首报 10/25(时间闸首报放行),20/25 被时间闸拦,终报 25/25
  expect(details).toEqual(['事件/方法索引 10/25', '事件/方法索引 25/25']);
});

it('未注入回调:首扫照常完成,零异常(默认路径无状态栏)', async () => {
  const originalFind = vscode.workspace.findFiles;
  const originalRead = vscode.workspace.fs.readFile;
  const files = Array.from({ length: 12 }, (_, i) => vscode.Uri.file(`/ws/bare${i}.py`));
  const body = makeBody();
  vscode.workspace.findFiles = async () => files;
  vscode.workspace.fs.readFile = async () => body;
  setScanStageProgressClockForTests(() => 1000);
  const index = new WorkspaceIndex();
  try {
    await index.ensureStarted();
    const calls = await index.allEventCalls();
    expect(calls).toHaveLength(0);
  } finally {
    index.dispose();
    setScanStageProgressClockForTests(null);
    vscode.workspace.findFiles = originalFind;
    vscode.workspace.fs.readFile = originalRead;
  }
});

it('缓存恢复路径:重建文件逐档上报,命中文件不计步', async () => {
  const originalFind = vscode.workspace.findFiles;
  const originalRead = vscode.workspace.fs.readFile;
  // 快照/恢复的失效判据走 node fs stat:文件必须真实落盘
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-ws-restore-'));
  const body = makeBody();
  const files = Array.from({ length: 30 }, (_, i) => {
    const file = path.join(root, `rest${i}.py`);
    fs.writeFileSync(file, body);
    return vscode.Uri.file(file);
  });
  vscode.workspace.findFiles = async () => files;
  vscode.workspace.fs.readFile = async uri => fs.promises.readFile(uri.fsPath ? (uri as { fsPath: string }).fsPath : String(uri));
  setScanStageProgressClockForTests(() => 1000);
  try {
    // 盘上 30 文件,快照只带前 20 条:命中 20 直取,后 10 个按「盘上多出」重建
    const snapshot = await (async () => {
      const probe = new WorkspaceIndex();
      try {
        await probe.ensureStarted();
        return await probe.captureEventIndexSnapshot();
      } finally {
        probe.dispose();
      }
    })();
    expect(snapshot).toHaveLength(30);
    const partial = snapshot.slice(0, 20);
    const index = new WorkspaceIndex();
    const details: string[] = [];
    const outcome = await index.restoreFromCache(partial, detail => { details.push(detail); });
    index.dispose();
    expect(outcome.tookOver).toBe(true);
    expect(outcome.restored).toBe(20);
    expect(outcome.rebuilt).toBe(10);
    // 重建 10 个:首报计数边界 10(时间闸首报放行)+ 终报 10/10
    expect(details).toEqual(['事件/方法索引 10/10', '事件/方法索引 10/10']);
  } finally {
    setScanStageProgressClockForTests(null);
    vscode.workspace.findFiles = originalFind;
    vscode.workspace.fs.readFile = originalRead;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
