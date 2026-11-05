import { createHash } from 'crypto';
import { readFileSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as vscode from 'vscode';
import { setupHotReload, type HotReloadTimerDeps } from '../src/hotReload';
import { HotReloadTargetStateStore } from '../src/hotReloadTargetState';
import { startReferenceReceiver } from './helpers/referenceReceiver';
import { configurationOverrides, lastFileSystemWatcher, workspace as stubWorkspace } from './helpers/vscodeStub';

// IDE-REV-023 applied 证据核验接线:真实 HTTP 响应的回包体经
// verifyAppliedReceipt 双证核验——回执逐字段符合协议且 digest 与所发内容
// sha256 一致才升格 applied;digest 缺失/不符、回执不合规(含运行时根本
// 没有 applied 协议)一律保持未确认并把阻塞原因注解进记录;核验窗口到点
// 仍未确认只注解超时,不冒充失败也不冒充 applied;无响应面(脚本动作)
// 不进核验流程。

const makeTimers = (): { timers: HotReloadTimerDeps; tick: () => number } => {
  const handles = new Map<unknown, () => void>();
  return {
    tick: () => {
      const callbacks = [...handles.values()];
      handles.clear();
      for (const callback of callbacks) {
        callback();
      }
      return callbacks.length;
    },
    timers: {
      set: (callback): unknown => {
        const handle = handles.size;
        handles.set(handle, callback);
        return handle;
      },
      clear: (handle): void => {
        handles.delete(handle);
      }
    }
  };
};

const flush = async (): Promise<void> => {
  await new Promise(resolve => setTimeout(resolve, 0));
  await new Promise(resolve => setTimeout(resolve, 0));
};

const CONTENT = 'class Avatar:\n    def tick(self):\n        pass\n';
const FILE = '/ws/scripts/base/Avatar.py';
const KEY = { rootId: '/ws', targetId: 't1' };

describe('setupHotReload applied 核验接线(IDE-REV-023)', () => {
  beforeEach(() => {
    configurationOverrides.clear();
    lastFileSystemWatcher.current = null;
  });

  afterEach(() => {
    stubWorkspace.workspaceFolders = [];
  });

  const makeContext = (): vscode.ExtensionContext =>
    ({ subscriptions: [] }) as unknown as vscode.ExtensionContext;

  const enableHotReload = (): void => {
    configurationOverrides.set('kbengine', {
      hotReload: { enabled: true, actionName: '热更', debounceMs: 100 }
    });
  };

  const fireOne = (): void => {
    lastFileSystemWatcher.current!.fireChange({ fsPath: FILE } as never);
  };

  // 走完一次发送:fire → 去抖 tick → 微任务结算(响应+核验链),返回发送用时钟
  const sendOnce = (
    options: {
      body: string;
      content?: string | null;
      withReader?: boolean;
      status?: number;
    }
  ): { store: HotReloadTargetStateStore; clock: ReturnType<typeof makeTimers>; advanceSettle: () => void } => {
    const clock = makeTimers();
    const store = new HotReloadTargetStateStore({ now: () => 5 });
    let fakeNow = 1000;
    const withReader = options.withReader ?? true;
    enableHotReload();
    setupHotReload(
      makeContext(),
      (_name, sendOptions) => {
        sendOptions?.onHttpResponse?.({ status: options.status ?? 200, body: options.body });
        return true;
      },
      {
        timers: clock.timers,
        now: () => fakeNow,
        targetState: {
          store,
          resolveTargetId: () => 't1',
          resolveRootId: () => '/ws',
          ...(withReader
            ? {
                readFileContent: async () =>
                  options.content === undefined ? CONTENT : options.content
              }
            : {})
        }
      }
    );
    fireOne();
    clock.tick();
    return {
      store,
      clock,
      advanceSettle: () => {
        fakeNow = 1000 + 10_001;
      }
    };
  };

  const appliedBody = (digest: string): string =>
    JSON.stringify({ status: 'applied', file: FILE, digest });

  it('回执 applied 且 digest 与所发内容一致:双证齐 → 升格 applied', async () => {
    const digest = createHash('sha256').update(Buffer.from(CONTENT, 'utf8')).digest('hex');
    const run = sendOnce({ body: appliedBody(digest) });
    await flush();

    const record = run.store.get(KEY, FILE);
    expect(record?.outcome).toBe('applied');
    expect(record?.detail).toContain('digest 一致');
  });

  it('回执 digest 与所发内容不符:可疑回执不升格,注解阻塞原因', async () => {
    const otherDigest = createHash('sha256').update(Buffer.from('other', 'utf8')).digest('hex');
    const run = sendOnce({ body: appliedBody(otherDigest) });
    await flush();

    const record = run.store.get(KEY, FILE);
    expect(record?.outcome).toBe('sent-unverified');
    expect(record?.detail).toContain('digest 与所发内容不符');
  });

  it('运行时无 applied 协议(回执自称其他状态):保持未确认,注解缺协议阻塞条件', async () => {
    const run = sendOnce({ body: JSON.stringify({ status: 'ok' }) });
    await flush();

    const record = run.store.get(KEY, FILE);
    expect(record?.outcome).toBe('sent-unverified');
    expect(record?.detail).toContain('applied 核验阻塞');
    expect(record?.detail).toContain('非 applied');
  });

  it('无内容读取通道:digest 无基准,不核验只注解阻塞', async () => {
    const digest = createHash('sha256').update(Buffer.from(CONTENT, 'utf8')).digest('hex');
    const run = sendOnce({ body: appliedBody(digest), withReader: false });
    await flush();

    const record = run.store.get(KEY, FILE);
    expect(record?.outcome).toBe('sent-unverified');
    expect(record?.detail).toContain('无内容读取通道');
  });

  it('所发内容读不到:null 基准,不升格只注解阻塞', async () => {
    const digest = createHash('sha256').update(Buffer.from(CONTENT, 'utf8')).digest('hex');
    const run = sendOnce({ body: appliedBody(digest), content: null });
    await flush();

    const record = run.store.get(KEY, FILE);
    expect(record?.outcome).toBe('sent-unverified');
    expect(record?.detail).toContain('发送时点内容基准不可读');
  });

  it('核验窗口到点仍未确认:只注解超时,不冒充失败也不冒充 applied', async () => {
    const run = sendOnce({ body: 'ok' });
    await flush();
    run.advanceSettle();
    run.clock.tick();
    await flush();

    const record = run.store.get(KEY, FILE);
    expect(record?.outcome).toBe('sent-unverified');
    expect(record?.detail).toContain('applied 核验超时');
    expect(record?.outcome === 'applied' || record?.outcome === 'failed').toBe(false);
  });

  it('已升格 accepted 的记录:核验结算不碰(不追加超时,不改状态)', async () => {
    const run = sendOnce({ body: JSON.stringify({ status: 'accepted', file: FILE }) });
    await flush();
    expect(run.store.get(KEY, FILE)?.outcome).toBe('accepted');
    run.advanceSettle();
    run.clock.tick();
    await flush();

    const record = run.store.get(KEY, FILE);
    expect(record?.outcome).toBe('accepted');
    expect(record?.detail).not.toContain('核验超时');
    expect(record?.detail).not.toContain('核验阻塞');
  });

  it('无响应面(脚本动作):不进核验流程,无注解无结算', async () => {
    const clock = makeTimers();
    const store = new HotReloadTargetStateStore({ now: () => 5 });
    enableHotReload();
    setupHotReload(makeContext(), () => Promise.resolve(true), {
      timers: clock.timers,
      now: () => 999_999,
      targetState: {
        store,
        resolveTargetId: () => 't1',
        resolveRootId: () => '/ws',
        readFileContent: async () => CONTENT
      }
    });
    fireOne();
    clock.tick();
    await flush();
    clock.tick();
    await flush();

    const record = store.get(KEY, FILE);
    expect(record?.outcome).toBe('sent-unverified');
    expect(record?.detail ?? '').not.toContain('applied');
  });

  it('IDE-AUD-005(F08):连续发送,第二次失败后第一次的 applied 核验不改新记录', async () => {
    const clock = makeTimers();
    const store = new HotReloadTargetStateStore({ now: () => 5 });
    const pendingReads: Array<(value: string | null) => void> = [];
    const digest = createHash('sha256').update(Buffer.from(CONTENT, 'utf8')).digest('hex');
    const fakeNow = 1000;
    let sendCount = 0;
    enableHotReload();
    setupHotReload(
      makeContext(),
      (_name, sendOptions) => {
        sendCount += 1;
        // 第一次:200 + 有效 applied 回执(digest 与所发一致)——核验挂起;
        // 第二次:500(失败)——新代接管该记录
        if (sendCount === 1) {
          sendOptions?.onHttpResponse?.({ status: 200, body: appliedBody(digest) });
        } else {
          sendOptions?.onHttpResponse?.({ status: 500, body: '' });
        }
        return true;
      },
      {
        timers: clock.timers,
        now: () => fakeNow,
        targetState: {
          store,
          resolveTargetId: () => 't1',
          resolveRootId: () => '/ws',
          // 内容读取挂起=第一次的核验在途(测试控制释放时点)
          readFileContent: () =>
            new Promise(resolve => {
              pendingReads.push(resolve);
            })
        }
      }
    );
    // 第一次发送:响应已到(记录 sent-unverified),内容读取挂起=核验在途
    fireOne();
    clock.tick();
    await flush();
    expect(store.get(KEY, FILE)?.outcome).toBe('sent-unverified');
    expect(pendingReads).toHaveLength(1);
    // 第二次发送:HTTP 500 → failed(新代)
    fireOne();
    clock.tick();
    await flush();
    expect(store.get(KEY, FILE)?.outcome).toBe('failed');
    // 释放第一次的核验(内容可读):旧代回执不得翻新代的失败
    pendingReads[0]?.(CONTENT);
    await flush();
    const record = store.get(KEY, FILE);
    expect(record?.outcome).toBe('failed');
    expect(record?.detail ?? '').not.toContain('digest 一致');
  });

  it('IDE-AUD-006:核验基准在发送时点冻结——响应后文件已变也不拿新版本冒充所发', async () => {
    const clock = makeTimers();
    const store = new HotReloadTargetStateStore({ now: () => 5 });
    const changed = `${CONTENT}\n# 发送后被编辑\n`;
    const digest = createHash('sha256').update(Buffer.from(CONTENT, 'utf8')).digest('hex');
    let responseSent = false;
    enableHotReload();
    setupHotReload(
      makeContext(),
      (_name, sendOptions) => {
        responseSent = true;
        sendOptions?.onHttpResponse?.({ status: 200, body: appliedBody(digest) });
        return true;
      },
      {
        timers: clock.timers,
        now: () => 1000,
        targetState: {
          store,
          resolveTargetId: () => 't1',
          resolveRootId: () => '/ws',
          // 发送时点读到的是所发内容;响应后文件已变(读到的是新版本)
          readFileContent: async () => (responseSent ? changed : CONTENT)
        }
      }
    );
    fireOne();
    clock.tick();
    await flush();

    const record = store.get(KEY, FILE);
    expect(record?.outcome).toBe('applied');
    expect(record?.detail).toContain('digest 一致');
  });

  it('源锁:extension.ts 接内容读取口,hotReload 接双证核验与窗口结算', () => {
    const read = (name: string): string => readFileSync(path.join(__dirname, '..', 'src', name), 'utf8');
    const extension = read('extension.ts');
    expect(extension).toContain('readFileContent: async file =>');
    expect(extension).toContain('vscode.workspace.fs.readFile(vscode.Uri.file(file))');

    const hotReload = read('hotReload.ts');
    expect(hotReload).toContain('verifyAppliedReceipt(');
    expect(hotReload).toContain('settleAppliedStatus(');
    expect(hotReload).toContain('HOT_RELOAD_APPLIED_SETTLE_MS');
  });

  // IDE-REV-023 重新核验(2026-11-05,AUD-007 证据落地后):applied 回包体
  // 不再是模拟 JSON——参考接收端真实监听回环端口,对收到的文件重算 sha256
  // 回真实 digest;火线以发送时点冻结基准双证核验。
  const realHttpPost = async (port: number, body: string): Promise<{ status: number; body: string }> =>
    new Promise((resolve, reject) => {
      const request = http.request(
        {
          host: '127.0.0.1',
          port,
          path: '/reload',
          method: 'POST',
          headers: { 'content-type': 'application/json' }
        },
        response => {
          let raw = '';
          response.on('data', (chunk: Buffer) => {
            raw += chunk.toString('utf8');
          });
          response.on('end', () => resolve({ status: response.statusCode ?? 0, body: raw }));
        }
      );
      request.on('error', reject);
      request.write(body);
      request.end();
    });

  const wireRealReceiver = async (
    receiver: { port: number },
    store: HotReloadTargetStateStore,
    clock: ReturnType<typeof makeTimers>,
    realFile: string
  ): Promise<void> => {
    enableHotReload();
    setupHotReload(
      makeContext(),
      async (_name, sendOptions) => {
        const response = await realHttpPost(receiver.port, JSON.stringify({ files: [realFile] }));
        sendOptions?.onHttpResponse?.(response);
        return true;
      },
      {
        timers: clock.timers,
        targetState: {
          store,
          resolveTargetId: () => 't1',
          resolveRootId: () => '/ws',
          readFileContent: async () => readFileSync(realFile, 'utf8')
        }
      }
    );
    lastFileSystemWatcher.current!.fireChange({ fsPath: realFile } as never);
    clock.tick();
  };

  const waitFor = async (predicate: () => boolean): Promise<void> => {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline && !predicate()) {
      await new Promise(resolve => setTimeout(resolve, 10));
    }
  };

  it('真实接收端 applied 回包(digest=接收端重算):火线双证核验升格 applied', async () => {
    // F3:接收端只在真实应用命令执行成功后才回 applied(不再读取+复制就
    // 自称已应用),故这里给一条真实可执行的应用命令。
    // F3 二轮:命令真实写文件进引擎目录(不再 process.exit(0) 空操作假应用),
    // 测试对引擎侧产物断言应用真实发生
    const engineDir = mkdtempSync(path.join(os.tmpdir(), 'kode-rev023-engine-'));
    const realApply = `node -e "const fs=require('fs'),p=require('path');const d='${engineDir}';fs.mkdirSync(d,{recursive:true});fs.copyFileSync(process.env.KODE_RELOAD_FILE,p.join(d,p.basename(process.env.KODE_RELOAD_FILE)))"`;
    const receiver = await startReferenceReceiver('apply', 'applied', realApply);
    try {
      const realFile = path.join(mkdtempSync(path.join(os.tmpdir(), 'kode-rev023-')), 'Avatar.py');
      writeFileSync(realFile, CONTENT, 'utf8');
      const store = new HotReloadTargetStateStore({ now: () => 5 });
      await wireRealReceiver(receiver, store, makeTimers(), realFile);
      await flush();
      await waitFor(() => store.get(KEY, realFile)?.outcome === 'applied');

      const record = store.get(KEY, realFile);
      expect(record?.outcome).toBe('applied');
      expect(record?.detail).toContain('digest 一致');
      // 接收端重算的 digest 与所发内容一致(真实 wire 双证)
      expect(record?.sentDigest).toBe(createHash('sha256').update(Buffer.from(CONTENT, 'utf8')).digest('hex'));
      // 真实应用证据:引擎目录写入的产物与所发内容逐字一致(不是空操作假应用)
      expect(readFileSync(path.join(engineDir, 'Avatar.py'), 'utf8')).toBe(CONTENT);
      rmSync(path.dirname(realFile), { recursive: true, force: true });
    } finally {
      receiver.dispose();
      rmSync(engineDir, { recursive: true, force: true });
    }
  });

  it('真实接收端 digest 不符回包(真 wire):保持未确认并注解阻塞', async () => {
    const engineDir = mkdtempSync(path.join(os.tmpdir(), 'kode-rev023-engine-'));
    const realApply = `node -e "const fs=require('fs'),p=require('path');const d='${engineDir}';fs.mkdirSync(d,{recursive:true});fs.copyFileSync(process.env.KODE_RELOAD_FILE,p.join(d,p.basename(process.env.KODE_RELOAD_FILE)))"`;
    const receiver = await startReferenceReceiver('apply', 'digest-mismatch', realApply);
    try {
      const realFile = path.join(mkdtempSync(path.join(os.tmpdir(), 'kode-rev023-')), 'Avatar.py');
      writeFileSync(realFile, CONTENT, 'utf8');
      const store = new HotReloadTargetStateStore({ now: () => 5 });
      await wireRealReceiver(receiver, store, makeTimers(), realFile);
      await flush();
      await waitFor(() => (store.get(KEY, realFile)?.detail ?? '').includes('digest 与所发内容不符'));

      const record = store.get(KEY, realFile);
      expect(record?.outcome).toBe('sent-unverified');
      expect(record?.detail).toContain('applied 核验阻塞');
      rmSync(path.dirname(realFile), { recursive: true, force: true });
    } finally {
      receiver.dispose();
      rmSync(engineDir, { recursive: true, force: true });
    }
  });
});
