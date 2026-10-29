import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  getAnnotationBuildWorkload,
  getPendingDocumentUpdateCount,
  resetPythonReturnAnnotationCache,
  resolveLocalVariableReturnType,
  setDocumentExtractionGateForTests
} from '../src/pythonReturnTypeInference';

// IDE-REV-029(原 IDE-MET-008):注解索引重建在途量接入诊断报告——冷构建
// 与 TTL 过期重建被门住时可见(running/waiting),全体等待者取消的归属面
// (cancelled)如实显示,发布/取消收尾后归零;共享构建与请求独占任务(逐
// 文档更新,REV-028 面)分开计量不混账:共享构建只认全体取消,单个请求
// 取消不拖死构建。

const setupWorkspace = (): { root: string; put: (name: string, text: string) => void } => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'anno-build-wl-'));
  fs.mkdirSync(path.join(root, 'scripts'), { recursive: true });
  return {
    root,
    put: (name: string, text: string): void => {
      fs.writeFileSync(path.join(root, 'scripts', name), text);
    }
  };
};

/** 门住重建扫描(第 2 次 readdir,与既有 IDE-REV-006 用例同法):返回释放句柄 */
const gateRebuildScan = (): (() => void) => {
  const realReaddir = fs.promises.readdir.bind(fs.promises);
  let release!: () => void;
  const gate = new Promise<void>(resolve => {
    release = resolve;
  });
  let scans = 0;
  const spy = vi.spyOn(fs.promises, 'readdir').mockImplementation(
    (async (...args: unknown[]) => {
      scans += 1;
      if (scans === 2) {
        await gate;
      }
      return await realReaddir(...(args as Parameters<typeof fs.promises.readdir>));
    }) as unknown as typeof fs.promises.readdir
  );
  return () => {
    release();
    spy.mockRestore();
  };
};

const LINES = ['data = get_data()'];

describe('注解索引共享构建在途量(IDE-REV-029)', () => {
  let root: string;
  beforeEach(() => {
    resetPythonReturnAnnotationCache();
    root = setupWorkspace().root;
    fs.writeFileSync(path.join(root, 'scripts', 'svc.py'), 'def get_data() -> VAL:\n    pass\n');
  });
  afterEach(() => {
    setDocumentExtractionGateForTests(null);
    vi.restoreAllMocks();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('冷构建被门住时可见:running=1,两请求搭车 waiting=2;发布后归零', async () => {
    const release = gateRebuildScan();
    const first = resolveLocalVariableReturnType(LINES, 0, 'data', root);
    const second = resolveLocalVariableReturnType(LINES, 0, 'data', root);
    await new Promise(resolve => setTimeout(resolve, 0));

    const gated = getAnnotationBuildWorkload();
    expect(gated.running).toBe(1);
    expect(gated.waiting).toBe(2);
    expect(gated.cancelled).toBe(0);

    release();
    expect(await first).toMatchObject({ annotation: 'VAL' });
    expect(await second).toMatchObject({ annotation: 'VAL' });
    const settled = getAnnotationBuildWorkload();
    expect(settled.running).toBe(0);
    expect(settled.waiting).toBe(0);
    expect(settled.cancelled).toBe(0);
  });

  it('TTL 过期重建被门住同样可见:预热→越过 TTL→门住重建→在途→发布后归零', async () => {
    expect(await resolveLocalVariableReturnType(LINES, 0, 'data', root)).toMatchObject({ annotation: 'VAL' });
    const advanced = Date.now() + 4000; // 越过 INDEX_TTL_MS(3s)
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(advanced);
    try {
      const release = gateRebuildScan();
      const pending = resolveLocalVariableReturnType(LINES, 0, 'data', root);
      await new Promise(resolve => setTimeout(resolve, 0));
      expect(getAnnotationBuildWorkload()).toMatchObject({ running: 1, waiting: 1, cancelled: 0 });
      release();
      expect(await pending).toMatchObject({ annotation: 'VAL' });
      expect(getAnnotationBuildWorkload()).toMatchObject({ running: 0, waiting: 0, cancelled: 0 });
    } finally {
      nowSpy.mockRestore();
    }
  });

  it('取消归属:全体等待者取消→cancelled=1 收尾中可见;单个取消不拖死共享构建', async () => {
    // 两等待者:一个已取消、一个未取消——共享令牌仍活(不全员取消)
    const release1 = gateRebuildScan();
    const cancelledToken = { isCancellationRequested: true };
    const liveToken = { isCancellationRequested: false };
    const dead = resolveLocalVariableReturnType(LINES, 0, 'data', root, cancelledToken);
    const live = resolveLocalVariableReturnType(LINES, 0, 'data', root, liveToken);
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(getAnnotationBuildWorkload()).toMatchObject({ running: 1, waiting: 2, cancelled: 0 });
    release1();
    expect(await dead).toBeNull();
    expect(await live).toMatchObject({ annotation: 'VAL' });
    expect(getAnnotationBuildWorkload().running).toBe(0);

    // 全体等待者都已取消:共享构建如实标 cancelled、收尾后归零。可观测窗
    // 口=构建在途时等待者全体翻取消(开跑前就全取消的构建在首个 token 检
    // 查即短路,不产生在途窗口);越过 TTL 才再起构建(场景一刚发布的缓
    // 存在 3s 窗口内是新鲜的)。
    const advanced = Date.now() + 4000;
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(advanced);
    try {
      const release2 = gateRebuildScan();
      const token = { isCancellationRequested: false };
      const pending = resolveLocalVariableReturnType(LINES, 0, 'data', root, token);
      await new Promise(resolve => setTimeout(resolve, 0));
      expect(getAnnotationBuildWorkload()).toMatchObject({ running: 1, waiting: 1, cancelled: 0 });
      // 唯一等待者翻取消 → 全体取消,构建进入收尾(仍在途可见)
      token.isCancellationRequested = true;
      expect(getAnnotationBuildWorkload()).toMatchObject({ running: 1, waiting: 1, cancelled: 1 });
      release2();
      expect(await pending).toBeNull();
      expect(getAnnotationBuildWorkload()).toMatchObject({ running: 0, waiting: 0, cancelled: 0 });
    } finally {
      nowSpy.mockRestore();
    }
  });

  it('不与请求独占任务混账:文档更新在途时共享构建量照实为 0(区分计量)', async () => {
    const controls: Array<() => void> = [];
    setDocumentExtractionGateForTests(
      () =>
        new Promise<void>(resolve => {
          controls.push(resolve);
        })
    );
    // 请求独占的逐文件文档更新在途(排队即计入 REV-028 面)
    const { queueDocumentReturnAnnotations } = await import('../src/pythonReturnTypeInference');
    queueDocumentReturnAnnotations(root, { fileKey: 'file:///a.py', version: 1, source: () => 'def f(): pass' });
    expect(getPendingDocumentUpdateCount()).toBe(1);
    // 共享构建量规不把独占任务混进来
    expect(getAnnotationBuildWorkload()).toMatchObject({ running: 0, waiting: 0, cancelled: 0 });
    for (const resolve0 of controls) {
      resolve0();
    }
  });

  it('源锁:诊断报告两处接入 annotationBuilds 量规,渲染面带运行/等待/已全取消', async () => {
    const extension = await import('fs').then(fs => fs.promises.readFile('src/extension.ts', 'utf8'));
    expect(extension.split('annotationBuilds: getAnnotationBuildWorkload()').length).toBe(3);
    const summary = await import('fs').then(fs => fs.promises.readFile('src/reproductionSummary.ts', 'utf8'));
    expect(summary).toContain('注解索引构建=运行');
    expect(summary).toContain('/等待');
    expect(summary).toContain('/已全取消');
  });
});
