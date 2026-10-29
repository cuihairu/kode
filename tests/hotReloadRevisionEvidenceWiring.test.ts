import { readFileSync } from 'fs';
import * as path from 'path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import { setupHotReload, type HotReloadTimerDeps } from '../src/hotReload';
import { runHotReloadRetryCommand } from '../src/hotReloadRetryCommand';
import {
  HotReloadEngineDigestRegister,
  parseEngineDigestReceipt
} from '../src/hotReloadRevisionEvidence';
import {
  collectRevisionEvidences,
  localFileHash,
  runHotReloadRevisionEvidenceCommand,
  semanticHashOf
} from '../src/hotReloadRevisionEvidenceCommand';
import { HotReloadTargetStateStore, type HotReloadTargetKey } from '../src/hotReloadTargetState';
import { channels, configurationOverrides, lastFileSystemWatcher } from './helpers/vscodeStub';

// IDE-REV-027 revision 证据接线(原 IDE-HOT-008):从真实发送结果出发,逐
// (目标,文件) 展示三类证据并各自点名来源——fileHash(本地 sha256 重算)/
// semanticHash(.def 结构指纹,注释空白不影响)/engineDigest(运行时回执
// 报告,证据册按回显归属)。跨类不比较不互相冒充;缺的种类如实缺席。

const DEF_A = `<root>
  <Properties>
    <hp>
      <Type>INT32</Type>
      <Flags>CELL_PRIVATE</Flags>
    </hp>
  </Properties>
</root>
`;
const DEF_A_COMMENTED = `<!-- 只是注释 -->\n${DEF_A}`;
const DEF_A_STRUCTURAL = DEF_A.replace('<Type>INT32</Type>', '<Type>FLOAT</Type>');
const PY_A = '/ws/scripts/base/Avatar.py';
const DEF_F = '/ws/scripts/Avatar.def';
const KEY: HotReloadTargetKey = { rootId: '/ws', targetId: 'cellapp#a' };
const DIGEST = 'a'.repeat(64);

describe('证据原语(IDE-REV-027)', () => {
  it('localFileHash:同内容同值,内容变即变(sha256 hex)', () => {
    expect(localFileHash('print(1)')).toBe(localFileHash('print(1)'));
    expect(localFileHash('print(1)')).toMatch(/^[0-9a-f]{64}$/);
    expect(localFileHash('print(2)')).not.toBe(localFileHash('print(1)'));
  });

  it('semanticHash:def 注释/空白不变值,结构变化变值;.py 与解析不了的 def=null', () => {
    expect(semanticHashOf(DEF_F, DEF_A)).toBe(semanticHashOf(DEF_F, DEF_A));
    expect(semanticHashOf(DEF_F, DEF_A)).toMatch(/^[0-9a-f]{64}$/);
    // 只加注释:结构指纹不变 → 语义哈希不变
    expect(semanticHashOf(DEF_F, DEF_A_COMMENTED)).toBe(semanticHashOf(DEF_F, DEF_A));
    // 属性 Type 变化:结构面变 → 语义哈希变
    expect(semanticHashOf(DEF_F, DEF_A_STRUCTURAL)).not.toBe(semanticHashOf(DEF_F, DEF_A));
    // Python 无结构语义指纹原语:如实 null,不造一个
    expect(semanticHashOf(PY_A, 'print(1)')).toBeNull();
    expect(semanticHashOf(DEF_F, 'not-xml <<<')).toBeNull();
  });

  it('parseEngineDigestReceipt:非空 digest+file 回显才认;缺一即 null', () => {
    expect(parseEngineDigestReceipt(JSON.stringify({ status: 'applied', file: PY_A, digest: DIGEST }))).toEqual({
      digest: DIGEST,
      file: PY_A
    });
    expect(parseEngineDigestReceipt(JSON.stringify({ status: 'ok' }))).toBeNull();
    expect(parseEngineDigestReceipt(JSON.stringify({ digest: DIGEST }))).toBeNull();
    expect(parseEngineDigestReceipt(JSON.stringify({ digest: '', file: PY_A }))).toBeNull();
    expect(parseEngineDigestReceipt('not json')).toBeNull();
    expect(parseEngineDigestReceipt(undefined)).toBeNull();
  });
});

describe('HotReloadEngineDigestRegister(证据册)', () => {
  it('回显归属:逐字回显该文件才入册;回显别人/无 digest 不入册', () => {
    const register = new HotReloadEngineDigestRegister({ now: () => 1234 });
    register.note(KEY, PY_A, JSON.stringify({ status: 'applied', file: PY_A, digest: DIGEST }));
    expect(register.receipt(KEY, PY_A)).toEqual({ digest: DIGEST, at: 1234 });

    const other: HotReloadTargetKey = { rootId: '/ws', targetId: 'cellapp#b' };
    register.note(other, PY_A, JSON.stringify({ status: 'applied', file: '/ws/other.py', digest: DIGEST }));
    expect(register.receipt(other, PY_A)).toBeNull();
    register.note(other, PY_A, JSON.stringify({ status: 'ok' }));
    expect(register.receipt(other, PY_A)).toBeNull();
  });
});

describe('collectRevisionEvidences(逐文件证据装配)', () => {
  it('def 全三类各自带来源标签;跨类值巧合相同也不判一致(只列不比)', () => {
    const evidences = collectRevisionEvidences(DEF_F, DEF_A, localFileHash(DEF_A), 1000);
    expect(Object.keys(evidences).sort()).toEqual(['engineDigest', 'fileHash', 'semanticHash']);
    expect(evidences.fileHash?.origin).toContain('本地');
    expect(evidences.semanticHash?.origin).toContain('结构指纹');
    expect(evidences.engineDigest?.origin).toContain('回执');
    // 值巧合相同(本地哈希=运行时报告值)也只是两条各自来源的证据,无「一致」面
    expect(evidences.fileHash?.value).not.toBe(evidences.semanticHash?.value);
  });

  it('缺的种类如实缺席:.py 无 semanticHash;内容读不到无 fileHash/semanticHash', () => {
    const pyEvidences = collectRevisionEvidences(PY_A, 'print(1)', null, null);
    expect(pyEvidences.semanticHash).toBeUndefined();
    expect(pyEvidences.fileHash).toBeDefined();

    const unreadable = collectRevisionEvidences(PY_A, null, DIGEST, 1000);
    expect(unreadable.fileHash).toBeUndefined();
    expect(unreadable.semanticHash).toBeUndefined();
    expect(unreadable.engineDigest).toBeDefined();
  });
});

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

describe('setupHotReload 回执喂证据册(IDE-REV-027 接线)', () => {
  beforeEach(() => {
    configurationOverrides.clear();
    lastFileSystemWatcher.current = null;
    channels.length = 0;
  });

  it('真实 HTTP 回包带 digest+回显:fire 路径把回包体喂进证据册', async () => {
    const clock = makeTimers();
    const store = new HotReloadTargetStateStore({ now: () => 1 });
    const register = new HotReloadEngineDigestRegister({ now: () => 2000 });
    configurationOverrides.set('kbengine', {
      hotReload: { enabled: true, actionName: '热更', debounceMs: 100, globs: ['**/*.py'] }
    });
    setupHotReload(
      { subscriptions: [] } as unknown as vscode.ExtensionContext,
      (_name, sendOptions) => {
        sendOptions?.onHttpResponse?.({
          status: 200,
          body: JSON.stringify({ status: 'applied', file: PY_A, digest: DIGEST })
        });
        return true;
      },
      {
        timers: clock.timers,
        targetState: {
          store,
          resolveTargetId: () => 'cellapp#a',
          resolveRootId: () => '/ws'
        },
        noteEngineDigest: (key, file, body) => register.note(key, file, body)
      }
    );

    lastFileSystemWatcher.current!.fireChange({ fsPath: PY_A } as never);
    clock.tick();
    await flush();

    expect(register.receipt(KEY, PY_A)).toEqual({ digest: DIGEST, at: 2000 });
  });

  it('重发路径同样喂证据册(失败目标重试的回包体不缺席证据面)', async () => {
    const store = new HotReloadTargetStateStore({ now: () => 1 });
    store.record(KEY, PY_A, 'failed', { detail: 'boom' });
    const register = new HotReloadEngineDigestRegister({ now: () => 3000 });
    const blocks: string[] = [];

    await runHotReloadRetryCommand(
      store,
      {
        runAction: vi.fn(async (_name, sendOptions) => {
          sendOptions?.onHttpResponse?.({
            status: 200,
            body: JSON.stringify({ status: 'applied', file: PY_A, digest: DIGEST })
          });
          return true;
        }),
        resolveActionNameForTarget: () => '热更',
        targetState: {
          store,
          resolveTargetId: () => 'cellapp#a',
          resolveRootId: () => '/ws'
        },
        noteEngineDigest: (key, file, body) => register.note(key, file, body),
        timers: makeTimers().timers,
        settleHandles: new Set<unknown>(),
        isCancelled: () => false
      },
      { logBlock: text => void blocks.push(text), show: () => undefined }
    );
    await flush();

    expect(register.receipt(KEY, PY_A)).toEqual({ digest: DIGEST, at: 3000 });
  });
});

describe('runHotReloadRevisionEvidenceCommand(展示入口)', () => {
  it('逐目标逐文件渲染三类证据,来源标签各自点名;.py 无 semanticHash 行', async () => {
    const store = new HotReloadTargetStateStore({ now: () => 1000 });
    store.record(KEY, PY_A, 'sent-unverified', {});
    store.record(KEY, DEF_F, 'applied', { detail: 'digest 一致' });
    const register = new HotReloadEngineDigestRegister({ now: () => 5000 });
    register.note(KEY, DEF_F, JSON.stringify({ status: 'applied', file: DEF_F, digest: DIGEST }));
    const blocks: string[] = [];
    let shown = 0;
    const contents = new Map([
      [PY_A, 'print(1)'],
      [DEF_F, DEF_A]
    ]);

    await runHotReloadRevisionEvidenceCommand(
      store,
      {
        readFileContent: async file => contents.get(file) ?? null,
        digests: register
      },
      {
        logBlock: text => {
          blocks.push(text);
        },
        show: () => {
          shown += 1;
        }
      }
    );

    const text = blocks[0];
    expect(text).toContain(`${PY_A} → sent-unverified`);
    expect(text).toContain(`${DEF_F} → applied`);
    expect(text).toContain('fileHash(本地文件内容哈希重算)');
    expect(text).toContain('semanticHash(结构语义指纹)');
    expect(text).toContain('engineDigest(运行时回执报告)');
    expect(text).toContain(DIGEST.slice(0, 12));
    // 标签不混叫:fileHash 行不含「运行时」,engineDigest 行不含「本地」
    const fileHashLine = text.split('\n').find(line => line.includes('fileHash('));
    const engineLine = text.split('\n').find(line => line.includes('engineDigest('));
    expect(fileHashLine).toBeDefined();
    expect(fileHashLine).not.toContain('运行时');
    expect(engineLine).not.toContain('本地');
    expect(shown).toBe(1);
  });

  it('内容读不到:fileHash/semanticHash 如实缺席,engineDigest 仍在;空台账如实无投递记录', async () => {
    const store = new HotReloadTargetStateStore({ now: () => 1000 });
    store.record(KEY, PY_A, 'failed', { detail: 'boom' });
    const register = new HotReloadEngineDigestRegister({ now: () => 5000 });
    register.note(KEY, PY_A, JSON.stringify({ status: 'applied', file: PY_A, digest: DIGEST }));
    const blocks: string[] = [];

    await runHotReloadRevisionEvidenceCommand(
      store,
      { readFileContent: async () => null, digests: register },
      { logBlock: text => void blocks.push(text), show: () => undefined }
    );
    expect(blocks[0]).toContain('engineDigest(运行时回执报告)');
    expect(blocks[0]).not.toContain('fileHash(');
    expect(blocks[0]).not.toContain('semanticHash(');

    blocks.length = 0;
    await runHotReloadRevisionEvidenceCommand(
      new HotReloadTargetStateStore({ now: () => 1000 }),
      { readFileContent: async () => 'x', digests: register },
      { logBlock: text => void blocks.push(text), show: () => undefined }
    );
    expect(blocks[0]).toContain('无投递记录');
  });
});

describe('源锁(IDE-REV-027 接线)', () => {
  it('extension.ts 注册命令并双路喂证据册;package.json 在册', () => {
    const extension = readFileSync(path.join(__dirname, '..', 'src', 'extension.ts'), 'utf8');
    expect(extension).toContain("'kbengine.hotReload.showRevisionEvidence'");
    expect(extension).toContain('runHotReloadRevisionEvidenceCommand');
    expect(extension).toContain('new HotReloadEngineDigestRegister');
    // fire 路径与重发路径都接 noteEngineDigest
    expect(extension.split('hotReloadEngineDigestRegister.note(key, file, body)').length).toBe(3);

    const pkg = JSON.parse(readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8')) as {
      contributes: { commands: Array<{ command: string }> };
      activationEvents: string[];
    };
    expect(pkg.contributes.commands.some(entry => entry.command === 'kbengine.hotReload.showRevisionEvidence')).toBe(true);
    expect(pkg.activationEvents).toContain('onCommand:kbengine.hotReload.showRevisionEvidence');
  });
});
