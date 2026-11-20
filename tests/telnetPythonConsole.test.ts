import { describe, expect, it } from 'vitest';

import {
  runPythonConsoleEntry,
  type PythonConsolePickItem,
  type TelnetPythonConsoleDeps
} from '../src/telnetPythonConsole';
import type { TelnetProbeState, TelnetTarget } from '../src/telnetService';

// TELNET-EZ-001 ②「Python 控制台」浅入口编排:探测→已开组件一键选→进
// 面板会话;全未开/无目标一次性引导(附「打开 Telnet 面板」动作);取消
// 如实返回。依赖全注入,零 vscode/零网络。

interface DepKit {
  deps: TelnetPythonConsoleDeps;
  probeCalls: number;
  quickPickItems: PythonConsolePickItem[] | null;
  pick: PythonConsolePickItem | undefined;
  messages: Array<{ message: string; actions: string[] }>;
  messageAction: string | undefined;
  openedWithTarget: string[];
  openedPlain: number;
}

const target = (port: number, over: Partial<TelnetTarget> = {}): TelnetTarget => ({
  key: `127.0.0.1:${port}`,
  label: `comp-${port}`,
  component: `comp-${port}`,
  host: '127.0.0.1',
  port,
  password: 'pwd',
  enableCommands: [],
  ...over
});

const makeDeps = (
  targets: TelnetTarget[],
  states: Record<string, TelnetProbeState>,
  over: Partial<DepKit> = {}
): DepKit => {
  const kit: DepKit = {
    probeCalls: 0,
    quickPickItems: null,
    pick: undefined,
    messages: [],
    messageAction: undefined,
    openedWithTarget: [],
    openedPlain: 0,
    ...over
  } as DepKit;
  kit.deps = {
    probeOnce: async () => {
      kit.probeCalls += 1;
    },
    getTargets: () => targets,
    getState: key => states[key] ?? 'closed',
    showQuickPick: async (items, options) => {
      expect(options.placeHolder.length).toBeGreaterThan(0);
      kit.quickPickItems = items;
      return kit.pick;
    },
    showInformationMessage: async (message, ...actions) => {
      kit.messages.push({ message, actions });
      return kit.messageAction;
    },
    openPanelWithTarget: key => {
      kit.openedWithTarget.push(key);
    },
    openPanel: () => {
      kit.openedPlain += 1;
    }
  };
  return kit;
};

describe('runPythonConsoleEntry 浅入口编排(TELNET-EZ-001 ②)', () => {
  it('点击即先探测一轮(不吃旧缓存),已开组件进 QuickPick,选中→打开面板并定位', async () => {
    const kit = makeDeps(
      [target(31000, { label: 'loginapp' }), target(32000, { label: 'dbmgr' }), target(33000, { label: 'interfaces' })],
      { '127.0.0.1:31000': 'open', '127.0.0.1:32000': 'connected', '127.0.0.1:33000': 'closed' }
    );
    kit.pick = { key: '127.0.0.1:31000', label: 'loginapp', detail: '127.0.0.1:31000', description: '已开启' };

    const outcome = await runPythonConsoleEntry(kit.deps);
    expect(outcome).toBe('picked');
    // 先探测后选择:探测链复用既有 TelnetService.probeOnce
    expect(kit.probeCalls).toBe(1);
    // closed 组件不进选择列表;open/connected 都在,带地址与状态描述
    expect(kit.quickPickItems?.map(item => item.key)).toEqual(['127.0.0.1:31000', '127.0.0.1:32000']);
    expect(kit.quickPickItems?.[1].description).toBe('已连接');
    expect(kit.openedWithTarget).toEqual(['127.0.0.1:31000']);
    expect(kit.openedPlain).toBe(0);
  });

  it('auth-required 端口也开着:一并可选(进面板看密码指引,不硬连)', async () => {
    const kit = makeDeps([target(34000, { label: 'logger' })], { '127.0.0.1:34000': 'auth-required' });
    kit.pick = { key: '127.0.0.1:34000', label: 'logger', detail: '127.0.0.1:34000', description: '端口开·未配密码' };
    const outcome = await runPythonConsoleEntry(kit.deps);
    expect(outcome).toBe('picked');
    expect(kit.quickPickItems?.[0].description).toBe('端口开·未配密码');
    expect(kit.openedWithTarget).toEqual(['127.0.0.1:34000']);
  });

  it('全部组件未开:一次性引导(附「打开 Telnet 面板」动作),点动作打开面板', async () => {
    const kit = makeDeps([target(31000)], { '127.0.0.1:31000': 'closed' });
    kit.messageAction = '打开 Telnet 面板';
    const outcome = await runPythonConsoleEntry(kit.deps);
    expect(outcome).toBe('guided');
    expect(kit.messages).toHaveLength(1);
    expect(kit.messages[0].message).toContain('kbengine.xml');
    expect(kit.messages[0].message).toContain('<telnet_service>');
    expect(kit.messages[0].actions).toEqual(['打开 Telnet 面板']);
    expect(kit.openedPlain).toBe(1);
    expect(kit.openedWithTarget).toEqual([]);
    expect(kit.quickPickItems).toBeNull();
  });

  it('无任何 telnet 目标:同口径引导(配置指向),不空转', async () => {
    const kit = makeDeps([], {});
    const outcome = await runPythonConsoleEntry(kit.deps);
    expect(outcome).toBe('no-targets');
    expect(kit.messages).toHaveLength(1);
    expect(kit.messages[0].message).toContain('kbengine.telnet.host');
    // 未点动作:不开面板
    expect(kit.openedPlain).toBe(0);
  });

  it('QuickPick 取消:如实返回 cancelled,不开面板不发探测外的动作', async () => {
    const kit = makeDeps([target(31000)], { '127.0.0.1:31000': 'open' });
    kit.pick = undefined;
    const outcome = await runPythonConsoleEntry(kit.deps);
    expect(outcome).toBe('cancelled');
    expect(kit.openedWithTarget).toEqual([]);
    expect(kit.openedPlain).toBe(0);
  });
});
