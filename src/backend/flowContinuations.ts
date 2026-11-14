/**
 * KFLOW 引擎回调与异步续段(FLOW-010,G2 的请求↔回调契约关联核)。
 *
 * 验收:创建实体、数据库返回、timer 等以契约关联请求和回调;回调未可确定
 * 绑定时保留断点与原因。
 *
 * 口径:
 *   - 三族契约逐条登记(trigger 带 fork 源锚,出处 docs/knowledge/api-baseapp.md
 *     /api-baseapp-entity.md/api-cellapp.md/api-loginapp-dbmgr-logger.md):
 *     ① KBEngine 模块异步 API(callback 实参,创建实体/数据库返回/urlopen/
 *     timer);② 实体方法(writeToDB 回调、addTimer→onTimer 固定契约续段);
 *     ③ FLOW-009 桥 pairsWith(loginapp db 回程、interfaces 脚本 Response);
 *   - callSite 发现:逐文件解析图里 calleeRef 形如 KBEngine.<api>/self.<api>
 *     的语法锚边(契约 API 在脚本侧被覆盖定义时是用户代码,不入契约面);
 *   - callback 实参提取:调用点单行内平衡括号+顶层逗号切分;跨行调用不解析
 *     → 断点 multiline-call(如实,不猜);
 *   - 绑定目标:裸名→同文件模块函数节点/宿主解析(跨文件);self.<m>→类方法
 *     解析;lambda→断点(内联无帧);None/缺位→断点;其余表达式→断点
 *     callback-target-unprovable;
 *   - 同步面不声称:createEntity/createEntityLocally 直接返回实体无回调,
 *     不产任何续段边;
 *   - 断点全部落图(fromNode→unresolved 节点带原因码),不是只进清单。
 */

import {
  flowGraphEdge,
  flowGraphNode,
  type FlowGraphEdge,
  type FlowGraphNode,
  type FlowSourceLocation
} from './flowGraphModel';
import type { FlowCallResolverResult } from './flowCallResolver';
import type { FlowBridgeScanResult } from './flowBridges';

/** 异步 API 契约(callback 实参索引;callbackIndex=null=固定契约续段) */
export interface FlowAsyncApiContract {
  receiver: 'module' | 'entity';
  apiName: string;
  callbackIndex: number | null;
  callbackParams: string[];
  /** 固定契约续段方法名(addTimer→onTimer) */
  continuationMethod?: string;
  trigger: string;
}

export const ASYNC_MODULE_APIS: readonly FlowAsyncApiContract[] = [
  { receiver: 'module', apiName: 'addTimer', callbackIndex: 2, callbackParams: [], trigger: 'python_app.cpp:721-753(__py_addTimer "ffO":回调实参必需,3.7 材料的 None 默认是偏差 D1)' },
  { receiver: 'module', apiName: 'createEntityAnywhere', callbackIndex: 2, callbackParams: ['entityCall'], trigger: 'baseapp.cpp:986(baseappmgr 择 app;回调经 onCreateEntityAnywhereCallback)' },
  { receiver: 'module', apiName: 'createEntityRemotely', callbackIndex: 3, callbackParams: ['entityCall'], trigger: 'baseapp.cpp:1028(钉 baseMB 所有者)' },
  { receiver: 'module', apiName: 'createEntityFromDBID', callbackIndex: 2, callbackParams: ['baseRef', 'databaseID', 'wasActive'], trigger: 'baseapp.cpp:1088(实体已检出→回调收既有引用;失败 (None, 0, False))' },
  { receiver: 'module', apiName: 'createEntityAnywhereFromDBID', callbackIndex: 2, callbackParams: ['baseRef', 'databaseID', 'wasActive'], trigger: 'baseapp.cpp:1440(baseappmgr 择 app)' },
  { receiver: 'module', apiName: 'createEntityRemotelyFromDBID', callbackIndex: 3, callbackParams: ['baseRef', 'databaseID', 'wasActive'], trigger: 'baseapp.cpp:1966(钉 baseMB 所有者)' },
  { receiver: 'module', apiName: 'deleteEntityByDBID', callbackIndex: 2, callbackParams: ['result'], trigger: 'baseapp.cpp:5189(检出中→删除失败回调收 entityCall;否则 True)' },
  { receiver: 'module', apiName: 'lookUpEntityByDBID', callbackIndex: 2, callbackParams: ['result'], trigger: 'baseapp.cpp:5361(未检出 True/检出中 entityCall)' },
  { receiver: 'module', apiName: 'executeRawDatabaseCommand', callbackIndex: 1, callbackParams: ['result', 'rows', 'insertid', 'error'], trigger: 'dbmgr.cpp:355(baseapp 转发经 dbmgr 线程池;回调经 callback manager 回投)' },
  { receiver: 'module', apiName: 'urlopen', callbackIndex: 1, callbackParams: ['httpcode', 'data', 'headers', 'success', 'url'], trigger: 'pyurl.cpp:69+(五参回调)' }
];

export const ASYNC_ENTITY_APIS: readonly FlowAsyncApiContract[] = [
  { receiver: 'entity', apiName: 'writeToDB', callbackIndex: 0, callbackParams: ['success', 'baseEntity'], trigger: 'entity.cpp:1239-1290(dbmgr 写完成后回调)' },
  {
    receiver: 'entity',
    apiName: 'addTimer',
    callbackIndex: null,
    callbackParams: ['timerID', 'userArg'],
    continuationMethod: 'onTimer',
    trigger: 'entity_macro.h:1387+entity.cpp:1658-1662(每次触发调 entity.onTimer(timerID, userArg);第三参是 int userArg 非回调)'
  }
];

/** 同步面(直接返回实体,无回调):不声称异步对,零边 */
export const SYNC_MODULE_APIS: readonly string[] = ['createEntity', 'createEntityLocally'];

export type FlowContinuationBreakpointCode =
  | 'lambda-callback'
  | 'callback-absent'
  | 'callback-target-unresolved'
  | 'callback-target-unprovable'
  | 'continuation-missing'
  | 'pending-record-uncompleted'
  | 'multiline-call';

export interface FlowContinuationInput {
  rootKey: string;
  files: string[];
  resolveFile: (filePath: string) => FlowCallResolverResult | null;
  /** 调用点行原文(宿主供给;单行契约面;line=解析层 callSite 行,0 基工作区口径) */
  lineTextAt: (filePath: string, line: number) => string;
  /** 跨文件模块函数解析:名 → 声明位置;null=不可证 */
  resolveModuleFunction: (name: string) => { filePath: string; line: number } | null;
  /** 类方法解析:类名+方法名 → 声明位置(宿主按类表);null=未定义 */
  resolveClassMethod: (
    className: string,
    methodName: string
  ) => { filePath: string; line: number } | null;
  /** FLOW-009 扫描结果(桥 pairsWith 连线输入) */
  bridgeScan?: FlowBridgeScanResult;
}

export interface FlowContinuationLink {
  kind: 'argument-callback' | 'timer-fixed' | 'bridge-roundtrip';
  apiName: string;
  /** 调用点所在帧/请求回调帧(文件图或桥扫描节点) */
  fromNodeId: string;
  /** 回调帧 */
  toNodeId: string;
  /** 契约关联边(async-callback,declaration-contract) */
  edge: FlowGraphEdge;
  trigger: string;
}

export interface FlowContinuationBreakpoint {
  code: FlowContinuationBreakpointCode;
  detail: string;
  trigger: string;
  callSite: FlowSourceLocation | null;
  /** 断点落图边(fromNode→unresolved 节点);bridge 族可为 null(记录面) */
  edge: FlowGraphEdge | null;
}

export interface FlowScriptResponseCheck {
  process: 'loginapp' | 'dbmgr' | 'interfaces' | 'logger';
  requestCallback: string;
  responseApi: string;
  /** 入口模块内发现 Response 调用(请求帧内)→契约完成;false=在途记录悬挂 */
  completed: boolean;
  detail: string;
}

export interface FlowContinuationResult {
  links: FlowContinuationLink[];
  breakpoints: FlowContinuationBreakpoint[];
  scriptResponses: FlowScriptResponseCheck[];
}

/** 调用点单行实参提取:apiName( 起平衡括号+顶层逗号切分;跨行→null */
export const callArgumentsOnLine = (lineText: string, apiName: string): string[] | null => {
  const start = lineText.indexOf(`${apiName}(`);
  if (start < 0) {
    return null;
  }
  let depth = 0;
  let inString: string | null = null;
  const args: string[] = [];
  let current = '';
  for (let i = start + apiName.length; i < lineText.length; i += 1) {
    const ch = lineText[i];
    if (inString) {
      if (ch === inString) {
        inString = null;
      }
      current += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      inString = ch;
      current += ch;
      continue;
    }
    if (ch === '(') {
      depth += 1;
      if (depth === 1) {
        continue;
      }
    }
    if (ch === ')') {
      depth -= 1;
      if (depth === 0) {
        if (current.trim().length > 0) {
          args.push(current.trim());
        }
        return args;
      }
    }
    if (ch === ',' && depth === 1) {
      args.push(current.trim());
      current = '';
      continue;
    }
    current += ch;
  }
  return null; // 括号未在本行闭合:跨行调用,不解析
};

const breakpointNodeLabel: Record<FlowContinuationBreakpointCode, string> = {
  'lambda-callback': '内联 lambda 回调',
  'callback-absent': '回调缺位',
  'callback-target-unresolved': '回调目标不可证',
  'callback-target-unprovable': '回调目标形态不可证',
  'continuation-missing': '契约续段未定义',
  'pending-record-uncompleted': '在途契约记录未完成',
  'multiline-call': '跨行调用不解析'
};

export function linkContinuations(input: FlowContinuationInput): FlowContinuationResult {
  const links: FlowContinuationLink[] = [];
  const breakpoints: FlowContinuationBreakpoint[] = [];
  const scriptResponses: FlowScriptResponseCheck[] = [];
  const frameNodeCache = new Map<string, string>();

  const frameNodeFor = (ref: {
    filePath: string;
    line: number;
    name: string;
    role: FlowGraphNode['role'];
    signature?: string;
  }): string => {
    const key = `${ref.role}\u001f${ref.filePath}\u001f${ref.name}\u001f${ref.line}`;
    const cached = frameNodeCache.get(key);
    if (cached) {
      return cached;
    }
    const node = flowGraphNode({
      rootKey: input.rootKey,
      role: ref.role,
      kind: 'function',
      fn: { name: ref.name, filePath: ref.filePath, signature: ref.signature ?? '' },
      declaration: { file: ref.filePath, line: ref.line, character: 0 },
      label: `候选帧 ${ref.name}`
    });
    frameNodeCache.set(key, node.id);
    return node.id;
  };

  const pushBreakpoint = (args: {
    code: FlowContinuationBreakpointCode;
    detail: string;
    trigger: string;
    callSite: FlowSourceLocation | null;
    fromNodeId: string | null;
    fromRole: FlowGraphNode['role'];
  }): void => {
    const target = flowGraphNode({
      rootKey: input.rootKey,
      role: args.fromRole,
      kind: 'unresolved',
      unresolvedCode: 'unknown-receiver',
      unresolvedDetail: args.detail,
      label: `未解析:${breakpointNodeLabel[args.code]}(${args.code})`
    });
    breakpoints.push({
      code: args.code,
      detail: args.detail,
      trigger: args.trigger,
      callSite: args.callSite,
      edge: args.fromNodeId
        ? flowGraphEdge({
            fromNodeId: args.fromNodeId,
            toNodeId: target.id,
            callSite: args.callSite,
            direction: { fromRole: args.fromRole, toRole: args.fromRole, kind: 'downstream-call' },
            syncAsync: 'unknown',
            messageKind: 'unresolved',
            evidence: {
              type: args.callSite ? 'syntax-anchor' : 'declaration-contract',
              detail: args.callSite
                ? `异步续段断点:${args.detail}`
                : `异步续段断点(声明面):${args.detail}`
            },
            unresolvedReason: { code: 'unknown-receiver', detail: args.detail }
          })
        : null
    });
  };

  for (const filePath of input.files) {
    const result = input.resolveFile(filePath);
    if (!result) {
      continue;
    }
    const nodesById = new Map(result.nodes.map(node => [node.id, node]));
    for (const edge of result.edges) {
      if (edge.callSite === null || edge.evidence.type !== 'syntax-anchor') {
        continue;
      }
      const caller = nodesById.get(edge.fromNodeId);
      const calleeRef = edge.evidence.detail;
      const callerRole = caller?.role ?? 'unknown';

      // ── 模块异步 API:KBEngine.<api>(...) ──
      if (calleeRef.startsWith('KBEngine.')) {
        const apiName = calleeRef.slice('KBEngine.'.length);
        if (SYNC_MODULE_APIS.includes(apiName)) {
          continue; // 同步面:不声称异步对
        }
        const contract = ASYNC_MODULE_APIS.find(api => api.apiName === apiName);
        if (!contract || contract.callbackIndex === null) {
          continue;
        }
        const lineText = input.lineTextAt(filePath, edge.callSite.line);
        const args = callArgumentsOnLine(lineText, apiName);
        if (args === null) {
          pushBreakpoint({
            code: 'multiline-call',
            detail: `${calleeRef} 调用跨行,实参面不解析(如实断点,不猜)`,
            trigger: contract.trigger,
            callSite: edge.callSite,
            fromNodeId: edge.fromNodeId,
            fromRole: callerRole
          });
          continue;
        }
        const callbackArg = args[contract.callbackIndex] ?? '';
        if (callbackArg === '' || callbackArg === 'None') {
          pushBreakpoint({
            code: 'callback-absent',
            detail: `${calleeRef} 回调缺位(${contract.callbackParams.join(', ')} 不会有人收到)`,
            trigger: contract.trigger,
            callSite: edge.callSite,
            fromNodeId: edge.fromNodeId,
            fromRole: callerRole
          });
          continue;
        }
        if (callbackArg.includes('lambda')) {
          pushBreakpoint({
            code: 'lambda-callback',
            detail: `${calleeRef} 回调是内联 lambda,无独立帧可连(断点保留)`,
            trigger: contract.trigger,
            callSite: edge.callSite,
            fromNodeId: edge.fromNodeId,
            fromRole: callerRole
          });
          continue;
        }
        const bare = /^([A-Za-z_][A-Za-z0-9_]*)$/.exec(callbackArg);
        let targetId: string | null = null;
        if (bare) {
          // 同文件模块函数节点优先(解析图已有帧)
          const localFn = result.nodes.find(
            node =>
              node.kind === 'function' &&
              node.fn?.name === bare[1] &&
              node.fn?.filePath === filePath
          );
          if (localFn) {
            targetId = localFn.id;
          } else {
            const resolved = input.resolveModuleFunction(bare[1]);
            if (resolved) {
              targetId = frameNodeFor({
                filePath: resolved.filePath,
                line: resolved.line,
                name: bare[1],
                role: 'unknown',
                signature: `def ${bare[1]}`
              });
            }
          }
        }
        if (!targetId) {
          pushBreakpoint({
            code: bare ? 'callback-target-unresolved' : 'callback-target-unprovable',
            detail: bare
              ? `${calleeRef} 回调目标 ${bare[1]} 不可证(非本文件函数/宿主解析缺位)`
              : `${calleeRef} 回调实参形态不可证:${callbackArg}`,
            trigger: contract.trigger,
            callSite: edge.callSite,
            fromNodeId: edge.fromNodeId,
            fromRole: callerRole
          });
          continue;
        }
        links.push({
          kind: 'argument-callback',
          apiName,
          fromNodeId: edge.fromNodeId,
          toNodeId: targetId,
          edge: flowGraphEdge({
            fromNodeId: edge.fromNodeId,
            toNodeId: targetId,
            callSite: edge.callSite,
            direction: { fromRole: callerRole, toRole: callerRole, kind: 'downstream-call' },
            syncAsync: 'async-callback',
            messageKind: 'engine-callback',
            evidence: {
              type: 'declaration-contract',
              detail: `${calleeRef} 回调(${contract.callbackParams.join(', ')})——${contract.trigger}`
            }
          }),
          trigger: contract.trigger
        });
        continue;
      }

      // ── 实体方法异步契约:self.<api>(...) ──
      if (calleeRef.startsWith('self.')) {
        const apiName = calleeRef.slice('self.'.length);
        const contract = ASYNC_ENTITY_APIS.find(api => api.apiName === apiName);
        if (!contract) {
          continue;
        }
        const className = caller?.entity?.name ?? null;
        if (contract.continuationMethod) {
          // 固定契约续段(addTimer→onTimer):不取实参,查类表
          if (!className) {
            pushBreakpoint({
              code: 'callback-target-unprovable',
              detail: `${calleeRef} 所在帧无类身份,onTimer 续段不可证`,
              trigger: contract.trigger,
              callSite: edge.callSite,
              fromNodeId: edge.fromNodeId,
              fromRole: callerRole
            });
            continue;
          }
          const onTimer = input.resolveClassMethod(className, contract.continuationMethod);
          if (!onTimer) {
            pushBreakpoint({
              code: 'continuation-missing',
              detail: `${className}.${calleeRef} 的契约续段 ${contract.continuationMethod} 未定义(timer 触发无人接)`,
              trigger: contract.trigger,
              callSite: edge.callSite,
              fromNodeId: edge.fromNodeId,
              fromRole: callerRole
            });
            continue;
          }
          const onTimerId = frameNodeFor({
            filePath: onTimer.filePath,
            line: onTimer.line,
            name: contract.continuationMethod,
            role: callerRole,
            signature: `def ${contract.continuationMethod}`
          });
          links.push({
            kind: 'timer-fixed',
            apiName,
            fromNodeId: edge.fromNodeId,
            toNodeId: onTimerId,
            edge: flowGraphEdge({
              fromNodeId: edge.fromNodeId,
              toNodeId: onTimerId,
              callSite: edge.callSite,
              direction: { fromRole: callerRole, toRole: callerRole, kind: 'downstream-call' },
              syncAsync: 'async-callback',
              messageKind: 'engine-callback',
              evidence: {
                type: 'declaration-contract',
                detail: `${className}.addTimer → ${contract.continuationMethod}(timerID, userArg)——${contract.trigger}`
              }
            }),
            trigger: contract.trigger
          });
          continue;
        }
        // 实参形态(writeToDB);固定续段形态已在上面 continue
        if (contract.callbackIndex === null) {
          continue;
        }
        if (!className) {
          pushBreakpoint({
            code: 'callback-target-unprovable',
            detail: `${calleeRef} 所在帧无类身份,回调绑定不可证`,
            trigger: contract.trigger,
            callSite: edge.callSite,
            fromNodeId: edge.fromNodeId,
            fromRole: callerRole
          });
          continue;
        }
        const lineText = input.lineTextAt(filePath, edge.callSite.line);
        const args = callArgumentsOnLine(lineText, apiName);
        if (args === null) {
          pushBreakpoint({
            code: 'multiline-call',
            detail: `${calleeRef} 调用跨行,实参面不解析(如实断点,不猜)`,
            trigger: contract.trigger,
            callSite: edge.callSite,
            fromNodeId: edge.fromNodeId,
            fromRole: callerRole
          });
          continue;
        }
        const callbackArg = args[contract.callbackIndex] ?? '';
        if (callbackArg === '' || callbackArg === 'None') {
          pushBreakpoint({
            code: 'callback-absent',
            detail: `${calleeRef} 回调缺位(${contract.callbackParams.join(', ')} 不会有人收到)`,
            trigger: contract.trigger,
            callSite: edge.callSite,
            fromNodeId: edge.fromNodeId,
            fromRole: callerRole
          });
          continue;
        }
        if (callbackArg.includes('lambda')) {
          pushBreakpoint({
            code: 'lambda-callback',
            detail: `${calleeRef} 回调是内联 lambda,无独立帧可连(断点保留)`,
            trigger: contract.trigger,
            callSite: edge.callSite,
            fromNodeId: edge.fromNodeId,
            fromRole: callerRole
          });
          continue;
        }
        const selfMethod = /^self\.([A-Za-z_][A-Za-z0-9_]*)$/.exec(callbackArg);
        if (selfMethod) {
          const method = input.resolveClassMethod(className, selfMethod[1]);
          if (!method) {
            pushBreakpoint({
              code: 'callback-target-unresolved',
              detail: `${calleeRef} 回调目标 ${className}.${selfMethod[1]} 未定义`,
              trigger: contract.trigger,
              callSite: edge.callSite,
              fromNodeId: edge.fromNodeId,
              fromRole: callerRole
            });
            continue;
          }
          const targetId = frameNodeFor({
            filePath: method.filePath,
            line: method.line,
            name: selfMethod[1],
            role: callerRole,
            signature: `def ${selfMethod[1]}`
          });
          links.push({
            kind: 'argument-callback',
            apiName,
            fromNodeId: edge.fromNodeId,
            toNodeId: targetId,
            edge: flowGraphEdge({
              fromNodeId: edge.fromNodeId,
              toNodeId: targetId,
              callSite: edge.callSite,
              direction: { fromRole: callerRole, toRole: callerRole, kind: 'downstream-call' },
              syncAsync: 'async-callback',
              messageKind: 'engine-callback',
              evidence: {
                type: 'declaration-contract',
                detail: `${className}.${calleeRef} 回调(${contract.callbackParams.join(', ')})——${contract.trigger}`
              }
            }),
            trigger: contract.trigger
          });
          continue;
        }
        pushBreakpoint({
          code: 'callback-target-unprovable',
          detail: `${calleeRef} 回调实参形态不可证:${callbackArg}`,
          trigger: contract.trigger,
          callSite: edge.callSite,
          fromNodeId: edge.fromNodeId,
          fromRole: callerRole
        });
      }
    }
  }

  // ── 桥 pairsWith 连线(FLOW-009 元数据 → FLOW-010 关联) ──
  if (input.bridgeScan) {
    const bindings = input.bridgeScan.bindings;
    for (const binding of bindings) {
      const pairs = binding.contract.pairsWith;
      if (!pairs) {
        continue;
      }
      if (pairs.kind === 'db-roundtrip') {
        const continuation = bindings.find(
          candidate =>
            candidate.process === binding.process &&
            candidate.callbackName === pairs.continuation
        );
        if (!continuation) {
          pushBreakpoint({
            code: 'continuation-missing',
            detail: `${binding.process}.${binding.callbackName} 的 db 回程回调 ${pairs.continuation} 未定义(pending 记录悬挂到进程退出)`,
            trigger: binding.contract.trigger,
            callSite: null,
            fromNodeId: binding.handlerNode.id,
            fromRole: binding.handlerNode.role
          });
          continue;
        }
        links.push({
          kind: 'bridge-roundtrip',
          apiName: binding.callbackName,
          fromNodeId: binding.handlerNode.id,
          toNodeId: continuation.handlerNode.id,
          edge: flowGraphEdge({
            fromNodeId: binding.handlerNode.id,
            toNodeId: continuation.handlerNode.id,
            callSite: null,
            direction: {
              fromRole: binding.handlerNode.role,
              toRole: continuation.handlerNode.role,
              kind: 'downstream-call'
            },
            syncAsync: 'async-callback',
            messageKind: 'engine-callback',
            evidence: {
              type: 'declaration-contract',
              detail: `${binding.process} 请求↔db 回程:${binding.callbackName} → ${pairs.continuation}——${binding.contract.trigger}`
            }
          }),
          trigger: binding.contract.trigger
        });
        continue;
      }
      // script-response:入口模块内是否发现 <Response> 调用(请求帧内)
      const handlerFilePath = binding.handlerNode.fn?.filePath ?? '';
      const fileResult = input.resolveFile(handlerFilePath);
      if (!fileResult) {
        pushBreakpoint({
          code: 'pending-record-uncompleted',
          detail: `${binding.process}.${binding.callbackName} 入口模块不可解析,KBEngine.${pairs.continuation} 完成面不可证`,
          trigger: binding.contract.trigger,
          callSite: null,
          fromNodeId: binding.handlerNode.id,
          fromRole: binding.handlerNode.role
        });
        continue;
      }
      const responseDetail = `KBEngine.${pairs.continuation}`;
      const found = fileResult.edges.find(
        edge =>
          edge.evidence.type === 'syntax-anchor' &&
          edge.evidence.detail === responseDetail &&
          nodesByFnName(fileResult, edge.fromNodeId) === binding.callbackName
      );
      scriptResponses.push({
        process: binding.process,
        requestCallback: binding.callbackName,
        responseApi: pairs.continuation,
        completed: Boolean(found),
        detail: found
          ? `${binding.process}.${binding.callbackName} 内发现 ${responseDetail} 调用(契约完成)`
          : `${binding.process}.${binding.callbackName} 未发现 ${responseDetail} 调用(pending 记录悬挂到进程退出;interfaces 单线程,阻塞 HTTP 禁忌)`
      });
    }
  }
  return { links, breakpoints, scriptResponses };
}

const nodesByFnName = (
  result: FlowCallResolverResult | null | undefined,
  nodeId: string
): string | null => result?.nodes.find(node => node.id === nodeId)?.fn?.name ?? null;
