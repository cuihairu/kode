import { describe, expect, it } from 'vitest';
import {
  ASYNC_ENTITY_APIS,
  ASYNC_MODULE_APIS,
  SYNC_MODULE_APIS,
  callArgumentsOnLine,
  linkContinuations,
  type FlowContinuationInput
} from '../src/backend/flowContinuations';
import { resolveFlowCallSites } from '../src/backend/flowCallResolver';
import { scanBridgeContracts, type FlowBridgeEntryModule } from '../src/backend/flowBridges';

// FLOW-010(旧 KFLOW-CORE-10)引擎回调与异步续段钉。
// 验收:创建实体、数据库返回、timer 等以契约关联请求和回调;回调未可确定
// 绑定时保留断点与原因。

const BASE_AVATAR = '/ws/scripts/base/Avatar.py';
const CELL_AVATAR = '/ws/scripts/cell/Avatar.py';

const BASE_TEXT = [
  'class Avatar:',
  '    def onTimer(self, timerID, userArg):',
  '        pass',
  '',
  '    def onSaved(self, success, baseEntity):',
  '        pass',
  '',
  '    def startHeartbeat(self):',
  '        self.addTimer(1.0, 1.0, 0)',
  '',
  '    def save(self):',
  '        self.writeToDB(self.onSaved)',
  '',
  '    def load(self):',
  "        KBEngine.createEntityFromDBID('Avatar', 42, onLoaded)",
  '',
  '    def rawQuery(self):',
  "        KBEngine.executeRawDatabaseCommand('SELECT 1', None)",
  '',
  '    def badSave(self):',
  '        self.writeToDB(lambda e: e)',
  '',
  '    def ghostSave(self):',
  '        self.writeToDB(self.onGhost)',
  '',
  '    def multilineSave(self):',
  '        self.writeToDB(',
  '            self.onSaved',
  '        )'
].join('\n');

const CELL_TEXT = [
  'class Avatar:',
  '    def spawn(self):',
  '        KBEngine.createEntityLocally("Monster")'
].join('\n');

const TEXTS: Record<string, string> = {
  [BASE_AVATAR]: BASE_TEXT,
  [CELL_AVATAR]: CELL_TEXT
};

/** 类方法表:Avatar.onTimer/onSaved 已定义;onGhost 未定义 */
const CLASS_METHODS: Record<string, { filePath: string; line: number }> = {
  'Avatar\u001fonTimer': { filePath: BASE_AVATAR, line: 1 },
  'Avatar\u001fonSaved': { filePath: BASE_AVATAR, line: 4 },
  'Avatar\u001fonLoaded': { filePath: BASE_AVATAR, line: 99 }
};

const input = (overrides: Partial<FlowContinuationInput> = {}): FlowContinuationInput => ({
  rootKey: '/ws',
  files: Object.keys(TEXTS),
  resolveFile: filePath => {
    const text = TEXTS[filePath];
    if (text === undefined) {
      return null;
    }
    return resolveFlowCallSites({ text, filePath, rootKey: '/ws' });
  },
  // 解析层 callSite.line 是 0 基(仓内工作区口径),助手按同口径取行
  lineTextAt: (filePath, line) => TEXTS[filePath].split('\n')[line] ?? '',
  resolveModuleFunction: name => (name === 'onLoaded' ? { filePath: BASE_AVATAR, line: 16 } : null),
  resolveClassMethod: (className, methodName) =>
    CLASS_METHODS[`${className}\u001f${methodName}`] ?? null,
  ...overrides
});

describe('FLOW-010 契约登记', () => {
  it('异步契约逐条带源锚:模块 10 条/实体 2 条;同步面单列不声称', () => {
    expect(ASYNC_MODULE_APIS).toHaveLength(10);
    expect(ASYNC_ENTITY_APIS).toHaveLength(2);
    for (const contract of [...ASYNC_MODULE_APIS, ...ASYNC_ENTITY_APIS]) {
      expect(contract.trigger).toMatch(/\.cpp|\.h/);
    }
    const timerEntity = ASYNC_ENTITY_APIS.find(api => api.apiName === 'addTimer');
    expect(timerEntity?.continuationMethod).toBe('onTimer');
    expect(timerEntity?.callbackIndex).toBeNull();
    expect(SYNC_MODULE_APIS).toEqual(['createEntity', 'createEntityLocally']);
  });

  it('实参提取:顶层逗号切分、字符串保护、跨行返回 null', () => {
    expect(callArgumentsOnLine("f.createEntityFromDBID('Avatar', 42, onLoaded)", 'createEntityFromDBID')).toEqual([
      "'Avatar'",
      '42',
      'onLoaded'
    ]);
    expect(callArgumentsOnLine('cmd("a, b", x)', 'cmd')).toEqual(['"a, b"', 'x']);
    expect(callArgumentsOnLine('self.writeToDB(', 'writeToDB')).toBeNull();
  });
});

describe('FLOW-010 契约关联', () => {
  it('timer:addTimer→onTimer 固定契约续段(async-callback,engine-callback)', () => {
    const result = linkContinuations(input());
    const link = result.links.find(l => l.kind === 'timer-fixed');
    expect(link).toBeDefined();
    expect(link!.apiName).toBe('addTimer');
    expect(link!.edge.syncAsync).toBe('async-callback');
    expect(link!.edge.messageKind).toBe('engine-callback');
    expect(link!.edge.evidence.type).toBe('declaration-contract');
    expect(link!.edge.evidence.detail).toContain('Avatar.addTimer → onTimer');
    expect(link!.edge.evidence.detail).toContain('entity.cpp:1658-1662');
    expect(link!.edge.callSite?.line).toBe(8);
  });

  it('数据库返回:writeToDB(self.onSaved) → 类方法回调帧', () => {
    const result = linkContinuations(input());
    const link = result.links.find(l => l.kind === 'argument-callback' && l.apiName === 'writeToDB');
    expect(link).toBeDefined();
    expect(link!.edge.evidence.detail).toContain('success, baseEntity');
    expect(link!.edge.evidence.detail).toContain('entity.cpp:1239-1290');
    expect(link!.edge.callSite?.line).toBe(11);
  });

  it('创建实体:createEntityFromDBID 裸名回调 → 同文件模块函数帧', () => {
    const result = linkContinuations(input());
    const link = result.links.find(l => l.apiName === 'createEntityFromDBID');
    expect(link).toBeDefined();
    expect(link!.edge.evidence.detail).toContain('baseRef, databaseID, wasActive');
    expect(link!.edge.evidence.detail).toContain('baseapp.cpp:1088');
    expect(link!.edge.callSite?.line).toBe(14);
  });

  it('同步 createEntityLocally:不声称异步对(零边零断点)', () => {
    const result = linkContinuations(input());
    expect(result.links.find(l => l.apiName === 'createEntityLocally')).toBeUndefined();
    expect(result.breakpoints.find(b => b.detail.includes('createEntityLocally'))).toBeUndefined();
  });
});

describe('FLOW-010 断点与原因', () => {
  it('回调 None/lambda/未定义名/跨行:各自断点落图(unresolved 边带原因)', () => {
    const result = linkContinuations(input());
    const codes = result.breakpoints.map(b => b.code);
    expect(codes).toContain('callback-absent'); // executeRawDatabaseCommand(..., None)
    expect(codes).toContain('lambda-callback'); // writeToDB(lambda …)
    expect(codes).toContain('callback-target-unresolved'); // self.onGhost 未定义
    expect(codes).toContain('multiline-call'); // writeToDB( 跨行
    // 断点全部落图:每条断点带 unresolved 边
    for (const bp of result.breakpoints) {
      expect(bp.edge).not.toBeNull();
      expect(bp.edge!.messageKind).toBe('unresolved');
      expect(bp.edge!.unresolvedReason?.code).toBe('unknown-receiver');
      expect(bp.edge!.evidence.detail).toContain('异步续段断点');
    }
    const absent = result.breakpoints.find(b => b.code === 'callback-absent');
    expect(absent!.detail).toContain('result, rows, insertid, error');
    const ghost = result.breakpoints.find(b => b.code === 'callback-target-unresolved');
    expect(ghost!.detail).toContain('Avatar.onGhost');
    expect(ghost!.callSite?.line).toBe(23);
  });
});

describe('FLOW-010 桥 pairsWith 连线', () => {
  const INTERFACES_ENTRY: FlowBridgeEntryModule = {
    filePath: '/ws/scripts/interface/kbemain.py',
    text: [
      'def onInterfaceAppReady():',
      '    pass',
      '',
      'def onRequestAccountLogin(loginName, password, datas):',
      '    KBEngine.accountLoginResponse(loginName, loginName, datas, 0)',
      '',
      'def onRequestCharge(ordersID, entityDBID, datas):',
      '    pass'
    ].join('\n')
  };

  const bridgeInput = (): FlowContinuationInput => {
    const texts: Record<string, string> = {
      ...TEXTS,
      [INTERFACES_ENTRY.filePath]: INTERFACES_ENTRY.text
    };
    return input({
      files: Object.keys(texts),
      resolveFile: filePath => {
        const text = texts[filePath];
        if (text === undefined) {
          return null;
        }
        return resolveFlowCallSites({ text, filePath, rootKey: '/ws' });
      },
      lineTextAt: (filePath, line) => texts[filePath].split('\n')[line] ?? '',
      bridgeScan: scanBridgeContracts({
        rootKey: '/ws',
        entryModules: { interfaces: INTERFACES_ENTRY }
      })
    });
  };

  it('script-response:请求帧内发现 Response 调用=契约完成;未发现=如实记录', () => {
    const result = linkContinuations(bridgeInput());
    const login = result.scriptResponses.find(r => r.requestCallback === 'onRequestAccountLogin');
    expect(login).toBeDefined();
    expect(login!.completed).toBe(true);
    expect(login!.detail).toContain('契约完成');
    const charge = result.scriptResponses.find(r => r.requestCallback === 'onRequestCharge');
    expect(charge).toBeDefined();
    expect(charge!.completed).toBe(false);
    expect(charge!.detail).toContain('pending 记录悬挂');
  });

  it('db-roundtrip:两侧回调都定义才连;续段缺失=断点', () => {
    const loginappEntry: FlowBridgeEntryModule = {
      filePath: '/ws/scripts/login/kbemain.py',
      text: [
        'def onRequestLogin(loginName, password, clientType, datas):',
        '    return 0',
        '',
        'def onLoginCallbackFromDB(loginName, accountName, errorno, datas):',
        '    pass',
        '',
        'def onRequestCreateAccount(accountName, password, datas):',
        '    return 0'
      ].join('\n')
    };
    const texts: Record<string, string> = {
      ...TEXTS,
      [loginappEntry.filePath]: loginappEntry.text
    };
    const result = linkContinuations(
      input({
        files: Object.keys(texts),
        resolveFile: filePath => {
          const text = texts[filePath];
          if (text === undefined) {
            return null;
          }
          return resolveFlowCallSites({ text, filePath, rootKey: '/ws' });
        },
        lineTextAt: (filePath, line) => texts[filePath].split('\n')[line] ?? '',
        bridgeScan: scanBridgeContracts({
          rootKey: '/ws',
          entryModules: { loginapp: loginappEntry }
        })
      })
    );
    const link = result.links.find(l => l.kind === 'bridge-roundtrip');
    expect(link).toBeDefined();
    expect(link!.apiName).toBe('onRequestLogin');
    expect(link!.edge.evidence.detail).toContain('onRequestLogin → onLoginCallbackFromDB');
    expect(link!.edge.syncAsync).toBe('async-callback');
    // onRequestCreateAccount 的回程 onCreateAccountCallbackFromDB 未定义 → 断点
    const bp = result.breakpoints.find(b => b.code === 'continuation-missing');
    expect(bp).toBeDefined();
    expect(bp!.detail).toContain('onCreateAccountCallbackFromDB');
    expect(bp!.detail).toContain('pending 记录悬挂');
  });
});
