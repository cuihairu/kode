import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { Uri } from './fake-vscode/core';
import { fs as fakeFs, workspace } from './fake-vscode/workspaceState';
import {
  MirrorRunCoordinator,
  mirrorCorpusToRust,
  type CorpusFileFinder
} from '../src/kodeCoreCorpusMirror';
import type { KodeCoreGate } from '../src/backend/kodeCoreGate';

// KODE-RESP-006 验收受注:全量语料镜像的代际单飞。验收口径(todo):
// 挂住旧根 readFile,切根/重启并开始新轮后释放旧读取,旧轮不得再
// mirror/complete;连续配置变化只有最新一轮继续。

interface MirroredCall { uri: string; }
interface WarmCalls { begins: number[]; completions: Array<[number, number]>; cancels: number; }

/** 可挂起的读盘替身:指定路径延迟到 release 才回真值。 */
class HangableReads {
  private readonly original = fakeFs.readFile;
  private readonly gates = new Map<string, () => void>();
  public readOrder: string[] = [];

  install(): void {
    fakeFs.readFile = async (uri: Uri): Promise<Uint8Array> => {
      this.readOrder.push(uri.fsPath);
      const gate = this.gates.get(uri.fsPath);
      if (gate) {
        await new Promise<void>(resolve => {
          this.gates.set(uri.fsPath, resolve);
        });
      }
      return this.original(uri);
    };
  }

  hang(fsPath: string): void {
    this.gates.set(fsPath, () => undefined);
  }

  release(fsPath: string): void {
    this.gates.get(fsPath)?.();
    this.gates.delete(fsPath);
  }

  restore(): void {
    fakeFs.readFile = this.original;
  }
}

function makeGate(serving = true): { gate: KodeCoreGate; calls: MirroredCall[]; warm: WarmCalls } {
  const calls: MirroredCall[] = [];
  const warm: WarmCalls = { begins: [], completions: [], cancels: 0 };
  const gate = {
    serveFromRust: () => serving,
    beginBackgroundScan: async (total: number) => {
      warm.begins.push(total);
      return { state: 'warming' };
    },
    scanComplete: async (done: number, failed: number) => {
      warm.completions.push([done, failed]);
      return { state: 'warm' };
    },
    scanCancel: async () => {
      warm.cancels += 1;
      return { state: 'idle' };
    },
    mirrorDocument: async (uri: string) => {
      calls.push({ uri });
    }
  } as unknown as KodeCoreGate;
  return { gate, calls, warm };
}

const finderOf = (filesByGlob: Record<string, string[]>, tokens: Array<{ isCancellationRequested: boolean } | undefined>): CorpusFileFinder =>
  async (glob: string, token) => {
    tokens.push(token);
    return (filesByGlob[glob] ?? []).map(Uri.file);
  };

let tempRoot: string;
let reads: HangableReads;

beforeEach(() => {
  tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-mirror-gen-'));
  workspace.textDocuments = [];
  reads = new HangableReads();
  reads.install();
});

afterEach(() => {
  reads.restore();
});

describe('kodeCoreCorpusMirror 代际单飞(KODE-RESP-006)', () => {
  it('协调器:begin 取消旧令牌,isCurrent 翻假;cancel 掐当前轮', () => {
    const coordinator = new MirrorRunCoordinator();
    const runA = coordinator.begin();
    expect(runA.isCurrent()).toBe(true);
    const runB = coordinator.begin();
    expect(runA.isCurrent()).toBe(false);
    expect(runA.token.isCancellationRequested).toBe(true);
    expect(runB.isCurrent()).toBe(true);
    coordinator.cancel();
    expect(runB.isCurrent()).toBe(false);
    expect(runB.token.isCancellationRequested).toBe(true);
  });

  it('旧轮挂在 readFile 上,新轮开始后释放:旧轮不再 mirror/complete', async () => {
    const oldDef = path.join(tempRoot, 'old', 'Avatar.def');
    const oldSecond = path.join(tempRoot, 'old', 'Monster.def');
    await fakeFs.writeFile(Uri.file(oldDef), Buffer.from('<root/>', 'utf8'));
    await fakeFs.writeFile(Uri.file(oldSecond), Buffer.from('<root/>', 'utf8'));
    const { gate: gateA, calls: callsA, warm: warmA } = makeGate();
    const tokensA: Array<{ isCancellationRequested: boolean } | undefined> = [];
    reads.hang(oldDef);

    const roundA = mirrorCorpusToRust(
      gateA,
      finderOf({ '**/*.def': [oldDef, oldSecond] }, tokensA)
    );
    // 让 roundA 走到挂起的 readFile。
    await new Promise(resolve => setTimeout(resolve, 0));
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(reads.readOrder).toEqual([oldDef]);

    // 新轮开始(换根/重启形态):旧轮令牌即刻取消。
    const { gate: gateB, calls: callsB, warm: warmB } = makeGate();
    await mirrorCorpusToRust(
      gateB,
      finderOf({ '**/*.def': [path.join(tempRoot, 'new', 'Avatar.def')] }, [])
    );

    // 释放旧读取:旧轮苏醒后必须静默停。
    reads.release(oldDef);
    await roundA;

    expect(tokensA[0]?.isCancellationRequested).toBe(true);
    expect(callsA).toEqual([]);
    expect(warmA.begins).toEqual([2]);
    expect(warmA.completions).toEqual([]);
    expect(warmA.cancels).toBe(0);
    // 新轮自身照常收尾。
    expect(callsB).toEqual([]);
    expect(warmB.completions).toEqual([[0, 1]]);
  });

  it('连续触发三轮:只有最新一轮继续并 complete,中间轮静默停', async () => {
    const f1 = path.join(tempRoot, 'r1', 'A.def');
    const f2 = path.join(tempRoot, 'r2', 'B.def');
    const f3 = path.join(tempRoot, 'r3', 'C.def');
    await fakeFs.writeFile(Uri.file(f2), Buffer.from('<root/>', 'utf8'));
    await fakeFs.writeFile(Uri.file(f3), Buffer.from('<root/>', 'utf8'));
    const { gate, calls, warm } = makeGate();

    // 轮1:挂在 f1 的读盘上。
    reads.hang(f1);
    const round1 = mirrorCorpusToRust(gate, finderOf({ '**/*.def': [f1] }, []));
    await new Promise(resolve => setTimeout(resolve, 0));
    await new Promise(resolve => setTimeout(resolve, 0));

    // 轮2:挂 f2 读盘。
    reads.hang(f2);
    const round2 = mirrorCorpusToRust(gate, finderOf({ '**/*.def': [f2] }, []));
    await new Promise(resolve => setTimeout(resolve, 0));
    await new Promise(resolve => setTimeout(resolve, 0));

    // 轮3:不挂,径直完成。
    await mirrorCorpusToRust(gate, finderOf({ '**/*.def': [f3] }, []));

    reads.release(f1);
    reads.release(f2);
    await round1;
    await round2;

    // 只有轮3的文件被镜像;完成回执恰一张(轮3),中间轮零 cancel。
    expect(calls.map(call => call.uri)).toEqual([f3]);
    expect(warm.completions).toEqual([[1, 0]]);
    expect(warm.cancels).toBe(0);
  });
});
