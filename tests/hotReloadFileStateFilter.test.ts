import { describe, expect, it } from 'vitest';
import { HotReloadTargetStateStore, type HotReloadTargetKey } from '../src/hotReloadTargetState';
import { HotReloadFileStateMachine, sha256Hex, type HotReloadFileStateView } from '../src/hotReloadFileState';
import {
  renderHotReloadAttentionReport,
  renderHotReloadFileStateDetail,
  runHotReloadFileStateFilterCommand,
  runShowHotReloadFileStateCommand
} from '../src/hotReloadFileStateFilter';

// IDE-HOT-100 §3.4 状态过滤:「看哪些改了还没重载」= DIRTY ∪ SENT 的过滤
// 视图,遍历已知键筛注意力集,报告落通道。FAILED/RESTART_REQUIRED 不混进。

const KEY: HotReloadTargetKey = { rootId: '/ws', targetId: 'cellapp#a' };
const FILE_DIRTY = '/ws/scripts/base/Avatar.py';
const FILE_SENT = '/ws/scripts/base/Account.py';
const FILE_APPLIED = '/ws/scripts/base/Teleport.py';
const FILE_CLEAN = '/ws/scripts/base/Bridge.py';
const CONTENT_A = 'print("A")\n';
const CONTENT_B = 'print("B")\n';
const DIGEST_A = sha256Hex(CONTENT_A);

const makeState = (): HotReloadFileStateMachine => new HotReloadFileStateMachine({ now: () => 1000, timeoutWindowMs: 10_000 });

const seed = (): { stateMachine: HotReloadFileStateMachine; ledger: HotReloadTargetStateStore } => {
  const stateMachine = makeState();
  const ledger = new HotReloadTargetStateStore({ now: () => 1000 });
  stateMachine.derive(ledger, KEY, FILE_CLEAN, CONTENT_A); // 基线 → CLEAN
  stateMachine.derive(ledger, KEY, FILE_DIRTY, CONTENT_A); // 基线 A
  stateMachine.derive(ledger, KEY, FILE_DIRTY, CONTENT_B); // DIRTY
  ledger.record(KEY, FILE_SENT, 'sent-unverified', { sentDigest: DIGEST_A, now: 1000 }); // SENT
  ledger.record(KEY, FILE_APPLIED, 'applied', { sentDigest: DIGEST_A }); // APPLIED
  return { stateMachine, ledger };
};

const contentOf = async (file: string): Promise<string | undefined> => (file === FILE_DIRTY ? CONTENT_B : CONTENT_A);

describe('renderHotReloadAttentionReport(注意力报告)', () => {
  it('空 → 如实无待处理', () => {
    expect(renderHotReloadAttentionReport([])).toContain('无');
  });

  it('逐文件 状态/基线前 12 位/明细', () => {
    const views: HotReloadFileStateView[] = [
      { file: FILE_DIRTY, state: 'DIRTY', baselineDigest: DIGEST_A, detail: '已修改未重载' },
      { file: FILE_SENT, state: 'SENT', baselineDigest: DIGEST_A, annotation: '回执 accepted' }
    ];
    const report = renderHotReloadAttentionReport(views);
    expect(report).toContain('2 个文件');
    expect(report).toContain(FILE_DIRTY);
    expect(report).toContain(DIGEST_A.slice(0, 12));
    expect(report).toContain('accepted');
  });
});

describe('runHotReloadFileStateFilterCommand(按状态过滤)', () => {
  it('只列 DIRTY/SENT,不含 CLEAN/APPLIED', async () => {
    const { stateMachine, ledger } = seed();
    const blocks: string[] = [];
    let shown = 0;
    await runHotReloadFileStateFilterCommand(
      { stateMachine, ledger, readFileContent: contentOf },
      {
        logBlock: text => blocks.push(text),
        show: () => {
          shown += 1;
        }
      }
    );
    const report = blocks.join('\n');
    expect(report).toContain(FILE_DIRTY);
    expect(report).toContain(FILE_SENT);
    expect(report).not.toContain(FILE_APPLIED);
    expect(report).not.toContain(FILE_CLEAN);
    expect(shown).toBe(1);
  });

  it('无已知键 → 如实无待处理', async () => {
    const stateMachine = makeState();
    const ledger = new HotReloadTargetStateStore({ now: () => 1000 });
    const blocks: string[] = [];
    await runHotReloadFileStateFilterCommand(
      { stateMachine, ledger, readFileContent: contentOf },
      { logBlock: text => blocks.push(text), show: () => undefined }
    );
    expect(blocks[0]).toContain('无');
  });
});

describe('renderHotReloadFileStateDetail(单文件跨目标明细)', () => {
  it('无目标 → 如实无关联', () => {
    expect(renderHotReloadFileStateDetail(FILE_DIRTY, [])).toContain('无目标关联');
  });

  it('逐目标一行,含状态/基线/代际/明细', () => {
    const views: HotReloadFileStateView[] = [
      { file: FILE_DIRTY, state: 'DIRTY', baselineDigest: DIGEST_A, attempt: 2, detail: '已修改未重载' },
      { file: FILE_DIRTY, state: 'FAILED', reason: 'HTTP 状态 500', attempt: 1 }
    ];
    const report = renderHotReloadFileStateDetail(FILE_DIRTY, views);
    expect(report).toContain('2 个目标');
    expect(report).toContain('DIRTY');
    expect(report).toContain('FAILED');
    expect(report).toContain('发送 #2');
    expect(report).toContain('HTTP 状态 500');
  });
});

describe('runShowHotReloadFileStateCommand(状态点点击)', () => {
  it('落单文件跨目标状态明细', async () => {
    const { stateMachine, ledger } = seed();
    const blocks: string[] = [];
    await runShowHotReloadFileStateCommand(
      {
        stateMachine,
        ledger,
        readFileContent: contentOf,
        resolveRootId: file => (file.startsWith('/ws/') ? '/ws' : null),
        targetsForRoot: () => [KEY.targetId]
      },
      { logBlock: text => blocks.push(text), show: () => undefined },
      FILE_DIRTY
    );
    expect(blocks[0]).toContain(FILE_DIRTY);
    expect(blocks[0]).toContain('DIRTY');
  });

  it('rootId 解不到 → 如实说明', async () => {
    const { stateMachine, ledger } = seed();
    const blocks: string[] = [];
    await runShowHotReloadFileStateCommand(
      {
        stateMachine,
        ledger,
        readFileContent: contentOf,
        resolveRootId: () => null,
        targetsForRoot: () => [KEY.targetId]
      },
      { logBlock: text => blocks.push(text), show: () => undefined },
      '/elsewhere/x.py'
    );
    expect(blocks[0]).toContain('不在工作区根内');
  });
});
