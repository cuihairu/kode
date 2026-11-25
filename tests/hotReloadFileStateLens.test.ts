import { describe, expect, it } from 'vitest';
import * as vscode from 'vscode';
import { makeTextDocument, type MinimalTextDocument } from './helpers/vscodeStub';
import { HotReloadTargetStateStore, type HotReloadTargetKey } from '../src/backend/hotReloadTargetState';
import {
  HotReloadFileStateMachine,
  sha256Hex,
  type HotReloadFileStateView
} from '../src/backend/hotReloadFileState';
import {
  formatHotReloadStateLens,
  HotReloadFileStateCodeLensProvider,
  type HotReloadFileStateLensDeps
} from '../src/hotReloadFileStateLens';
import { formatHotReloadTime } from '../src/hotReloadStatus';

// IDE-HOT-100 §3.4 文件顶部状态点:CodeLens 挂 状态点 + 当前基线 hash 前
// 12 位 + 最近一次投递 detail;跨目标取最重态,点击命令落完整报告。

const ROOT = '/ws';
const KEY: HotReloadTargetKey = { rootId: ROOT, targetId: 'cellapp#a' };
const FILE = '/ws/scripts/base/Avatar.py';
const CONTENT_A = 'print("A")\n';
const CONTENT_B = 'print("B")\n';
const DIGEST_A = sha256Hex(CONTENT_A);

const makeState = (): HotReloadFileStateMachine => new HotReloadFileStateMachine({ now: () => 1000, timeoutWindowMs: 10_000 });

const makeProvider = (extra: Partial<Pick<HotReloadFileStateLensDeps, 'stat' | 'now'>> = {}): { provider: HotReloadFileStateCodeLensProvider; stateMachine: HotReloadFileStateMachine; ledger: HotReloadTargetStateStore } => {
  const stateMachine = makeState();
  const ledger = new HotReloadTargetStateStore({ now: () => 1000 });
  const provider = new HotReloadFileStateCodeLensProvider({
    stateMachine,
    ledger,
    resolveRootId: file => (file.startsWith(`${ROOT}/`) ? ROOT : null),
    targetsForRoot: () => [KEY.targetId],
    ...extra
  });
  return { provider, stateMachine, ledger };
};

const lensOf = async (
  provider: HotReloadFileStateCodeLensProvider,
  text: string,
  options: { dirty?: boolean } = {}
): Promise<unknown[]> => {
  const document = makeTextDocument(text, { fileName: FILE, languageId: 'python' }) as MinimalTextDocument;
  if (options.dirty) {
    (document as { isDirty?: boolean }).isDirty = true;
  }
  return provider.provideCodeLenses(document as unknown as vscode.TextDocument, new vscode.CancellationToken());
};

describe('formatHotReloadStateLens(状态点文字)', () => {
  it('含状态 + 基线 hash 前 12 位 + detail', () => {
    const view: HotReloadFileStateView = {
      file: FILE,
      state: 'APPLIED',
      baselineDigest: DIGEST_A,
      detail: '回执 applied 且 digest 一致:已应用',
      hashSet: { lastVerifiedAppliedHash: DIGEST_A, currentDiskHash: DIGEST_A }
    };
    const text = formatHotReloadStateLens(view);
    expect(text).toContain('APPLIED');
    expect(text).toContain(DIGEST_A.slice(0, 12));
    expect(text).toContain('回执 applied');
  });

  it('FAILED 用 reason 优先(不混叫 detail)', () => {
    const view: HotReloadFileStateView = {
      file: FILE,
      state: 'FAILED',
      reason: 'HTTP 状态 500',
      hashSet: {}
    };
    expect(formatHotReloadStateLens(view)).toContain('HTTP 状态 500');
  });

  it('带最近投递时间(用户在文件顶就要看到「哪一次、什么时候」)', () => {
    const epoch = Date.parse('2026-11-12T12:34:56Z');
    const view: HotReloadFileStateView = {
      file: FILE,
      state: 'APPLIED',
      baselineDigest: DIGEST_A,
      updatedAt: epoch,
      detail: '回执 applied 且 digest 一致',
      hashSet: { lastVerifiedAppliedHash: DIGEST_A, currentDiskHash: DIGEST_A }
    };
    const text = formatHotReloadStateLens(view);
    // 期望串按同一把格式同算(时区无关:两侧共用 formatHotReloadTime)
    expect(text).toContain(`上次 ${formatHotReloadTime(epoch)}`);
    // 时间在 detail 之前:先定位「哪一次、什么时候」,再看详情
    expect(text.indexOf('上次 ')).toBeLessThan(text.indexOf('回执 applied'));
  });

  it('无记录(无 updatedAt)不出现时间,不填空位', () => {
    const view: HotReloadFileStateView = { file: FILE, state: 'CLEAN', hashSet: {} };
    expect(formatHotReloadStateLens(view)).not.toContain('上次');
  });
});

describe('HotReloadFileStateCodeLensProvider(文件顶部状态点)', () => {
  it('文件顶部挂一个状态点 lens(command 指向展示命令)', async () => {
    const { provider, ledger } = makeProvider();
    ledger.record(KEY, FILE, 'applied', { sentDigest: DIGEST_A });
    const lenses = await lensOf(provider, CONTENT_A);
    expect(lenses).toHaveLength(1);
    const lens = lenses[0] as vscode.CodeLens;
    expect(lens.range.start.line).toBe(0);
    const command = (lens as { command?: { title: string; command: string } }).command;
    expect(command?.command).toBe('kbengine.hotReload.showFileState');
    expect(command?.title).toContain('APPLIED');
  });

  it('DIRTY 状态点随文档现内容派生(编辑中即反映)', async () => {
    const { provider, stateMachine, ledger } = makeProvider();
    stateMachine.derive(ledger, KEY, FILE, CONTENT_A); // 基线 A
    const lenses = await lensOf(provider, CONTENT_B);
    const lens = lenses[0] as { command?: { title: string } };
    expect(lens.command?.title).toContain('DIRTY');
  });

  it('rootId 解不到 → 无 lens', async () => {
    const { provider } = makeProvider();
    const document = makeTextDocument(CONTENT_A, { fileName: '/elsewhere/x.py', languageId: 'python' });
    const lenses = await provider.provideCodeLenses(document as unknown as vscode.TextDocument, new vscode.CancellationToken());
    expect(lenses).toEqual([]);
  });

  it('无目标 → 无 lens', async () => {
    const stateMachine = makeState();
    const ledger = new HotReloadTargetStateStore({ now: () => 1000 });
    const provider = new HotReloadFileStateCodeLensProvider({
      stateMachine,
      ledger,
      resolveRootId: () => ROOT,
      targetsForRoot: () => []
    });
    expect(await lensOf(provider, CONTENT_A)).toEqual([]);
  });

  it('refresh 触发 onDidChangeCodeLenses', () => {
    const { provider } = makeProvider();
    let fired = 0;
    provider.onDidChangeCodeLenses(() => {
      fired += 1;
    });
    provider.refresh();
    expect(fired).toBe(1);
  });
});

// FILE-TIME-001 并入段(2026-11-25 用户裁定首行一条完整热更信息):盘上
// mtime 一次 stat 拼在热更段尾(· 分隔),失败/缺省不带段不编造;独立
// 修改时间 provider 已退役,呈现面用例落此处。
describe('修改时间段并入(FILE-TIME-001 → 热更状态镜)', () => {
  // 固定钟:今天=2026-11-25 20:15:09 本地时间;mtime 同日 14:05:01
  const NOW = new Date(2026, 10, 25, 20, 15, 9).getTime();
  const MTIME = new Date(2026, 10, 25, 14, 5, 1).getTime();

  const titleOf = async (provider: HotReloadFileStateCodeLensProvider, options: { dirty?: boolean } = {}): Promise<string> => {
    const lenses = (await lensOf(provider, CONTENT_A, options)) as { command?: { title: string } }[];
    return lenses[0]?.command?.title ?? '';
  };

  it('stat 命中:热更段尾拼「修改 HH:MM:SS」(· 分隔),状态段照旧', async () => {
    const { provider, ledger } = makeProvider({
      stat: async () => ({ mtimeMs: MTIME }),
      now: () => NOW
    });
    ledger.record(KEY, FILE, 'applied', { sentDigest: DIGEST_A });
    const title = await titleOf(provider);
    expect(title).toContain('APPLIED');
    expect(title).toContain('· $(clock) 修改 14:05:01');
  });

  it('缓冲区未保存:mtime 段显式注记,不改写盘上时间', async () => {
    const { provider } = makeProvider({
      stat: async () => ({ mtimeMs: MTIME }),
      now: () => NOW
    });
    expect(await titleOf(provider, { dirty: true })).toContain('$(clock) 修改 14:05:01(未保存)');
  });

  it('stat 失败(删除/不可及):只出热更段,不编造时间', async () => {
    const { provider, ledger } = makeProvider({
      stat: async () => {
        throw new Error('ENOENT');
      },
      now: () => NOW
    });
    ledger.record(KEY, FILE, 'applied', { sentDigest: DIGEST_A });
    const title = await titleOf(provider);
    expect(title).toContain('APPLIED');
    expect(title).not.toContain('修改');
  });

  it('缺省无 stat 注入:不带修改段(装配面未接时旧行为)', async () => {
    const { provider } = makeProvider();
    expect(await titleOf(provider)).not.toContain('修改');
  });
});
