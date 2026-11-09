import { createHash } from 'crypto';
import { readFileSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as vscode from 'vscode';
import { setupHotReload, type HotReloadTimerDeps } from '../src/hotReload';
import { HotReloadTargetStateStore } from '../src/backend/hotReloadTargetState';
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
      hotReload: { enabled: true, globs: ['**/*.py'], actionName: '热更', debounceMs: 100 }
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

  it('源锁:装配层接内容读取口,hotReload 接双证核验与窗口结算', () => {
    const read = (name: string): string => readFileSync(path.join(__dirname, '..', 'src', name), 'utf8');
    // SRC-001 L6:接线位自 extension.ts 迁 src/activate/hotReload.ts(纯移动),源锁跟随装配层。
    const extension = read('extension.ts') + read('activate/hotReload.ts');
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
    realFile: string,
    sentDigest?: string
  ): Promise<void> => {
    enableHotReload();
    setupHotReload(
      makeContext(),
      async (_name, sendOptions) => {
        // F3 三轮:发送方冻结 digest 随报文下发(sender_digests)
        const body: Record<string, unknown> = { files: [realFile] };
        if (sentDigest !== undefined) {
          body.sender_digests = { [realFile]: sentDigest };
        }
        const response = await realHttpPost(receiver.port, JSON.stringify(body));
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

  it('真实接收端 applied 回包(接收端自己写产物,digest=接收端重算):火线双证核验升格 applied', async () => {
    // F3 四轮:applied 路径=接收端自己写产物——按报文 files 读到内容后由接收
    // 端自身代码直接落盘引擎目录(--artifact-dir),写后重算 sha256 与报文
    // sender_digests 比对一致才回 applied;外部应用命令模式已降级 accepted,
    // 故这里不配 --apply-command,只配引擎产物目录。
    const engineDir = mkdtempSync(path.join(os.tmpdir(), 'kode-rev023-engine-'));
    const receiver = await startReferenceReceiver('apply', 'applied', undefined, engineDir);
    try {
      // F3 七轮:产物命名空间只认接收端暂存根内路径(根外整批拒绝)——所发
      // 真实文件放进接收端暂存根;产物落位=根内相对路径映射(此处即 basename),
      // 不再回落「绝对路径全结构展开」。
      const realFile = path.join(receiver.root, 'Avatar.py');
      writeFileSync(realFile, CONTENT, 'utf8');
      const store = new HotReloadTargetStateStore({ now: () => 5 });
      const sentDigest = createHash('sha256').update(Buffer.from(CONTENT, 'utf8')).digest('hex');
      await wireRealReceiver(receiver, store, makeTimers(), realFile, sentDigest);
      await flush();
      await waitFor(() => store.get(KEY, realFile)?.outcome === 'applied');

      const record = store.get(KEY, realFile);
      expect(record?.outcome).toBe('applied');
      expect(record?.detail).toContain('digest 一致');
      // 接收端重算的 digest 与所发内容一致(真实 wire 双证)
      expect(record?.sentDigest).toBe(createHash('sha256').update(Buffer.from(CONTENT, 'utf8')).digest('hex'));
      // 真实应用证据:引擎目录写入的产物与所发内容逐字一致(不是空操作假应用)。
      // F3 七轮:realFile 在接收端暂存根内,产物落位=根内相对路径(basename)。
      const artifactPath = path.join(engineDir, 'Avatar.py');
      expect(readFileSync(artifactPath, 'utf8')).toBe(CONTENT);
    } finally {
      receiver.dispose();
      rmSync(engineDir, { recursive: true, force: true });
    }
  });

  it('真实接收端 digest 不符回包(真 wire):保持未确认并注解阻塞', async () => {
    const engineDir = mkdtempSync(path.join(os.tmpdir(), 'kode-rev023-engine-'));
    // F3 四轮:接收端自己写产物模式(digest-mismatch 场景=回包 digest 故意报错)
    const receiver = await startReferenceReceiver('apply', 'digest-mismatch', undefined, engineDir);
    try {
      // F3 七轮:产物命名空间只认接收端暂存根内路径(根外整批拒绝)——所发
      // 真实文件放进接收端暂存根;产物落位=根内相对路径映射(此处即 basename),
      // 不再回落「绝对路径全结构展开」。
      const realFile = path.join(receiver.root, 'Avatar.py');
      writeFileSync(realFile, CONTENT, 'utf8');
      const store = new HotReloadTargetStateStore({ now: () => 5 });
      const sentDigest = createHash('sha256').update(Buffer.from(CONTENT, 'utf8')).digest('hex');
      await wireRealReceiver(receiver, store, makeTimers(), realFile, sentDigest);
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
