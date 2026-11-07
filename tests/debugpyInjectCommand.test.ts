import { afterEach, describe, expect, it } from 'vitest';
import { configurationOverrides } from './helpers/vscodeStub';
import * as vscode from 'vscode';
import {
  DEBUGPY_INJECT_COMMAND,
  DEBUGPY_INJECT_ENABLED_DEFAULT,
  debugpyInjectEnabled,
  runDebugpyInjectCommand,
  type DebugpyInjectChoice,
  type DebugpyInjectCommandDeps
} from '../src/debugpyInjectCommand';

// KODE-DBG-001 方案②(提案 docs/design/debugpy-attach.md 首选项):一条
// 命令完成「console 注入起监听 + debugpy 附加」。锁定面:开关默认开
// (kbengine.debug.debugpyInject,缺省 true)/关闸零动作/无运行组件如实
// 提示/选择取消零动作/起监听失败不附加且错误带 detail/成功路径先注后附
// 且提示带端口/附加未完成给重试指引。注入与附加本体(injectDebugpyListen /
// attachViaDebugpyPort)各有既有测试面,这里锁命令编排。

interface DepsStubState {
  infoMessages: string[];
  errorMessages: string[];
  ensureCalls: Array<{ component: string; port: number }>;
  attachCalls: string[];
  pickResult: DebugpyInjectChoice | undefined;
  ensureResult: { ok: boolean; detail: string };
  attachResult: boolean;
}

const makeDeps = (
  overrides: Partial<DebugpyInjectCommandDeps> = {},
  state?: Partial<DepsStubState>
): { deps: DebugpyInjectCommandDeps; state: DepsStubState } => {
  const full: DepsStubState = {
    infoMessages: [],
    errorMessages: [],
    ensureCalls: [],
    attachCalls: [],
    pickResult: { component: 'cellapp', label: 'cellapp' },
    ensureResult: { ok: true, detail: 'injected' },
    attachResult: true,
    ...state
  };
  const choices: DebugpyInjectChoice[] = [
    { component: 'baseapp', label: 'baseapp' },
    { component: 'cellapp', label: 'cellapp' }
  ];
  const deps: DebugpyInjectCommandDeps = {
    isEnabled: () => true,
    listRunningComponents: () => choices,
    portFor: component => (component === 'baseapp' ? 5678 : 5679),
    ensureListener: async (component, port) => {
      full.ensureCalls.push({ component, port });
      return full.ensureResult;
    },
    attachViaDebugpyPort: async component => {
      full.attachCalls.push(component);
      return full.attachResult;
    },
    pickComponent: async () => full.pickResult,
    showInformationMessage: (message: string) => {
      full.infoMessages.push(message);
      return undefined;
    },
    showErrorMessage: (message: string) => {
      full.errorMessages.push(message);
      return undefined;
    },
    ...overrides
  };
  return { deps, state: full };
};

describe('KODE-DBG-001 kbengine.debug.debugpyInject 一键注入命令', () => {
  afterEach(() => {
    configurationOverrides.clear();
  });

  it('配置开关缺省即开启(默认 true 常量锁)', () => {
    expect(DEBUGPY_INJECT_ENABLED_DEFAULT).toBe(true);
    expect(debugpyInjectEnabled()).toBe(true);
  });

  it('命令 id 形如 kbengine.debug.debugpyInject', () => {
    expect(DEBUGPY_INJECT_COMMAND).toBe('kbengine.debug.debugpyInject');
  });

  it('开关关闭:提示带设置键,零注入零附加', async () => {
    configurationOverrides.set('kbengine', { 'debug.debugpyInject': false });
    expect(debugpyInjectEnabled()).toBe(false);
    const { deps, state } = makeDeps({ isEnabled: () => false });
    await runDebugpyInjectCommand(deps);
    expect(state.ensureCalls).toEqual([]);
    expect(state.attachCalls).toEqual([]);
    expect(state.infoMessages).toHaveLength(1);
    expect(state.infoMessages[0]).toContain('kbengine.debug.debugpyInject');
    expect(state.errorMessages).toEqual([]);
  });

  it('没有运行中的组件:如实提示,零注入零附加', async () => {
    const { deps, state } = makeDeps({ listRunningComponents: () => [] });
    await runDebugpyInjectCommand(deps);
    expect(state.ensureCalls).toEqual([]);
    expect(state.attachCalls).toEqual([]);
    expect(state.infoMessages).toHaveLength(1);
    expect(state.errorMessages).toEqual([]);
  });

  it('组件选择取消:零注入零附加零提示', async () => {
    const { deps, state } = makeDeps({ pickComponent: async () => undefined });
    await runDebugpyInjectCommand(deps);
    expect(state.ensureCalls).toEqual([]);
    expect(state.attachCalls).toEqual([]);
    expect(state.infoMessages).toEqual([]);
    expect(state.errorMessages).toEqual([]);
  });

  it('起监听失败:错误带 detail,不进入附加', async () => {
    const { deps, state } = makeDeps({}, {
      ensureResult: { ok: false, detail: 'telnet 连不上' }
    });
    await runDebugpyInjectCommand(deps);
    expect(state.ensureCalls).toEqual([{ component: 'cellapp', port: 5679 }]);
    expect(state.attachCalls).toEqual([]);
    expect(state.errorMessages).toHaveLength(1);
    expect(state.errorMessages[0]).toContain('telnet 连不上');
    expect(state.errorMessages[0]).toContain('cellapp');
  });

  it('成功路径:按端口表取口注入,注入成功后才附加,提示带端口', async () => {
    const { deps, state } = makeDeps();
    await runDebugpyInjectCommand(deps);
    expect(state.ensureCalls).toEqual([{ component: 'cellapp', port: 5679 }]);
    expect(state.attachCalls).toEqual(['cellapp']);
    expect(state.infoMessages).toHaveLength(1);
    expect(state.infoMessages[0]).toContain('5679');
    expect(state.infoMessages[0]).toContain('127.0.0.1');
    expect(state.errorMessages).toEqual([]);
  });

  it('监听就绪但附加未完成:错误给 Attach to Component 重试指引', async () => {
    const { deps, state } = makeDeps({}, { attachResult: false });
    await runDebugpyInjectCommand(deps);
    expect(state.ensureCalls).toHaveLength(1);
    expect(state.attachCalls).toEqual(['cellapp']);
    expect(state.errorMessages).toHaveLength(1);
    expect(state.errorMessages[0]).toContain('Attach to Component');
  });

  it('假 vscode 命令注册面:registerDebugpyInjectCommand 挂到命令表且可执行', async () => {
    const { registerDebugpyInjectCommand } = await import('../src/debugpyInjectCommand');
    const { commandRegistry } = await import('./helpers/vscodeStub');
    const context = { subscriptions: [] as Array<{ dispose: () => void }> } as unknown as vscode.ExtensionContext;
    const before = commandRegistry.registeredCommandIds().length;
    registerDebugpyInjectCommand(context, {
      listRunningComponents: () => [],
      ensureListener: async () => ({ ok: false, detail: 'unused' }),
      attachViaDebugpyPort: async () => false
    });
    expect(commandRegistry.registeredCommandIds()).toContain(DEBUGPY_INJECT_COMMAND);
    expect(context.subscriptions).toHaveLength(1);
    // 关闸执行:只提示,不触碰注入/附加
    configurationOverrides.set('kbengine', { 'debug.debugpyInject': false });
    try {
      await vscode.commands.executeCommand(DEBUGPY_INJECT_COMMAND);
      expect(commandRegistry.registeredCommandIds().length).toBe(before + 1);
    } finally {
      configurationOverrides.clear();
      context.subscriptions.forEach(item => item.dispose());
    }
  });
});
