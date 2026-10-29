import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  flushPendingDocumentReturnAnnotationsForTests,
  getInflightDocumentUpdateCount,
  getPendingDocumentUpdateCount,
  queueDocumentReturnAnnotations,
  resetPythonReturnAnnotationCache,
  setDocumentExtractionGateForTests
} from '../src/pythonReturnTypeInference';

// IDE-REV-028(原 IDE-MET-008):文档注解更新的待处理量必须覆盖 pending
// (去抖排队)与 inflight(异步提取执行中)两面——门住异步提取时仍显示在
// 途;同文件重叠版本各归各,旧任务的 finally 不删除同文件新任务的在途记
// 录,分别结束后才归零。

interface GateControl {
  release(): void;
  released: boolean;
}

const installGate = (): { controls: GateControl[]; uninstall(): void } => {
  const controls: GateControl[] = [];
  setDocumentExtractionGateForTests(
    () =>
      new Promise<void>(resolve => {
        controls.push({
          release: (): void => {
            resolve();
          },
          released: false
        });
      })
  );
  return {
    controls,
    uninstall: (): void => {
      setDocumentExtractionGateForTests(null);
      for (const control of controls) {
        if (!control.released) {
          control.released = true;
          control.release();
        }
      }
    }
  };
};

const tick = async (): Promise<void> => {
  // 让 setTimeout(0) 的去抖定时器落地,提取进入在途(gate 同步起抱)
  await new Promise(resolve => setTimeout(resolve, 0));
  await new Promise(resolve => setTimeout(resolve, 0));
};

describe('文档注解更新待处理量(IDE-REV-028)', () => {
  beforeEach(() => {
    resetPythonReturnAnnotationCache();
  });
  afterEach(() => {
    setDocumentExtractionGateForTests(null);
  });

  it('去抖排队中即计入(pending 面):两文件各排一笔=2,计时器未落地也在账', () => {
    queueDocumentReturnAnnotations('/ws', { fileKey: 'file:///a.py', version: 1, source: () => 'def f(): pass' });
    queueDocumentReturnAnnotations('/ws', { fileKey: 'file:///b.py', version: 1, source: () => 'def g(): pass' });
    expect(getPendingDocumentUpdateCount()).toBe(2);
    expect(getInflightDocumentUpdateCount()).toBe(0);
  });

  it('门住异步提取时仍显示在途(inflight 面):计时器落地后 pending 清零、inflight 计 1,放行后归零', async () => {
    const gate = installGate();
    queueDocumentReturnAnnotations('/ws', { fileKey: 'file:///a.py', version: 1, source: () => 'def f(): pass' });

    await tick();
    // 提取被门住:去抖队列已清,但执行中面照实显示在途
    expect(gate.controls).toHaveLength(1);
    expect(getPendingDocumentUpdateCount()).toBe(1);
    expect(getInflightDocumentUpdateCount()).toBe(1);

    gate.controls[0]!.released = true;
    gate.controls[0]!.release();
    await flushPendingDocumentReturnAnnotationsForTests();
    expect(getPendingDocumentUpdateCount()).toBe(0);
    expect(getInflightDocumentUpdateCount()).toBe(0);
    gate.uninstall();
  });

  it('同文件重叠版本:旧任务 finally 不删新任务在途记录,分别结束后才归零', async () => {
    const gate = installGate();
    // 第一版进入在途(被门住)
    queueDocumentReturnAnnotations('/ws', { fileKey: 'file:///a.py', version: 1, source: () => 'def f(): pass' });
    await tick();
    expect(gate.controls).toHaveLength(1);

    // 第一版仍在途时第二版排队并落地:同文件在途记录被新版接管(按文件计 1)
    queueDocumentReturnAnnotations('/ws', { fileKey: 'file:///a.py', version: 2, source: () => 'def f(): pass # v2' });
    await tick();
    expect(gate.controls).toHaveLength(2);
    expect(getPendingDocumentUpdateCount()).toBe(1);
    expect(getInflightDocumentUpdateCount()).toBe(1);

    // 旧任务(v1)先结束:它的 finally 不得删掉 v2 的在途记录
    gate.controls[0]!.released = true;
    gate.controls[0]!.release();
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(getInflightDocumentUpdateCount()).toBe(1);
    expect(getPendingDocumentUpdateCount()).toBe(1);

    // 新任务(v2)结束:该文件在途归零
    gate.controls[1]!.released = true;
    gate.controls[1]!.release();
    await flushPendingDocumentReturnAnnotationsForTests();
    expect(getInflightDocumentUpdateCount()).toBe(0);
    expect(getPendingDocumentUpdateCount()).toBe(0);
    gate.uninstall();
  });

  it('多文件并发在途:按文件计数,各文件分别结束后总账归零', async () => {
    const gate = installGate();
    queueDocumentReturnAnnotations('/ws', { fileKey: 'file:///a.py', version: 1, source: () => 'def f(): pass' });
    queueDocumentReturnAnnotations('/ws', { fileKey: 'file:///b.py', version: 1, source: () => 'def g(): pass' });
    await tick();
    expect(gate.controls).toHaveLength(2);
    expect(getPendingDocumentUpdateCount()).toBe(2);
    expect(getInflightDocumentUpdateCount()).toBe(2);

    gate.controls[0]!.released = true;
    gate.controls[0]!.release();
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(getPendingDocumentUpdateCount()).toBe(1);

    gate.controls[1]!.released = true;
    gate.controls[1]!.release();
    await flushPendingDocumentReturnAnnotationsForTests();
    expect(getPendingDocumentUpdateCount()).toBe(0);
    gate.uninstall();
  });

  it('源锁:量规覆盖 pending+inflight,finally 带同文件新任务守卫', async () => {
    const source = await import('fs').then(fs => fs.promises.readFile('src/pythonReturnTypeInference.ts', 'utf8'));
    expect(source).toContain('pendingDocumentUpdates.size + inflightDocumentUpdates.size');
    expect(source).toContain('inflightDocumentUpdates.get(fileKey) === extraction');
    // 旧写法(无条件按键删)不得回流
    expect(source).not.toContain("extraction.finally(() => { inflightDocumentUpdates.delete(fileKey); })");
  });
});
