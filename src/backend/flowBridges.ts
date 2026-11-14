/**
 * KFLOW 其他进程桥接契约(FLOW-009,G2 的 loginapp/dbmgr/interfaces/logger
 * 引擎↔脚本桥登记核)。
 *
 * 验收:逐条登记 loginapp/dbmgr/interfaces 等 API 请求/回调桥;machine/logger
 * 等只在有真实业务边时出现,禁止拓扑全连接。
 *
 * 口径:
 *   - 契约出处=仓库知识库(docs/knowledge/api-loginapp-dbmgr-logger.md、
 *     api-interfaces.md;fork 源锚在 trigger 文本里),逐条登记,不凭印象;
 *   - 引擎回调分发在进程**入口模块**(kbengine_defaults.xml entryScriptFile
 *     指向的 module)顶层函数上——类方法/未定义都不满足契约;入口模块未提供
 *     → 该进程无任何边(静默进程如实列出,零伪造拓扑);
 *   - machine 不在本注册表:它不是 PythonApp,无脚本面,不存在可登记桥——
 *     图上永远不会为 machine 造边(拓扑全连接禁止=构造性成立);
 *   - 同名 def 重复:Python 名字绑定取最后一个 def(后者覆盖前者);
 *   - 请求↔续段契约(pairsWith/db 回程/scriptResponse)只登记元数据,请求与
 *     回调的连线归 FLOW-010(协议:async-callback/engine-callback 单列)。
 */

import {
  flowGraphEdge,
  flowGraphNode,
  type FlowGraphEdge,
  type FlowGraphNode,
  type FlowProcessRole
} from './flowGraphModel';

export type FlowBridgeProcess = 'loginapp' | 'dbmgr' | 'interfaces' | 'logger';

/** 请求→续段的契约形态(db 回程回调 / 脚本侧 *Response API) */
export interface FlowBridgeContinuation {
  kind: 'db-roundtrip' | 'script-response';
  /** 续段名:入口模块回调名(interfaces 为 KBEngine 模块 API 名) */
  continuation: string;
}

export interface FlowBridgeCallbackContract {
  process: FlowBridgeProcess;
  callbackName: string;
  params: string[];
  /** 已验证触发点(知识库锚;如实引用,不凭印象) */
  trigger: string;
  /** 引擎仅在入口脚本定义了该回调时才调用(如 onReadyForShutDown 轮询门、
   *  onInterfaceAppShutDown 的 HasAttrString 静默跳过) */
  definedGated?: boolean;
  /** 请求↔续段契约(只登记元数据;连线归 FLOW-010) */
  pairsWith?: FlowBridgeContinuation;
}

/** 脚本→引擎 API 桥(跨进程请求面;回调多为匿名函数,由宿主侧接线) */
export interface FlowBridgeApiContract {
  process: FlowBridgeProcess;
  apiName: string;
  params: string[];
  /** 回调参数形态(空=无回调) */
  callbackParams: string[];
  trigger: string;
}

const LOGINAPP_CALLBACKS: FlowBridgeCallbackContract[] = [
  { process: 'loginapp', callbackName: 'onLoginAppReady', params: [], trigger: 'loginapp.cpp:170-180(Loginapp::initializeEnd 末尾,格式 "")' },
  { process: 'loginapp', callbackName: 'onLoginAppShutDown', params: [], trigger: 'loginapp.cpp:59-62(Loginapp::onShutdownBegin)' },
  {
    process: 'loginapp',
    callbackName: 'onRequestLogin',
    params: ['loginName', 'password', 'clientType', 'datas'],
    trigger: 'loginapp.cpp:1012-1018(Loginapp::login,格式 "ssby#";返回裸错误码或 5 元组)',
    pairsWith: { kind: 'db-roundtrip', continuation: 'onLoginCallbackFromDB' }
  },
  { process: 'loginapp', callbackName: 'onLoginCallbackFromDB', params: ['loginName', 'accountName', 'errorno', 'datas'], trigger: 'loginapp.cpp:1229-1235(pendingLoginMgr_ 记录回收)' },
  {
    process: 'loginapp',
    callbackName: 'onRequestCreateAccount',
    params: ['accountName', 'password', 'datas'],
    trigger: 'loginapp.cpp:367-373(格式 "ssy#";返回裸错误码或 (errorno, accountName, password, datas))',
    pairsWith: { kind: 'db-roundtrip', continuation: 'onCreateAccountCallbackFromDB' }
  },
  { process: 'loginapp', callbackName: 'onCreateAccountCallbackFromDB', params: ['accountName', 'errorno', 'datas'], trigger: 'loginapp.cpp:588-594(pendingCreateMgr_ 记录移除 :609)' }
];

const DBMGR_CALLBACKS: FlowBridgeCallbackContract[] = [
  { process: 'dbmgr', callbackName: 'onDBMgrReady', params: [], trigger: 'dbmgr.cpp:306-313(Dbmgr::initializeEnd)' },
  { process: 'dbmgr', callbackName: 'onDBMgrShutDown', params: [], trigger: 'dbmgr.cpp:153-156(Dbmgr::onShutdownBegin)' },
  { process: 'dbmgr', callbackName: 'onReadyForShutDown', params: [], trigger: 'dbmgr.cpp:77-95(canShutdown 轮询;仅入口脚本定义才调用,须返回 True 才放行退出)', definedGated: true },
  { process: 'dbmgr', callbackName: 'onSelectAccountDBInterface', params: ['accountName'], trigger: 'dbmgr.cpp:1240-1267(返回选择 databaseInterfaces 项;无效回落 "default")' }
];

const DBMGR_APIS: FlowBridgeApiContract[] = [
  {
    process: 'dbmgr',
    apiName: 'executeRawDatabaseCommand',
    params: ['command', 'callback', 'threadID', 'dbInterfaceName'],
    callbackParams: ['result', 'rows', 'insertid', 'error'],
    trigger: 'dbmgr.cpp:355(dbmgr 唯一 app 专有方法;回调经 callback manager 入线程池,:905-908)'
  }
];

const LOGGER_CALLBACKS: FlowBridgeCallbackContract[] = [
  { process: 'logger', callbackName: 'onLoggerAppReady', params: [], trigger: 'logger.cpp:126-135(Logger::initializeEnd)' },
  { process: 'logger', callbackName: 'onLoggerAppShutDown', params: [], trigger: 'logger.cpp:215-218(Logger::onShutdownBegin)' },
  { process: 'logger', callbackName: 'onReadyForShutDown', params: [], trigger: 'logger.cpp:175-192(canShutdown 轮询;仅入口脚本定义才调用,Py_True 门)', definedGated: true },
  { process: 'logger', callbackName: 'onLogWrote', params: ['datas'], trigger: 'logger.cpp:286-316(仅入口脚本定义才调用;返回 False 撤持久化、str 改写持久行)', definedGated: true }
];

const INTERFACES_CALLBACKS: FlowBridgeCallbackContract[] = [
  { process: 'interfaces', callbackName: 'onInterfaceAppReady', params: [], trigger: 'interfaces.cpp:151-158(Interfaces::initializeEnd)' },
  { process: 'interfaces', callbackName: 'onInterfaceAppShutDown', params: [], trigger: 'interfaces.cpp:73-80(HasAttrString 守卫:入口脚本未定义则静默跳过)', definedGated: true },
  {
    process: 'interfaces',
    callbackName: 'onRequestCreateAccount',
    params: ['registerName', 'password', 'datas'],
    trigger: 'interfaces.cpp:488-533(dbmgr 转发注册请求,格式 "ssy#";同名在途静默忽略)',
    pairsWith: { kind: 'script-response', continuation: 'createAccountResponse' }
  },
  {
    process: 'interfaces',
    callbackName: 'onRequestAccountLogin',
    params: ['loginName', 'password', 'datas'],
    trigger: 'interfaces.cpp:605-650(dbmgr→interfaces 登录校验,格式 "ssy#";同名在途静默忽略)',
    pairsWith: { kind: 'script-response', continuation: 'accountLoginResponse' }
  },
  {
    process: 'interfaces',
    callbackName: 'onRequestCharge',
    params: ['ordersID', 'entityDBID', 'datas'],
    trigger: 'interfaces.cpp:717-763(baseapp KBEngine.charge 经 dbmgr 转发,格式 "sKy#";重复订单 ERROR_MSG)',
    pairsWith: { kind: 'script-response', continuation: 'chargeResponse' }
  }
];

const INTERFACES_APIS: FlowBridgeApiContract[] = [
  { process: 'interfaces', apiName: 'accountLoginResponse', params: ['commitName', 'realAccountName', 'extraDatas', 'errorCode'], callbackParams: [], trigger: 'api-interfaces.md §2(realAccountName 别名映射;errorCode=SERVER_SUCCESS 放行)' },
  { process: 'interfaces', apiName: 'createAccountResponse', params: ['commitName', 'realAccountName', 'extraDatas', 'errorCode'], callbackParams: [], trigger: 'api-interfaces.md §2(完成注册 pending 记录)' },
  { process: 'interfaces', apiName: 'chargeResponse', params: ['orderID', 'extraDatas', 'errorCode'], callbackParams: [], trigger: 'api-interfaces.md §2(完成订单 pending 记录)' }
];

/** 全量桥契约登记册(loginapp 6/dbmgr 4/logger 4/interfaces 5;machine 无契约) */
export const BRIDGE_CALLBACK_CONTRACTS: readonly FlowBridgeCallbackContract[] = [
  ...LOGINAPP_CALLBACKS,
  ...DBMGR_CALLBACKS,
  ...LOGGER_CALLBACKS,
  ...INTERFACES_CALLBACKS
];

/** 脚本→引擎 API 桥(dbmgr 1/interfaces 3) */
export const BRIDGE_API_CONTRACTS: readonly FlowBridgeApiContract[] = [
  ...DBMGR_APIS,
  ...INTERFACES_APIS
];

const PROCESS_ROLE: Record<FlowBridgeProcess, FlowProcessRole> = {
  loginapp: 'bridge:loginapp',
  dbmgr: 'bridge:dbmgr',
  interfaces: 'bridge:interfaces',
  logger: 'bridge:other'
};

const roleFor = (process: FlowBridgeProcess): FlowProcessRole => PROCESS_ROLE[process];

export interface FlowBridgeEntryModule {
  filePath: string;
  text: string;
}

export interface FlowBridgeScanInput {
  rootKey: string;
  /** 部署侧提供的入口模块(fork 仓库不带 login/db/logger 入口脚本——缺位=
   *  该进程无任何边,不伪造拓扑) */
  entryModules?: Partial<Record<FlowBridgeProcess, FlowBridgeEntryModule>>;
}

/** 已定义回调的引擎→脚本入口绑定(两段:external-entry → 脚本回调帧) */
export interface FlowBridgeBinding {
  process: FlowBridgeProcess;
  callbackName: string;
  contract: FlowBridgeCallbackContract;
  /** external-entry 节点(无 fn——引擎侧不是 Python 函数) */
  entryNode: FlowGraphNode;
  /** 脚本回调帧(入口模块顶层 def,fn 真实) */
  handlerNode: FlowGraphNode;
  /** 引擎→脚本边(messageKind engine-callback;异步对=async-callback) */
  entryEdge: FlowGraphEdge;
}

export interface FlowBridgeScanResult {
  bindings: FlowBridgeBinding[];
  /** 契约存在但入口模块未定义(如实列出,零边) */
  undefinedCallbacks: Array<{
    process: FlowBridgeProcess;
    callbackName: string;
    reason: string;
  }>;
  /** 提供了入口模块的进程(仅这些进程可能出现) */
  activeProcesses: FlowBridgeProcess[];
  /** 有契约但未提供入口模块的进程(零边,如实列出) */
  silentProcesses: FlowBridgeProcess[];
}

/** 入口模块顶层 def 行(1 基);同名重复取最后一个 def(Python 名字绑定) */
const moduleLevelDefLines = (text: string, name: string): number[] => {
  const lines = text.split('\n');
  const found: number[] = [];
  const pattern = new RegExp(`^def\\s+${name}\\s*\\(`);
  lines.forEach((line, index) => {
    if (pattern.test(line)) {
      found.push(index + 1);
    }
  });
  return found;
};

export function scanBridgeContracts(input: FlowBridgeScanInput): FlowBridgeScanResult {
  const bindings: FlowBridgeBinding[] = [];
  const undefinedCallbacks: FlowBridgeScanResult['undefinedCallbacks'] = [];
  const activeProcesses: FlowBridgeProcess[] = [];
  const silentProcesses: FlowBridgeProcess[] = [];
  const processes: FlowBridgeProcess[] = ['loginapp', 'dbmgr', 'interfaces', 'logger'];

  for (const process of processes) {
    const module = input.entryModules?.[process];
    const contracts = BRIDGE_CALLBACK_CONTRACTS.filter(contract => contract.process === process);
    if (!module) {
      silentProcesses.push(process);
      continue;
    }
    activeProcesses.push(process);
    for (const contract of contracts) {
      const defLines = moduleLevelDefLines(module.text, contract.callbackName);
      if (defLines.length === 0) {
        undefinedCallbacks.push({
          process,
          callbackName: contract.callbackName,
          reason: contract.definedGated
            ? `入口模块未定义(引擎门控:仅定义才调用——${contract.trigger})`
            : `入口模块未定义(引擎调用将 traceback 后继续——${contract.trigger})`
        });
        continue;
      }
      const defLine = defLines[defLines.length - 1]; // Python 名字绑定:后者覆盖
      const defText = module.text.split('\n')[defLine - 1].trim();
      const entryNode = flowGraphNode({
        rootKey: input.rootKey,
        role: roleFor(process),
        kind: 'external-entry',
        label: `外部入口:引擎回调 ${contract.callbackName}(${process};${contract.trigger})`
      });
      const handlerNode = flowGraphNode({
        rootKey: input.rootKey,
        role: roleFor(process),
        kind: 'function',
        fn: { name: contract.callbackName, filePath: module.filePath, signature: defText },
        declaration: { file: module.filePath, line: defLine, character: 0 },
        label: `桥接回调帧 ${contract.callbackName}(${process} 入口模块)`
      });
      const entryEdge = flowGraphEdge({
        fromNodeId: entryNode.id,
        toNodeId: handlerNode.id,
        callSite: null,
        direction: {
          fromRole: roleFor(process),
          toRole: roleFor(process),
          kind: 'downstream-call'
        },
        syncAsync: contract.pairsWith ? 'async-callback' : 'sync',
        messageKind: 'engine-callback',
        evidence: {
          type: 'declaration-contract',
          detail: `引擎契约 ${contract.trigger};入口模块 ${module.filePath}:${defLine} def 已定义`
        }
      });
      bindings.push({ process, callbackName: contract.callbackName, contract, entryNode, handlerNode, entryEdge });
    }
  }
  return { bindings, undefinedCallbacks, activeProcesses, silentProcesses };
}
