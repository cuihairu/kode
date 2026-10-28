import { describe, expect, it } from 'vitest';
import { DebugTargetTreeProvider, DEBUG_PHASE_LABELS } from '../src/debugStatusTree';
import { ThemeIcon } from './helpers/vscodeStub';
import type { DebugStatusRow } from '../src/debugStatusBoard';

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
    expect(DEBUG_PHASE_LABELS).toEqual({
      'not-injected': '未注入',
      listening: '监听',
      attached: '已附加',
      failed: '失败'
    });
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
    expect(items[0].description).toContain('未注入');
    expect(items[1].description).toContain('监听');
    expect(items[1].description).toContain('5708');
    expect(items[2].description).toContain('已附加');
    expect(items[2].description).toContain('1 个会话');
    expect(items[3].description).toContain('失败');
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
