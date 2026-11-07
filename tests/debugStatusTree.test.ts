import { describe, expect, it } from 'vitest';
import { DebugTargetTreeProvider, debugPhaseLabel } from '../src/debug/debugStatusTree';
import { ThemeIcon } from './helpers/vscodeStub';
import type { DebugStatusRow } from '../src/debug/debugStatusBoard';

// IDE-DBG-008 工作台面:Debug Targets 树逐目标一行,四态在描述/图标上
// 各自可辨,点击带 serverKey 参数走 kbengine.debug.focusTarget 定位命令
// (已附加=打开 Run and Debug 视图定位会话,监听/失败/未注入=如实提示)。

const row = (overrides: Partial<DebugStatusRow>): DebugStatusRow => ({
  serverKey: 'cellapp',
  component: 'cellapp',
  targetId: 'cellapp',
  processStatus: 'Running',
  phase: 'not-injected',
  attachedSessions: 0,
  ...overrides
});

describe('DebugTargetTreeProvider(四态树,DBG-008)', () => {
  it('四态标签齐:未注入/监听/已附加/失败', () => {
    // KODE-I18N-002:四态标签走取词,默认英文 locale 出英文源串
    expect(debugPhaseLabel('not-injected')).toBe('Not injected');
    expect(debugPhaseLabel('listening')).toBe('Listening');
    expect(debugPhaseLabel('attached')).toBe('Attached');
    expect(debugPhaseLabel('failed')).toBe('Failed');
  });

  it('行→树项:描述带态标签+端口+会话数+进程状态,图标分四态,点击带 serverKey', async () => {
    const rows: DebugStatusRow[] = [
      row({ serverKey: 'cellapp', phase: 'not-injected' }),
      row({ serverKey: 'cellapp#a', targetId: 'a', phase: 'listening', port: 5708 }),
      row({ serverKey: 'baseapp', component: 'baseapp', targetId: 'baseapp', phase: 'attached', port: 5678, attachedSessions: 1 }),
      row({ serverKey: 'dbmgr', component: 'dbmgr', targetId: 'dbmgr', processStatus: 'Starting', phase: 'failed', detail: 'telnet 未就绪' })
    ];
    const provider = new DebugTargetTreeProvider({ getRows: () => rows });

    const items = await provider.getChildren();

    expect(items.map(item => item.label)).toEqual(['cellapp', 'cellapp#a', 'baseapp', 'dbmgr']);
    expect(items[0].description).toContain('Not injected');
    expect(items[1].description).toContain('Listening');
    expect(items[1].description).toContain('5708');
    expect(items[2].description).toContain('Attached');
    expect(items[2].description).toContain('1 session(s)');
    expect(items[3].description).toContain('Failed');
    expect(items[3].description).toContain('Starting');
    expect(items.map(item => (item.iconPath as ThemeIcon).id)).toEqual([
      'circle-outline',
      'plug',
      'debug-alt',
      'error'
    ]);
    for (const item of items) {
      expect(item.command?.command).toBe('kbengine.debug.focusTarget');
      expect(item.command?.arguments).toEqual([item.label]);
    }
  });

  it('refresh 触发 onDidChangeTreeData(注入/会话/进程三面变化都能踢)', () => {
    const provider = new DebugTargetTreeProvider({ getRows: () => [] });
    const fired: Array<string | undefined> = [];
    provider.onDidChangeTreeData(item => fired.push(item?.label));

    provider.refresh();

    expect(fired).toEqual([undefined]);
  });
});
