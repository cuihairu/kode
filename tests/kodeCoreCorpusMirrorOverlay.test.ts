import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { Uri } from './fake-vscode/core';
import { workspace } from './fake-vscode/workspaceState';
import { KodeCoreGate, type ShadowClientLike } from '../src/backend/kodeCoreGate';
import { mirrorCorpusToRust, type CorpusFileFinder } from '../src/kodeCoreCorpusMirror';

// KODE-RESP-007 验收受注:扫描期间打开并编辑文件,晚到的磁盘镜像不得覆盖
// Rust 中较新的编辑器内容。修复=磁盘语料与编辑器 overlay 生命周期分开:
// - gate 侧 mirrorDocument 加 corpus 旗标:后台快照 fill-only(账内已有
//   该文档即跳过,绝不 change/降级 close+open;缺席才补 didOpen 入账,
//   与编辑器流同账本);编辑器流(无旗标)保持原语义——前进 didChange,
//   重开低版本 close+open 兜底,不虚构版本。
// - mirror 侧每个文件发送前重查当前打开状态:此刻在役就发编辑器活体
//   内容(未保存修订不被盘字节冲掉),已关闭才发盘读/快照遗留内容。
// 验收四时序:readFile 延迟中打开、修改、关闭、重开,发送内容始终是
// 最新有效内容,在役版本不被盘快照 v1 降级。

// ---------- gate 侧:真 KodeCoreGate + 记账 stub client ----------

interface ClientCall {
  method: 'open' | 'change' | 'close';
  uri: string;
  version: number;
}

function makeRecordingClient(): ShadowClientLike & { calls: ClientCall[] } {
  const calls: ClientCall[] = [];
  const client = {
    calls,
    start: async () => ({}),
    openDocument: (uri: string, _languageId: string, version: number, _text: string) => {
      calls.push({ method: 'open', uri, version });
    },
    changeDocument: (uri: string, version: number, _text: string) => {
      calls.push({ method: 'change', uri, version });
    },
    closeDocument: (uri: string) => {
      calls.push({ method: 'close', uri, version: 0 });
    },
    dispose: async () => undefined
  };
  return client as ShadowClientLike & typeof client;
}

const GATE_URI = '/ws/entities/Avatar.def';

const makeGate = (): { gate: KodeCoreGate; calls: ClientCall[] } => {
  const client = makeRecordingClient();
  const gate = new KodeCoreGate({ clientFactory: () => client });
  gate.setConfig({ backend: 'shadow', serverPath: 'node:stub', shadowTimeoutMs: 500 });
  return { gate, calls: client.calls };
};

describe('gate 侧:corpus 旗标 = 后台快照 fill-only(RESP-007)', () => {
  it('编辑器流已在场 v5,晚到的盘快照 v1 补位 → 零追加 client 调用(不 change,不降级 close+open)', async () => {
    const { gate, calls } = makeGate();
    await gate.mirrorDocument(GATE_URI, 'kbengine-def', 5, 'editor v5');
    expect(calls).toEqual([{ method: 'open', uri: GATE_URI, version: 5 }]);
    await gate.mirrorDocument(GATE_URI, 'kbengine-def', 1, 'disk v1', { corpus: true });
    // fill-only:账内已有即跳过——修复前这里是 close(v5)+open(v1) 降级。
    expect(calls).toHaveLength(1);
  });

  it('缺席才补位:corpus v1 openDocument 入账;与编辑器流同账本(后续编辑器 v2 正常 didChange)', async () => {
    const { gate, calls } = makeGate();
    await gate.mirrorDocument(GATE_URI, 'kbengine-def', 1, 'disk v1', { corpus: true });
    expect(calls).toEqual([{ method: 'open', uri: GATE_URI, version: 1 }]);
    await gate.mirrorDocument(GATE_URI, 'kbengine-def', 2, 'editor v2');
    expect(calls[1]).toEqual({ method: 'change', uri: GATE_URI, version: 2 });
  });

  it('关闭撤账后 corpus 可重补;补位后同版本重入不重发', async () => {
    const { gate, calls } = makeGate();
    await gate.mirrorDocument(GATE_URI, 'kbengine-def', 2, 'editor v2');
    gate.closeMirroredDocument(GATE_URI);
    expect(calls[1]).toEqual({ method: 'close', uri: GATE_URI, version: 0 });
    await gate.mirrorDocument(GATE_URI, 'kbengine-def', 1, 'disk v1', { corpus: true });
    expect(calls[2]).toEqual({ method: 'open', uri: GATE_URI, version: 1 });
    await gate.mirrorDocument(GATE_URI, 'kbengine-def', 1, 'disk v1', { corpus: true });
    expect(calls).toHaveLength(3);
  });

  it('编辑器流回退语义保留(不带 corpus):低版本仍 close+open 兜底重开,不被本修复收窄', async () => {
    const { gate, calls } = makeGate();
    await gate.mirrorDocument(GATE_URI, 'kbengine-def', 5, 'editor v5');
    await gate.mirrorDocument(GATE_URI, 'kbengine-def', 1, 'editor reopen v1');
    expect(calls.slice(1)).toEqual([
      { method: 'close', uri: GATE_URI, version: 0 },
      { method: 'open', uri: GATE_URI, version: 1 }
    ]);
  });
});

// ---------- mirror 侧:发送前重查打开状态(四时序) ----------

interface MirrorSend {
  uri: string;
  languageId: string;
  version: number;
  text: string;
  corpus: boolean;
}

interface FakeDoc {
  uri: Uri;
  languageId: string;
  version: number;
  getText: () => string;
}

const fakeDoc = (fsPath: string, version: number, text: string): FakeDoc => ({
  uri: Uri.file(fsPath),
  languageId: 'kbengine-def',
  version,
  getText: () => text
});

const noYield = async (): Promise<void> => undefined;

const flush = async (): Promise<void> => {
  await new Promise(resolve => setTimeout(resolve, 0));
  await new Promise(resolve => setTimeout(resolve, 0));
};

const originalReadFile = workspace.fs.readFile;

beforeEach(() => {
  workspace.textDocuments = [];
});

afterEach(() => {
  workspace.fs.readFile = originalReadFile;
  workspace.textDocuments = [];
});

/** 可控 readFile:调用挂起,测试改完打开状态后 release(bytes) 才放行 */
const holdReadFile = (): { release: (bytes: Uint8Array) => void } => {
  let release!: (bytes: Uint8Array) => void;
  workspace.fs.readFile = () =>
    new Promise(resolve => {
      release = resolve;
    });
  return {
    release: bytes => {
      release(bytes);
    }
  };
};

const makeServingGate = (
  sends: MirrorSend[],
  holdUri?: string
): { gate: KodeCoreGate; releaseHeld: () => void } => {
  let releaseHeld!: () => void;
  const gate = {
    serveFromRust: () => true,
    registerRoot: async () => ({ root: 0 }),
    beginBackgroundScan: async () => ({ state: 'warming' }),
    scanComplete: async () => ({ state: 'warm' }),
    scanCancel: async () => ({ state: 'idle' }),
    mirrorDocument: async (
      uri: string,
      languageId: string,
      version: number,
      text: string,
      options?: { corpus?: boolean }
    ) => {
      if (holdUri !== undefined && uri === holdUri) {
        // 模拟生产 mirrorDocument 内的真实异步(client.start() 等待),
        // 给「枚举快照之后、后续文件发送之前」留出打开状态变化的窗口。
        await new Promise<void>(resolve => {
          releaseHeld = resolve;
        });
      }
      sends.push({ uri, languageId, version, text, corpus: options?.corpus === true });
    }
  } as unknown as KodeCoreGate;
  return { gate, releaseHeld: () => releaseHeld() };
};

const finderFor = (files: string[]): CorpusFileFinder => async () => files.map(Uri.file);

describe('mirror 侧:发送前重查打开状态(RESP-007 四时序)', () => {
  it('时序①:readFile 延迟中打开 → 发送编辑器活体内容,不发盘字节', async () => {
    const sends: MirrorSend[] = [];
    const { gate } = makeServingGate(sends);
    const hold = holdReadFile();
    const run = mirrorCorpusToRust(gate, finderFor(['/w/Avatar.def']), () => [], noYield);
    await flush(); // 枚举完,盘读挂起(枚举时未打开)
    workspace.textDocuments = [fakeDoc('/w/Avatar.def', 1, 'editor live v1')];
    hold.release(Buffer.from('disk stale', 'utf8'));
    await run;
    expect(sends).toEqual([
      {
        uri: '/w/Avatar.def',
        languageId: 'kbengine-def',
        version: 1,
        text: 'editor live v1',
        corpus: true
      }
    ]);
  });

  it('时序②:readFile 延迟中打开并编辑到 v2 → 发送 v2 活体内容(盘 v1 绝不降级在役版本)', async () => {
    const sends: MirrorSend[] = [];
    const { gate } = makeServingGate(sends);
    const hold = holdReadFile();
    const run = mirrorCorpusToRust(gate, finderFor(['/w/Avatar.def']), () => [], noYield);
    await flush();
    workspace.textDocuments = [fakeDoc('/w/Avatar.def', 2, 'editor live v2')];
    hold.release(Buffer.from('disk v1', 'utf8'));
    await run;
    expect(sends).toEqual([
      {
        uri: '/w/Avatar.def',
        languageId: 'kbengine-def',
        version: 2,
        text: 'editor live v2',
        corpus: true
      }
    ]);
  });

  it('时序③:枚举时已打开,发送前已关闭 → 发快照遗留内容(编辑器最后已知态),corpus 补位', async () => {
    const sends: MirrorSend[] = [];
    // A 的镜像在途(真实异步点),窗口内 B 被关闭——枚举快照对 B 已过时。
    const { gate, releaseHeld } = makeServingGate(sends, '/w/A.def');
    workspace.textDocuments = [
      fakeDoc('/w/A.def', 1, 'A live'),
      fakeDoc('/w/B.def', 3, 'B captured v3')
    ];
    const run = mirrorCorpusToRust(gate, finderFor(['/w/A.def', '/w/B.def']), () => [], noYield);
    await flush(); // A 的 mirrorDocument 挂起(快照已拍,B 仍「已打开」)
    workspace.textDocuments = [fakeDoc('/w/A.def', 1, 'A live')]; // B 关闭
    releaseHeld();
    await run;
    const b = sends.find(send => send.uri === '/w/B.def');
    expect(b).toEqual({
      uri: '/w/B.def',
      languageId: 'kbengine-def',
      version: 3,
      text: 'B captured v3',
      corpus: true
    });
  });

  it('时序④:readFile 延迟中打开→关闭→重开(新实例) → 发送重开实例活体内容', async () => {
    const sends: MirrorSend[] = [];
    const { gate } = makeServingGate(sends);
    const hold = holdReadFile();
    const run = mirrorCorpusToRust(gate, finderFor(['/w/Avatar.def']), () => [], noYield);
    await flush();
    workspace.textDocuments = [fakeDoc('/w/Avatar.def', 1, 'first open')];
    workspace.textDocuments = [];
    workspace.textDocuments = [fakeDoc('/w/Avatar.def', 1, 'reopened instance')];
    hold.release(Buffer.from('disk v1', 'utf8'));
    await run;
    expect(sends).toEqual([
      {
        uri: '/w/Avatar.def',
        languageId: 'kbengine-def',
        version: 1,
        text: 'reopened instance',
        corpus: true
      }
    ]);
  });

  it('全程未打开:照发盘读字节 v1 + corpus 旗标(既有补位契约不回归)', async () => {
    const sends: MirrorSend[] = [];
    const { gate } = makeServingGate(sends);
    await workspace.fs.writeFile(Uri.file('/w/Closed.def'), Buffer.from('disk bytes', 'utf8'));
    await mirrorCorpusToRust(gate, finderFor(['/w/Closed.def']), () => [], noYield);
    expect(sends).toEqual([
      {
        uri: '/w/Closed.def',
        languageId: 'kbengine-def',
        version: 1,
        text: 'disk bytes',
        corpus: true
      }
    ]);
  });

  it('镜像全程所有发送都带 corpus 旗标(后台快照身份,不混入编辑器流语义)', async () => {
    const sends: MirrorSend[] = [];
    const { gate } = makeServingGate(sends);
    workspace.textDocuments = [fakeDoc('/w/Open.def', 4, 'open live')];
    await workspace.fs.writeFile(Uri.file('/w/Disk.def'), Buffer.from('disk', 'utf8'));
    await mirrorCorpusToRust(
      gate,
      finderFor(['/w/Open.def', '/w/Disk.def']),
      () => [],
      noYield
    );
    expect(sends.every(send => send.corpus)).toBe(true);
    expect(sends.map(send => send.uri)).toEqual(['/w/Open.def', '/w/Disk.def']);
  });
});
