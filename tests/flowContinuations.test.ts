import { describe, expect, it } from 'vitest';
import {
  ASYNC_ENTITY_APIS,
  ASYNC_MODULE_APIS,
  SYNC_MODULE_APIS,
  callArgumentsOnLine,
  linkContinuations,
  type FlowContinuationInput
} from '../src/backend/flowContinuations';
import { resolveFlowCallSites, type FlowCallResolverResult } from '../src/backend/flowCallResolver';
import { scanBridgeContracts, type FlowBridgeEntryModule } from '../src/backend/flowBridges';
import { flowGraphEdge, flowGraphNode, type FlowGraphEdge } from '../src/backend/flowGraphModel';

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

// ---------------------------------------------------------------------------
// COV-98-TS-BACKEND 批 9:模块/实体两 lane 的断点族臂(跨行/lambda/裸名
// 未解析/属性形态不可证)、本地函数帧优先位、帧缓存命中、无类身份位、
// 桥 handler 模块不可解析位与 resolveFile 容错。
// 死码:449(实体契约表内 callbackIndex=null 与 continuationMethod=null
// 不同时成立——addTimer 走固定续段分支,writeToDB 有实参位)。
// ---------------------------------------------------------------------------

describe('FLOW-010 sweep: 模块面断点族与本地函数帧', () => {
  const SWEEP_FILE = '/ws/scripts/base/Sweep.py';
  const sweepRun = (
    text: string,
    opts: {
      classMethods?: Record<string, { filePath: string; line: number }>;
      extraFiles?: string[];
      resolveFile?: FlowContinuationInput['resolveFile'];
    } = {}
  ) =>
    linkContinuations(
      input({
        files: opts.extraFiles ? [SWEEP_FILE, ...opts.extraFiles] : [SWEEP_FILE],
        resolveFile: opts.resolveFile
          ? opts.resolveFile
          : filePath => {
              if (filePath !== SWEEP_FILE) {
                return null; // 文件在列但不可解析:如实跳过
              }
              return resolveFlowCallSites({ text, filePath, rootKey: '/ws' });
            },
        lineTextAt: (filePath, line) =>
          filePath === SWEEP_FILE ? text.split('\n')[line] ?? '' : '',
        resolveModuleFunction: () => null,
        resolveClassMethod: (className, methodName) =>
          opts.classMethods?.[`${className}\u001f${methodName}`] ?? null
      })
    );

  it('同文件模块函数帧优先 + 跨行/lambda/裸名未解析断点族', () => {
    const text = [
      'def onDbLoaded(baseRef, databaseID, wasActive):',
      '    pass',
      '',
      'def fire():',
      '    onDbLoaded(None, 1, False)',
      '',
      'class Sweep:',
      '    def load(self):',
      "        KBEngine.createEntityFromDBID('Avatar', 42, onDbLoaded)",
      "        KBEngine.executeRawDatabaseCommand('SELECT 1', lambda r: r)",
      "        KBEngine.executeRawDatabaseCommand('SELECT 1', onGhost2)",
      '',
      '    def rawMulti(self):',
      '        KBEngine.executeRawDatabaseCommand(',
      "            'SELECT 1', None)",
      ''
    ].join('\n');
    const result = sweepRun(text);
    // 本地函数帧:onDbLoaded 是本文件模块函数节点,直连不落断点
    const link = result.links.find(l => l.apiName === 'createEntityFromDBID');
    expect(link).toBeDefined();
    const codes = result.breakpoints.map(b => b.code);
    expect(codes).toContain('lambda-callback');
    expect(codes).toContain('callback-target-unresolved');
    expect(codes).toContain('multiline-call');
  });

  it('callArgumentsOnLine:调用名不在行 → null', () => {
    expect(callArgumentsOnLine('self.save()', 'writeToDB')).toBeNull();
  });

  it('文件在列但 resolveFile 不可解析:如实跳过(零产出不猜)', () => {
    const result = sweepRun('def f():\n    pass\n', { extraFiles: ['/ws/ghost.py'] });
    expect(result.links).toHaveLength(0);
    expect(result.breakpoints).toHaveLength(0);
  });

  it('帧缓存:同目标两次回调共用一帧(第二次命中缓存)', () => {
    const text = [
      'class Sweep:',
      '    def saveA(self):',
      '        self.writeToDB(self.onSaved)',
      '',
      '    def saveB(self):',
      '        self.writeToDB(self.onSaved)',
      ''
    ].join('\n');
    const result = sweepRun(text, {
      classMethods: { 'Sweep\u001fonSaved': { filePath: SWEEP_FILE, line: 1 } }
    });
    const saved = result.links.filter(l => l.apiName === 'writeToDB');
    expect(saved).toHaveLength(2);
    expect(new Set(saved.map(l => l.toNodeId)).size).toBe(1);
  });
});

describe('FLOW-010 sweep: 实体面与桥面容错臂', () => {
  const SWEEP_FILE = '/ws/scripts/base/Sweep.py';
  const sweepRun = (
    text: string,
    classMethods: Record<string, { filePath: string; line: number }> = {},
    extra: Partial<FlowContinuationInput> = {}
  ) =>
    linkContinuations(
      input({
        files: [SWEEP_FILE],
        resolveFile: filePath =>
          filePath === SWEEP_FILE
            ? resolveFlowCallSites({ text, filePath, rootKey: '/ws' })
            : null,
        lineTextAt: (filePath, line) =>
          filePath === SWEEP_FILE ? text.split('\n')[line] ?? '' : '',
        resolveModuleFunction: () => null,
        resolveClassMethod: (className, methodName) =>
          classMethods[`${className}\u001f${methodName}`] ?? null,
        ...extra
      })
    );

  it('实体面断点族:固定续段缺失/None 回调/属性形态不可证/非契约 self 调用', () => {
    const text = [
      'class Timerless:',
      '    def go(self):',
      '        self.addTimer(1.0, 1.0, 0)',
      '',
      'class Sweep:',
      '    def tick(self):',
      '        self.tick2()',
      '',
      '    def saveNone(self):',
      '        self.writeToDB(None)',
      '',
      '    def saveAttr(self):',
      '        self.writeToDB(self.inner.onDone)',
      ''
    ].join('\n');
    const result = sweepRun(text);
    const codes = result.breakpoints.map(b => b.code);
    expect(codes).toContain('continuation-missing'); // Timerless 无 onTimer
    expect(codes).toContain('callback-absent'); // writeToDB(None)
    expect(codes).toContain('callback-target-unprovable'); // self.inner.onDone 属性形态
    // self.tick2 非契约 API:零边零断点(诚实边界)
    expect(
      result.breakpoints.some(b => b.detail.includes('self.tick2'))
    ).toBe(false);
    expect(result.links.some(l => l.apiName === 'tick2')).toBe(false);
  });

  it('模块级 self 调用:所在帧无类身份,固定续段/回调绑定均不可证', () => {
    const text = [
      'self.writeToDB(self.onSaved)',
      'self.addTimer(1.0, 1.0, 0)',
      ''
    ].join('\n');
    const result = sweepRun(text);
    const unprovable = result.breakpoints.filter(b => b.code === 'callback-target-unprovable');
    expect(unprovable).toHaveLength(2); // 实参面 + 固定续段(onTimer)面
    expect(unprovable.some(bp => bp.detail.includes('onTimer 续段不可证'))).toBe(true);
    expect(unprovable.some(bp => bp.detail.includes('回调绑定不可证'))).toBe(true);
  });

  it('桥 handler 模块不可解析:pending-record-uncompleted 断点', () => {
    const absentEntry: FlowBridgeEntryModule = {
      filePath: '/ws/scripts/interface/absent.py',
      text: [
        'def onInterfaceAppReady():',
        '    pass',
        '',
        'def onRequestAccountLogin(loginName, password, datas):',
        '    KBEngine.accountLoginResponse(loginName, loginName, datas, 0)',
        ''
      ].join('\n')
    };
    const text = 'def f():\n    pass\n';
    const result = sweepRun(text, {}, {
      bridgeScan: scanBridgeContracts({
        rootKey: '/ws',
        entryModules: { interfaces: absentEntry }
      })
    });
    const bp = result.breakpoints.find(b => b.code === 'pending-record-uncompleted');
    expect(bp).toBeDefined();
    expect(bp!.detail).toContain('入口模块不可解析');
  });

  it('callSite 缺位的边:跳过不产断点(接口防御面)', () => {
    const text = [
      'def go():',
      "    KBEngine.createEntityFromDBID('Avatar', 42, onLoaded)",
      ''
    ].join('\n');
    const base = resolveFlowCallSites({ text, filePath: SWEEP_FILE, rootKey: '/ws' });
    const result = linkContinuations(
      input({
        files: [SWEEP_FILE],
        resolveFile: filePath =>
          filePath === SWEEP_FILE
            ? {
                nodes: base.nodes,
                edges: [...base.edges, { ...base.edges[0], callSite: null }]
              }
            : null,
        lineTextAt: (filePath, line) =>
          filePath === SWEEP_FILE ? text.split('\n')[line] ?? '' : '',
        resolveModuleFunction: name =>
          name === 'onLoaded' ? { filePath: SWEEP_FILE, line: 0 } : null,
        resolveClassMethod: () => null
      })
    );
    // 真边照连一条;callSite 缺位的复制边被跳过,不产第二条也不产断点
    expect(result.links.filter(l => l.apiName === 'createEntityFromDBID')).toHaveLength(1);
  });
});


// ---------------------------------------------------------------------------
// 覆盖批5:callArgumentsOnLine 缺名行 / 帧缓存复用 / 文件缺位与边守卫 /
// 模块 API 同文件模块函数·lambda·跨行·双不可证 / 实体缺类身份与兜底形态 /
// 非契约 self 调用零产出 / 桥入口模块不可解析。诚实边界:实体
// callbackIndex===null 实参臂(448-450)按现行契约表不可达——callbackIndex
// 为 null 的实体 API 只有 addTimer,必带 continuationMethod 走固定续段
// 车道,不硬凑。
// ---------------------------------------------------------------------------

describe('FLOW-010 断点与原因(覆盖批5边界)', () => {
  const API_FILE = '/ws/scripts/base/Carrier.py';
  const WATCHER_FILE = '/ws/scripts/base/Watcher.py';

  const API_TEXT = [
    'def onUrlopenDone(httpcode, data, headers, success, url):',
    '    pass',
    '',
    'class Avatar:',
    '    def finish(self):',
    "        KBEngine.urlopen('http://x', onUrlopenDone)",
    '',
    '    def ghost(self):',
    "        KBEngine.urlopen('http://x', ghostHandler)",
    '',
    '    def weird(self):',
    "        KBEngine.urlopen('http://x', self.onTimer)",
    '',
    '    def inline(self):',
    "        KBEngine.urlopen('http://x', lambda hc, d, h, s, u: None)",
    '',
    '    def late(self):',
    '        KBEngine.urlopen(',
    "            'http://x',",
    '            onUrlopenDone',
    '        )',
    '',
    '    def twice(self):',
    "        KBEngine.urlopen('http://x', done)",
    '',
    '    def again(self):',
    "        KBEngine.urlopen('http://x', done)",
    '',
    '    def ordinary(self):',
    '        self.plainHelper()',
    '',
    '    def drop(self):',
    '        self.writeToDB(None)',
    '',
    '    def opaque(self):',
    '        self.writeToDB(handleResult)',
    '',
    'def warmup():',
    '    onUrlopenDone(200, "", {}, True, "http://x")'
  ].join('\n');

  const WATCHER_TEXT = [
    'class Watcher:',
    '    def arm(self):',
    '        self.addTimer(0.1, 0.1, 0)'
  ].join('\n');

  const TEXTS5: Record<string, string> = {
    [API_FILE]: API_TEXT,
    [WATCHER_FILE]: WATCHER_TEXT
  };

  const apiInput = (overrides: Partial<FlowContinuationInput> = {}): FlowContinuationInput => ({
    rootKey: '/ws',
    files: Object.keys(TEXTS5),
    resolveFile: filePath => {
      const text = TEXTS5[filePath];
      if (text === undefined) {
        return null;
      }
      return resolveFlowCallSites({ text, filePath, rootKey: '/ws' });
    },
    lineTextAt: (filePath, line) => TEXTS5[filePath]?.split('\n')[line] ?? '',
    resolveModuleFunction: name => (name === 'done' ? { filePath: API_FILE, line: 99 } : null),
    // 本 describe 专表:类方法解析一律缺位(Watcher.onTimer 未定义 → 续段断点)
    resolveClassMethod: () => null,
    ...overrides
  });

  it('callArgumentsOnLine:行内无 API 名 → null(不猜)', () => {
    expect(callArgumentsOnLine('        pass', 'urlopen')).toBeNull();
    expect(callArgumentsOnLine('log("urlopen (quoted)", )', 'urlopen')).toBeNull();
  });

  it('裸名回调同文件模块函数:链接到解析图既有函数帧', () => {
    const result = linkContinuations(apiInput());
    const fileResult = resolveFlowCallSites({ text: API_TEXT, filePath: API_FILE, rootKey: '/ws' });
    const fnNode = fileResult.nodes.find(node => node.fn?.name === 'onUrlopenDone');
    expect(fnNode).toBeDefined();
    const link = result.links.find(l => l.apiName === 'urlopen' && l.toNodeId === fnNode!.id);
    expect(link).toBeDefined();
    expect(link!.edge.evidence.detail).toContain('httpcode, data, headers, success, url');
    expect(link!.edge.callSite?.line).toBe(5);
  });

  it('外部模块函数两次调用共帧:帧节点缓存复用同 id', () => {
    const result = linkContinuations(apiInput());
    const all = result.links.filter(l => l.apiName === 'urlopen');
    expect(all).toHaveLength(3);
    const doneLinks = all.filter(l => l.edge.callSite?.line === 23 || l.edge.callSite?.line === 26);
    expect(doneLinks).toHaveLength(2);
    expect(doneLinks[0].toNodeId).toBe(doneLinks[1].toNodeId);
    expect(doneLinks[0].toNodeId).toContain(`${API_FILE}#done`);
  });

  it('裸名不可证/表达式形态:unresolved 与 unprovable 各自断点落位', () => {
    const result = linkContinuations(apiInput());
    const ghost = result.breakpoints.find(b => b.code === 'callback-target-unresolved');
    expect(ghost).toBeDefined();
    expect(ghost!.detail).toContain('ghostHandler');
    expect(ghost!.callSite?.line).toBe(8);
    const weird = result.breakpoints.find(
      b => b.code === 'callback-target-unprovable' && b.detail.includes('self.onTimer')
    );
    expect(weird).toBeDefined();
    expect(weird!.callSite?.line).toBe(11);
  });

  it('内联 lambda / 跨行调用:模块 API 侧断点保留原因', () => {
    const result = linkContinuations(apiInput());
    const lambda = result.breakpoints.find(b => b.code === 'lambda-callback');
    expect(lambda).toBeDefined();
    expect(lambda!.detail).toContain('urlopen');
    expect(lambda!.callSite?.line).toBe(14);
    const late = result.breakpoints.find(b => b.code === 'multiline-call');
    expect(late).toBeDefined();
    expect(late!.detail).toContain('urlopen');
    expect(late!.callSite?.line).toBe(17);
  });

  it('非契约 self 调用零产出;实体回调缺位 None;兜底形态不可证', () => {
    const result = linkContinuations(apiInput());
    expect(JSON.stringify(result)).not.toContain('plainHelper');
    const absent = result.breakpoints.find(
      b => b.code === 'callback-absent' && b.detail.includes('writeToDB')
    );
    expect(absent).toBeDefined();
    expect(absent!.detail).toContain('success, baseEntity');
    expect(absent!.callSite?.line).toBe(32);
    const opaque = result.breakpoints.find(b => b.detail.includes('handleResult'));
    expect(opaque).toBeDefined();
    expect(opaque!.code).toBe('callback-target-unprovable');
    expect(opaque!.callSite?.line).toBe(35);
  });

  it('契约续段未定义:onTimer 缺类表 → continuation-missing 断点', () => {
    const result = linkContinuations(apiInput());
    const missing = result.breakpoints.find(b => b.code === 'continuation-missing');
    expect(missing).toBeDefined();
    expect(missing!.detail).toContain('Watcher');
    expect(missing!.detail).toContain('onTimer');
    expect(missing!.callSite?.line).toBe(2);
  });

  it('resolveFile 缺位文件跳过不误连', () => {
    const baseline = linkContinuations(apiInput());
    const ghosted = linkContinuations(
      apiInput({ files: [...Object.keys(TEXTS5), '/ws/scripts/base/Ghost.py'] })
    );
    expect(ghosted.links).toHaveLength(baseline.links.length);
    expect(ghosted.breakpoints).toHaveLength(baseline.breakpoints.length);
  });

  it('无类身份帧的实体契约:固定续段与回调绑定各自如实断点;非语法锚边/非契约调用零产出', () => {
    const caller = flowGraphNode({
      rootKey: '/ws',
      role: 'unknown',
      kind: 'function',
      fn: { name: 'loose', filePath: '/ws/scripts/base/loose.py', signature: 'def loose' },
      declaration: { file: '/ws/scripts/base/loose.py', line: 0, character: 0 },
      label: '候选帧 loose'
    });
    const anchoredEdge = (calleeRef: string, line: number): FlowGraphEdge =>
      flowGraphEdge({
        fromNodeId: caller.id,
        toNodeId: caller.id,
        callSite: { file: '/ws/scripts/base/loose.py', line, character: 8 },
        direction: { fromRole: 'unknown', toRole: 'unknown', kind: 'downstream-call' },
        syncAsync: 'sync',
        messageKind: 'local-call',
        evidence: { type: 'syntax-anchor', detail: calleeRef }
      });
    const fabricated: FlowCallResolverResult = {
      nodes: [caller],
      edges: [
        flowGraphEdge({
          fromNodeId: caller.id,
          toNodeId: caller.id,
          direction: { fromRole: 'unknown', toRole: 'unknown', kind: 'downstream-call' },
          syncAsync: 'sync',
          messageKind: 'local-call',
          evidence: { type: 'declaration-contract', detail: 'engine-side note' }
        }),
        anchoredEdge('self.plainCall', 1),
        anchoredEdge('self.addTimer', 2),
        anchoredEdge('self.writeToDB', 3)
      ]
    };
    const result = linkContinuations(
      apiInput({
        files: ['/ws/scripts/base/loose.py'],
        resolveFile: filePath =>
          filePath === '/ws/scripts/base/loose.py' ? fabricated : null,
        lineTextAt: () => ''
      })
    );
    expect(result.links).toHaveLength(0);
    expect(result.breakpoints.map(b => b.code)).toEqual([
      'callback-target-unprovable',
      'callback-target-unprovable'
    ]);
    expect(result.breakpoints[0].detail).toContain('onTimer 续段不可证');
    expect(result.breakpoints[0].callSite?.line).toBe(2);
    expect(result.breakpoints[1].detail).toContain('回调绑定不可证');
    expect(result.breakpoints[1].callSite?.line).toBe(3);
  });

  it('桥 script-response 入口模块不可解析:pending-record 断点(记录面)', () => {
    const ORPHAN: FlowBridgeEntryModule = {
      filePath: '/ws/scripts/interface/orphan_kbemain.py',
      text: [
        'def onRequestAccountLogin(loginName, password, datas):',
        '    pass'
      ].join('\n')
    };
    const result = linkContinuations(
      apiInput({
        bridgeScan: scanBridgeContracts({
          rootKey: '/ws',
          entryModules: { interfaces: ORPHAN }
        })
      })
    );
    expect(result.scriptResponses).toHaveLength(0);
    const pending = result.breakpoints.filter(b => b.code === 'pending-record-uncompleted');
    expect(pending).toHaveLength(1);
    expect(pending[0].detail).toContain('入口模块不可解析');
    expect(pending[0].callSite).toBeNull();
    expect(pending[0].edge).not.toBeNull();
  });
});
