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
  HotReloadFileStateCodeLensProvider
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

const makeProvider = (): { provider: HotReloadFileStateCodeLensProvider; stateMachine: HotReloadFileStateMachine; ledger: HotReloadTargetStateStore } => {
  const stateMachine = makeState();
  const ledger = new HotReloadTargetStateStore({ now: () => 1000 });
  const provider = new HotReloadFileStateCodeLensProvider({
    stateMachine,
    ledger,
    resolveRootId: file => (file.startsWith(`${ROOT}/`) ? ROOT : null),
    targetsForRoot: () => [KEY.targetId]
  });
  return { provider, stateMachine, ledger };
};

const lensOf = async (provider: HotReloadFileStateCodeLensProvider, text: string): Promise<unknown[]> => {
  const document = makeTextDocument(text, { fileName: FILE, languageId: 'python' }) as MinimalTextDocument;
  return provider.provideCodeLenses(document as unknown as vscode.TextDocument, new vscode.CancellationToken());
};

describe('formatHotReloadStateLens(状态点文字)', () => {
  it('含状态 + 基线 hash 前 12 位 + detail', () => {
    const view: HotReloadFileStateView = {
      file: FILE,
      state: 'APPLIED',
      baselineDigest: DIGEST_A,
      detail: '回执 applied 且 digest 一致:已应用'
    };
    const text = formatHotReloadStateLens(view);
    expect(text).toContain('APPLIED');
    expect(text).toContain(DIGEST_A.slice(0, 12));
    expect(text).toContain('回执 applied');
  });

  it('FAILED 用 reason 优先(不混叫 detail)', () => {
    const view: HotReloadFileStateView = { file: FILE, state: 'FAILED', reason: 'HTTP 状态 500' };
    expect(formatHotReloadStateLens(view)).toContain('HTTP 状态 500');
  });

  it('带最近投递时间(用户在文件顶就要看到「哪一次、什么时候」)', () => {
    const epoch = Date.parse('2026-11-12T12:34:56Z');
    const view: HotReloadFileStateView = {
      file: FILE,
      state: 'APPLIED',
      baselineDigest: DIGEST_A,
      updatedAt: epoch,
      detail: '回执 applied 且 digest 一致'
    };
    const text = formatHotReloadStateLens(view);
    // 期望串按同一把格式同算(时区无关:两侧共用 formatHotReloadTime)
    expect(text).toContain(`上次 ${formatHotReloadTime(epoch)}`);
    // 时间在 detail 之前:先定位「哪一次、什么时候」,再看详情
    expect(text.indexOf('上次 ')).toBeLessThan(text.indexOf('回执 applied'));
  });

  it('无记录(无 updatedAt)不出现时间,不填空位', () => {
    const view: HotReloadFileStateView = { file: FILE, state: 'CLEAN' };
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
