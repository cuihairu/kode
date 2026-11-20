//! KODE-RESP-002 验收:Python 文件发现与交互执行位分离。
//! 修复前:python-file-discovery 以 initial-scan 任务入共享调度器,单并发
//! 执行位被全盘 findFiles 的 await 占据——RequestLocal 已知路径补载在
//! runningId 非空期间恒 queued(异步扫盘让出事件循环,却不让出执行位)。
//! 修复后:发现类内代际单飞不经调度器;已知路径补载不等全盘发现;扫描
//! 换代(取消面)后队列立即恢复,晚到发现不落缓存,新轮按新代重发现。

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { Uri } from './fake-vscode/core';
import { workspace as stubWorkspace } from './fake-vscode/workspaceState';
import { PythonClassIndex } from '../src/backend/pythonClassIndex';
import { IndexScheduler } from '../src/backend/indexScheduler';

const pointWorkspaceAt = (dir: string): void => {
  stubWorkspace.workspaceFolders = [{ uri: Uri.file(dir), name: 'ws', index: 0 }];
};

/** 真盘临时根:补载走 fs 读,文件须真实存在 */
const makeRoot = (files: Record<string, string>): { dir: string; pathOf: (name: string) => string } => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'resp002-'));
  for (const [name, text] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, name), text);
  }
  return { dir, pathOf: (name: string) => path.join(dir, name) };
};

/** RequestLocal 补载必须在预算内完成(挂起发现不得阻塞交互) */
const raceBudget = <T>(work: Promise<T>, ms: number): Promise<T> =>
  Promise.race([
    work,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`RequestLocal 补载被挂起的发现阻塞(>${ms}ms)`)), ms)),
  ]);

describe('KODE-RESP-002 发现与交互执行位分离', () => {
  afterEach(() => {
    stubWorkspace.findFiles = undefined as unknown as typeof stubWorkspace.findFiles;
    stubWorkspace.workspaceFolders = [];
  });

  it('发现挂起期间 RequestLocal 已知路径补载不等全盘发现', async () => {
    const { dir, pathOf } = makeRoot({ 'a.py': 'class A:\n\tdef m(self):\n\t\tpass\n' });
    pointWorkspaceAt(dir);
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    stubWorkspace.findFiles = (async () => {
      await gate; // 全盘发现挂起(慢外部目录/未结束 findFiles 形态)
      return [Uri.file(pathOf('a.py'))];
    }) as typeof stubWorkspace.findFiles;
    const scheduler = new IndexScheduler();
    const index = new PythonClassIndex(scheduler);
    try {
      index.scheduleBackgroundScan(); // 首扫启动:发现进行中
      // 让泵先跑:发现真正进入在途(修复前=已占用执行位)再发交互请求,
      // 否则 RequestLocal 按优先级排在「尚未开跑」的发现前面,测不到阻塞。
      await new Promise(resolve => setTimeout(resolve, 0));
      const enclosing = await raceBudget(index.findEnclosingClass(pathOf('a.py'), 2), 1500);
      expect(enclosing?.name).toBe('A'); // 补载真实入索引(非空回)
      release();
      await index.waitForInitialScan(); // 放行后全量扫描正常收口
    } finally {
      release();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('扫描换代后队列立即恢复,晚到发现不落缓存,新轮重发现', async () => {
    const { dir, pathOf } = makeRoot({ 'b.py': 'class B:\n\tpass\n' });
    pointWorkspaceAt(dir);
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let findCalls = 0;
    stubWorkspace.findFiles = (async () => {
      findCalls += 1;
      await gate;
      return [Uri.file(pathOf('b.py'))]; // 旧代结果:换代后到达=晚到
    }) as typeof stubWorkspace.findFiles;
    const index = new PythonClassIndex(new IndexScheduler());
    try {
      index.scheduleBackgroundScan(); // 旧代发现挂起(修复前=占执行位)
      // 让泵先跑:旧代发现进入在途(findCalls 已计 1 并挂起)再换代
      await new Promise(resolve => setTimeout(resolve, 0));
      expect(findCalls, '旧代发现已在途').toBe(1);
      index.invalidate(); // 全量失效换代(根切换/关停面;清 fileCache)
      // 换代后交互补载立即执行:修复前被仍在跑的旧发现任务挡在队列里
      const enclosing = await raceBudget(index.findEnclosingClass(pathOf('b.py'), 1), 1500);
      expect(enclosing?.name).toBe('B');
      release(); // 旧代发现晚到放行
      await new Promise(resolve => setImmediate(resolve)); // 晚到链微任务落定
      expect(findCalls, '旧代发现只发起过一次').toBe(1);
      await index.waitForInitialScan(); // 新代全扫
      expect(findCalls, '晚到结果未落缓存,新轮按新代重发现').toBe(2);
      const classes = await index.findClassesByName('B');
      expect(classes).toHaveLength(1);
    } finally {
      release();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
