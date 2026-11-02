import { describe, expect, it } from 'vitest';
import * as vscode from 'vscode';
import { HotReloadTargetStateStore, type HotReloadTargetKey } from '../src/hotReloadTargetState';
import { HotReloadFileStateMachine, sha256Hex } from '../src/hotReloadFileState';
import { HotReloadFileDecorationProvider } from '../src/hotReloadFileDecorations';

// IDE-HOT-100 §3.4 文件树角标:DIRTY 橙/SENT 蓝/APPLIED 绿/FAILED 红/
// RESTART_REQUIRED 紫,CLEAN 无角标;跨目标取最重态(worst wins)不混叫。
// 本面只把状态机派生视图映射成 FileDecoration,读取/目标集经注入面。

const ROOT = '/ws';
const TARGET_A: HotReloadTargetKey = { rootId: ROOT, targetId: 'cellapp#a' };
const TARGET_B: HotReloadTargetKey = { rootId: ROOT, targetId: 'cellapp#b' };
const FILE = '/ws/scripts/base/Avatar.py';
const CONTENT_A = 'print("A")\n';
const CONTENT_B = 'print("B")\n';
const DIGEST_A = sha256Hex(CONTENT_A);

const makeState = (): HotReloadFileStateMachine => new HotReloadFileStateMachine({ now: () => 1000, timeoutWindowMs: 10_000 });

interface Harness {
  stateMachine: HotReloadFileStateMachine;
  ledger: HotReloadTargetStateStore;
  provider: HotReloadFileDecorationProvider;
}

const makeHarness = (targets: string[]): Harness => {
  const stateMachine = makeState();
  const ledger = new HotReloadTargetStateStore({ now: () => 1000 });
  const provider = new HotReloadFileDecorationProvider({
    stateMachine,
    ledger,
    resolveRootId: file => (file.startsWith(`${ROOT}/`) ? ROOT : null),
    targetsForRoot: () => targets,
    readFileContent: async () => CONTENT_A
  });
  return { stateMachine, ledger, provider };
};

const decorate = async (provider: HotReloadFileDecorationProvider): Promise<vscode.FileDecoration | undefined> =>
  provider.provideFileDecoration(vscode.Uri.file(FILE), new vscode.CancellationToken());

describe('HotReloadFileDecorationProvider(文件树角标)', () => {
  it('CLEAN 无角标', async () => {
    const { provider } = makeHarness([TARGET_A.targetId]);
    expect(await decorate(provider)).toBeUndefined();
  });

  it('DIRTY → 橙 D 角标', async () => {
    const { stateMachine, ledger, provider } = makeHarness([TARGET_A.targetId]);
    stateMachine.derive(ledger, TARGET_A, FILE, CONTENT_A); // 注册基线 A
    const providerB = new HotReloadFileDecorationProvider({
      stateMachine,
      ledger,
      resolveRootId: file => (file.startsWith(`${ROOT}/`) ? ROOT : null),
      targetsForRoot: () => [TARGET_A.targetId],
      readFileContent: async () => CONTENT_B
    });
    const decoration = await decorate(providerB);
    expect(decoration?.badge).toBe('D');
    expect(decoration?.color?.id).toBe('charts.orange');
  });

  it('SENT → 蓝 S 角标', async () => {
    const { ledger, provider } = makeHarness([TARGET_A.targetId]);
    ledger.record(TARGET_A, FILE, 'sent-unverified', { sentDigest: DIGEST_A, now: 1000 });
    const decoration = await decorate(provider);
    expect(decoration?.badge).toBe('S');
    expect(decoration?.color?.id).toBe('charts.blue');
  });

  it('APPLIED → 绿 A 角标', async () => {
    const { ledger, provider } = makeHarness([TARGET_A.targetId]);
    ledger.record(TARGET_A, FILE, 'applied', { sentDigest: DIGEST_A });
    const decoration = await decorate(provider);
    expect(decoration?.badge).toBe('A');
    expect(decoration?.color?.id).toBe('charts.green');
  });

  it('FAILED → 红 F 角标(不冒充 applied)', async () => {
    const { ledger, provider } = makeHarness([TARGET_A.targetId]);
    ledger.record(TARGET_A, FILE, 'failed', { sentDigest: DIGEST_A, detail: 'HTTP 状态 500' });
    const decoration = await decorate(provider);
    expect(decoration?.badge).toBe('F');
    expect(decoration?.color?.id).toBe('charts.red');
  });

  it('RESTART_REQUIRED → 紫 R 角标(与 FAILED 不混用)', async () => {
    const { stateMachine, ledger, provider } = makeHarness([TARGET_A.targetId]);
    stateMachine.markRestartRequired(TARGET_A, [FILE], ['结构变化']);
    const decoration = await decorate(provider);
    expect(decoration?.badge).toBe('R');
    expect(decoration?.color?.id).toBe('charts.purple');
  });

  it('跨目标 worst wins:一个 applied 一个 dirty → DIRTY', async () => {
    const { stateMachine, ledger } = makeHarness([TARGET_A.targetId, TARGET_B.targetId]);
    stateMachine.derive(ledger, TARGET_A, FILE, CONTENT_A); // 基线 A(target a)
    ledger.record(TARGET_B, FILE, 'applied', { sentDigest: DIGEST_A }); // applied(target b)
    const provider = new HotReloadFileDecorationProvider({
      stateMachine,
      ledger,
      resolveRootId: file => (file.startsWith(`${ROOT}/`) ? ROOT : null),
      targetsForRoot: () => [TARGET_A.targetId, TARGET_B.targetId],
      readFileContent: async () => CONTENT_B
    });
    const decoration = await decorate(provider);
    expect(decoration?.badge).toBe('D');
  });

  it('无目标 → 无角标', async () => {
    const { provider } = makeHarness([]);
    expect(await decorate(provider)).toBeUndefined();
  });

  it('rootId 解不到(文件不在工作区)→ 无角标', async () => {
    const { provider } = makeHarness([TARGET_A.targetId]);
    const outside = provider.provideFileDecoration(
      vscode.Uri.file('/elsewhere/scripts/base/Avatar.py'),
      new vscode.CancellationToken()
    );
    expect(await outside).toBeUndefined();
  });

  it('refresh 触发 onDidChangeFileDecorations(通知重渲染)', () => {
    const { provider } = makeHarness([TARGET_A.targetId]);
    let fired = 0;
    provider.onDidChangeFileDecorations(() => {
      fired += 1;
    });
    provider.refresh();
    expect(fired).toBe(1);
  });
});
