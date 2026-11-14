import { describe, expect, it } from 'vitest';
import {
  BRIDGE_API_CONTRACTS,
  BRIDGE_CALLBACK_CONTRACTS,
  scanBridgeContracts,
  type FlowBridgeEntryModule,
  type FlowBridgeScanInput
} from '../src/backend/flowBridges';

// FLOW-009(旧 KFLOW-CORE-09)其他进程桥接契约钉。
// 验收:逐条登记 loginapp/dbmgr/interfaces 等 API 请求/回调桥;machine/logger
// 等只在有真实业务边时出现,禁止拓扑全连接。

const INTERFACES_ENTRY: FlowBridgeEntryModule = {
  filePath: '/ws/scripts/interface/kbemain.py',
  text: [
    'import KBEngine',
    '',
    'def onInterfaceAppReady():',
    '    KBEngine.addTimer(1.0, 0, tick)',
    '',
    'def onInterfaceAppShutDown():',
    '    pass',
    '',
    'def onRequestAccountLogin(loginName, password, datas):',
    '    KBEngine.accountLoginResponse(loginName, loginName, datas, KBEngine.SERVER_SUCCESS)',
    '',
    'class Handler:',
    '    def onRequestCharge(self, ordersID, entityDBID, datas):',
    '        pass',
    '',
    'def onRequestLogin(loginName, password, clientType, datas):',
    '    return KBEngine.SERVER_SUCCESS'
  ].join('\n')
};

const input = (
  overrides: Partial<FlowBridgeScanInput> = {},
  entryModules: Partial<Record<'loginapp' | 'dbmgr' | 'interfaces' | 'logger', FlowBridgeEntryModule>> = {
    interfaces: INTERFACES_ENTRY
  }
): FlowBridgeScanInput => ({
  rootKey: '/ws',
  entryModules,
  ...overrides
});

describe('FLOW-009 登记册逐条登记', () => {
  it('四进程契约条数:loginapp 6/dbmgr 4/logger 4/interfaces 5;API 桥 dbmgr 1/interfaces 3', () => {
    const byProcess = (process: string) =>
      BRIDGE_CALLBACK_CONTRACTS.filter(contract => contract.process === process);
    expect(byProcess('loginapp')).toHaveLength(6);
    expect(byProcess('dbmgr')).toHaveLength(4);
    expect(byProcess('logger')).toHaveLength(4);
    expect(byProcess('interfaces')).toHaveLength(5);
    expect(BRIDGE_CALLBACK_CONTRACTS).toHaveLength(19);
    expect(BRIDGE_API_CONTRACTS.filter(a => a.process === 'dbmgr')).toHaveLength(1);
    expect(BRIDGE_API_CONTRACTS.filter(a => a.process === 'interfaces')).toHaveLength(3);
  });

  it('每条契约的 trigger 都带 fork 源锚(.cpp 行号/知识库出处),不凭印象', () => {
    for (const contract of BRIDGE_CALLBACK_CONTRACTS) {
      expect(contract.trigger).toMatch(/\.cpp:\d/);
    }
    for (const api of BRIDGE_API_CONTRACTS) {
      expect(api.trigger.length).toBeGreaterThan(10);
    }
  });

  it('请求↔续段契约逐条登记:loginapp 两条 db 回程、interfaces 三条脚本 Response', () => {
    const pairs = BRIDGE_CALLBACK_CONTRACTS.filter(contract => contract.pairsWith);
    expect(pairs.map(p => `${p.callbackName}→${p.pairsWith!.continuation}`).sort()).toEqual([
      'onRequestAccountLogin→accountLoginResponse',
      'onRequestCharge→chargeResponse',
      'onRequestCreateAccount→createAccountResponse',
      'onRequestCreateAccount→onCreateAccountCallbackFromDB',
      'onRequestLogin→onLoginCallbackFromDB'
    ]);
  });
});

describe('FLOW-009 真实业务边门(禁拓扑全连接)', () => {
  it('machine 无契约无脚本面:注册表零 machine 条目,扫描零边', () => {
    expect(BRIDGE_CALLBACK_CONTRACTS.filter(c => (c.process as string) === 'machine')).toHaveLength(0);
    expect(BRIDGE_API_CONTRACTS.filter(a => (a.process as string) === 'machine')).toHaveLength(0);
    const result = scanBridgeContracts(input({}, {}));
    expect(result.bindings).toHaveLength(0);
    expect(result.undefinedCallbacks).toHaveLength(0);
    expect(result.activeProcesses).toEqual([]);
    // 有契约未提供入口模块的进程如实列出(零边,不伪造)
    expect(result.silentProcesses).toEqual(['loginapp', 'dbmgr', 'interfaces', 'logger']);
  });

  it('logger 未提供入口模块:不出现任何 logger 边(静默进程如实)', () => {
    const result = scanBridgeContracts(input());
    expect(result.activeProcesses).toEqual(['interfaces']);
    expect(result.silentProcesses).toContain('logger');
    expect(result.bindings.filter(b => b.process === 'logger')).toHaveLength(0);
  });

  it('入口模块已定义回调才有引擎→脚本边;未定义回调如实列出零边', () => {
    const result = scanBridgeContracts(input());
    const names = result.bindings.map(b => b.callbackName).sort();
    // 定义了 3 个顶层回调;onRequestCharge 在类里(形态不符)、onRequestCreateAccount 未定义
    expect(names).toEqual(['onInterfaceAppReady', 'onInterfaceAppShutDown', 'onRequestAccountLogin']);
    const undefinedNames = result.undefinedCallbacks.map(u => u.callbackName).sort();
    expect(undefinedNames).toEqual(['onRequestCharge', 'onRequestCreateAccount']);
    // 未定义回调不产生绑定边
    expect(result.bindings.find(b => b.callbackName === 'onRequestCharge')).toBeUndefined();
  });
});

describe('FLOW-009 绑定形态', () => {
  it('绑定=external-entry(无 fn)→ 脚本回调帧(fn 真实),engine-callback 边', () => {
    const result = scanBridgeContracts(input());
    const binding = result.bindings.find(b => b.callbackName === 'onRequestAccountLogin');
    expect(binding).toBeDefined();
    expect(binding!.process).toBe('interfaces');
    // external-entry:引擎侧不是 Python 函数,协议拒绝 fn
    expect(binding!.entryNode.kind).toBe('external-entry');
    expect(binding!.entryNode.fn).toBeNull();
    // 脚本回调帧:入口模块顶层 def,位置真实
    expect(binding!.handlerNode.kind).toBe('function');
    expect(binding!.handlerNode.fn?.filePath).toBe(INTERFACES_ENTRY.filePath);
    expect(binding!.handlerNode.declaration?.line).toBe(9);
    expect(binding!.handlerNode.fn?.signature).toContain('def onRequestAccountLogin(loginName, password, datas)');
    // 引擎→脚本边:engine-callback;请求↔回调对=async-callback
    expect(binding!.entryEdge.fromNodeId).toBe(binding!.entryNode.id);
    expect(binding!.entryEdge.toNodeId).toBe(binding!.handlerNode.id);
    expect(binding!.entryEdge.messageKind).toBe('engine-callback');
    expect(binding!.entryEdge.syncAsync).toBe('async-callback');
    expect(binding!.entryEdge.evidence.type).toBe('declaration-contract');
    expect(binding!.entryEdge.evidence.detail).toContain('interfaces.cpp:605-650');
    expect(binding!.entryEdge.evidence.detail).toContain('kbemain.py:9');
  });

  it('生命周期回调(无 pairsWith)=sync;definedGated 契约未定义注明引擎门控', () => {
    const result = scanBridgeContracts(input());
    const ready = result.bindings.find(b => b.callbackName === 'onInterfaceAppReady');
    expect(ready!.entryEdge.syncAsync).toBe('sync');
    const shutdown = result.undefinedCallbacks.find(u => u.callbackName === 'onRequestCharge');
    expect(shutdown!.reason).toContain('traceback');
    // gate 类契约(logger.onReadyForShutDown 等)在未提供模块时不产生 reason;
    // 用 interfaces 侧没有 gate 契约的反面:定义列表里 onInterfaceAppShutDown 已定义
    expect(result.bindings.find(b => b.callbackName === 'onInterfaceAppShutDown')).toBeDefined();
  });

  it('类方法形态不满足入口模块契约(引擎只调模块属性)', () => {
    const result = scanBridgeContracts(input());
    const charge = result.undefinedCallbacks.find(u => u.callbackName === 'onRequestCharge');
    expect(charge).toBeDefined();
    expect(charge!.reason).toContain('未定义');
  });

  it('同名 def 重复:Python 名字绑定取最后一个 def', () => {
    const entry: FlowBridgeEntryModule = {
      filePath: '/ws/scripts/interface/kbemain.py',
      text: [
        'def onInterfaceAppReady():',
        '    pass',
        '',
        'def onInterfaceAppReady():',
        '    pass'
      ].join('\n')
    };
    const result = scanBridgeContracts(input({}, { interfaces: entry }));
    expect(result.bindings).toHaveLength(1);
    expect(result.bindings[0].handlerNode.declaration?.line).toBe(4);
  });
});
