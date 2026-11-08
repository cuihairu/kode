// KODE-I18N-002 Provider 面(树视图家族)运行时文案接线契约。
// 两态断言(与 categoryI18n 同口径):默认(未注入 bundle)= 英文源串,
// 与真实 VS Code 英文 locale 同口径;注入 zh-cn bundle = 中文。
// 覆盖:remoteServerTree / telnetTree / debugStatusTree / quickActionTree /
// gitHistoryTree / gitRangeHistoryTree 的用户可见 label/description/tooltip/
// 引导与错误文案。缺 key 回退行为由 tests/nlsRuntime.test.ts 统一断言。
import { afterEach, describe, expect, it } from 'vitest';
import { setL10nBundle } from './fake-vscode/l10n';
import zhCnBundle from '../l10n/bundle.l10n.zh-cn.json';
import { RemoteServerTreeItem, type RemoteServerNode } from '../src/remoteServerTree';
import { TelnetTreeItem } from '../src/telnetTree';
import { DebugTargetTreeItem, debugPhaseLabel } from '../src/debug/debugStatusTree';
import { QuickActionTreeItem } from '../src/quickActionTree';
import { buildHistoryItems, historyViewTitle, summarizeGitError } from '../src/gitHistoryTree';
import { buildRangeHistoryItems, rangeHistoryViewTitle } from '../src/gitRangeHistoryTree';
import type { DebugStatusRow } from '../src/debug/debugStatusBoard';
import type { TelnetTarget } from '../src/telnetService';

const zh = zhCnBundle as Record<string, string>;

const localNode = (selected = true): RemoteServerNode => ({
  id: 'local',
  kind: 'local',
  selected
});

const telnetTarget: TelnetTarget = { key: 'baseapp', label: 'baseapp', host: '127.0.0.1', port: 20013 };

const debugRow = (overrides: Partial<DebugStatusRow>): DebugStatusRow => ({
  serverKey: 'cellapp',
  component: 'cellapp',
  targetId: 'cellapp',
  processStatus: 'Running',
  phase: 'listening',
  port: 5708,
  attachedSessions: 1,
  ...overrides
});

afterEach(() => {
  setL10nBundle(null);
});

describe('Provider 面运行时文案(两态)', () => {
  it('remoteServerTree:本地节点 label/description/tooltip 双语', () => {
    const item = new RemoteServerTreeItem(localNode());
    expect(item.label).toBe('Local (direct execution)');
    expect(item.description).toContain('✓ selected');
    setL10nBundle(zh);
    const zhItem = new RemoteServerTreeItem(localNode());
    expect(zhItem.label).toBe('本地(直接执行)');
    expect(zhItem.description).toContain('✓ 已选');
    expect(zhItem.tooltip).toContain('本地:debug 与 py-spy 在本机直接执行');
  });

  it('telnetTree:状态词与 tooltip 双语(六态键全接入)', () => {
    const item = new TelnetTreeItem(telnetTarget, 'connected');
    expect(item.description).toContain('Connected');
    setL10nBundle(zh);
    const zhItem = new TelnetTreeItem(telnetTarget, 'connected');
    expect(zhItem.description).toContain('已连接');
    for (const [state, label] of [
      ['connected', '已连接'],
      ['open', '已开启'],
      ['auth-required', '端口开·未配密码'],
      ['auth-rejected', '密码被拒'],
      ['unconfigured', '未配置'],
      ['closed', '未开启']
    ] as const) {
      const probe = new TelnetTreeItem(telnetTarget, state);
      expect(probe.description).toContain(label);
    }
    expect(zhItem.tooltip).toContain('点击打开 Telnet 面板');
  });

  it('debugStatusTree:四态标签双语,树描述/tooltip/命令标题走取词', () => {
    expect(debugPhaseLabel('attached')).toBe('Attached');
    const item = new DebugTargetTreeItem(debugRow({}));
    expect(item.description).toContain('1 session(s)');
    expect(item.command?.title).toBe('Focus debug target');
    setL10nBundle(zh);
    expect(debugPhaseLabel('attached')).toBe('已附加');
    expect(debugPhaseLabel('not-injected')).toBe('未注入');
    expect(debugPhaseLabel('listening')).toBe('监听');
    expect(debugPhaseLabel('failed')).toBe('失败');
    const zhItem = new DebugTargetTreeItem(debugRow({}));
    expect(zhItem.description).toContain('1 个会话');
    expect(zhItem.tooltip).toContain('点击定位调试会话/查看提示');
  });

  it('quickActionTree:空态引导与命令标题双语', () => {
    const item = new QuickActionTreeItem(undefined);
    expect(item.label).toBe('Scan workspace scripts');
    setL10nBundle(zh);
    const zhItem = new QuickActionTreeItem(undefined);
    expect(zhItem.label).toBe('扫描工作区脚本');
    expect(zhItem.description).toBe('选择要添加为快速动作的脚本');
    expect(zhItem.command?.title).toBe('重新扫描脚本');
  });

  it('gitHistoryTree:引导/标题/错误摘要双语', () => {
    const idle = buildHistoryItems({ kind: 'idle' });
    expect(idle[0].kind === 'message' && idle[0].message).toContain('Not queried yet');
    expect(historyViewTitle({ kind: 'idle' })).toBe('File History');
    expect(summarizeGitError({ kind: 'timeout' })).toBe('Query timed out (bounded execution terminated)');
    setL10nBundle(zh);
    const zhIdle = buildHistoryItems({ kind: 'idle' });
    expect(zhIdle[0].kind === 'message' && zhIdle[0].message).toContain('尚未查询');
    expect(historyViewTitle({ kind: 'idle' })).toBe('文件历史');
    expect(summarizeGitError({ kind: 'timeout' })).toBe('查询超时(有界执行已终止)');
    const untracked = buildHistoryItems({ kind: 'untracked', filePath: '/w/foo.def' });
    expect(untracked[0].kind === 'message' && untracked[0].message).toBe('未跟踪文件(不在 Git 索引或历史中):foo.def');
  });

  it('gitRangeHistoryTree:引导/标题双语', () => {
    const none = buildRangeHistoryItems({ kind: 'no-selection' });
    expect(none[0].kind === 'message' && none[0].message).toBe('Select a code range to view its history first');
    expect(rangeHistoryViewTitle({ kind: 'idle' })).toBe('Selection History');
    setL10nBundle(zh);
    const zhNone = buildRangeHistoryItems({ kind: 'no-selection' });
    expect(zhNone[0].kind === 'message' && zhNone[0].message).toBe('请先选择要查看历史的代码范围');
    expect(rangeHistoryViewTitle({ kind: 'idle' })).toBe('选区历史');
    const loaded = buildRangeHistoryItems({
      kind: 'loaded',
      filePath: '/w/foo.py',
      repoRoot: '/w',
      headStart: 1,
      headEnd: 9,
      selectionStart: 1,
      selectionEnd: 9,
      entries: [],
      boundary: { kind: 'origin', atCommit: 'abc1234567', atPath: 'foo.py' },
      unmappedLines: 2
    });
    expect(loaded[0].kind === 'message' && loaded[0].message).toBe(
      '选区 2 行为未提交/未保存新增或修改,无法映射(以下时间线仅已提交部分)'
    );
  });
});
