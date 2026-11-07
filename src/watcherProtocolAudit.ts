/**
 * 核对一个目标版本的 watcher 协议号(IDE-LIV-002):逐条核对记录,把
 * 生产映射(src/kbengineProtocol.ts WATCHER_QUERY_MSG_IDS 与回包常量)
 * 钉到具体引擎版本源码——目标版本 kbengine@f85ad81(本机仓核对),
 * 请求号出自 kbe/res/server/messages_fixed_defaults.xml 的
 * <组件::queryWatcher> 段,回包号 65502 出自 kbe/src/lib/helper/
 * console_helper.h 的 CONSOLE_WATCHERCB_MSGID。verify 函数把审计表与
 * 生产映射逐条咬合:任何一侧漂移测试即红,不沿用未验证常量。
 */

import {
  COMPONENT_NAMES,
  CONSOLE_LOG_MSG_ID,
  LOGGER_APP_ACTIVE_TICK_MSG_ID,
  LOGGER_DEREGISTER_LOG_WATCHER_MSG_ID,
  LOGGER_REGISTER_LOG_WATCHER_MSG_ID
} from './kbengineProtocol';

/** 核对所用目标版本(引擎仓与文件,登记面 LIV-001 的 engineVersion 对齐) */
export const WATCHER_PROTOCOL_AUDIT_VERSION = {
  repoUrl: 'https://github.com/kbengine/kbengine',
  commit: 'f85ad81',
  xmlSource: 'kbe/res/server/messages_fixed_defaults.xml'
};

export interface WatcherMessageProtocolAuditEntry {
  /** COMPONENT_TYPE 枚举值(common.h) */
  componentType: number;
  componentName: string;
  requestMsgId: number;
  /** 引擎源码依据:文件 + xml 段名(段名带号,逐条可指) */
  requestSource: string;
}

/** 请求号逐条引据(f85ad81 核对所得) */
export const WATCHER_MESSAGE_PROTOCOL_AUDIT: WatcherMessageProtocolAuditEntry[] = [
  { componentType: 1, componentName: 'dbmgr', requestMsgId: 41006, requestSource: 'kbe/res/server/messages_fixed_defaults.xml <Dbmgr::queryWatcher><id>41006' },
  { componentType: 2, componentName: 'loginapp', requestMsgId: 41003, requestSource: 'kbe/res/server/messages_fixed_defaults.xml <Loginapp::queryWatcher><id>41003' },
  { componentType: 3, componentName: 'baseappmgr', requestMsgId: 41004, requestSource: 'kbe/res/server/messages_fixed_defaults.xml <Baseappmgr::queryWatcher><id>41004' },
  { componentType: 4, componentName: 'cellappmgr', requestMsgId: 41005, requestSource: 'kbe/res/server/messages_fixed_defaults.xml <Cellappmgr::queryWatcher><id>41005' },
  { componentType: 5, componentName: 'cellapp', requestMsgId: 41002, requestSource: 'kbe/res/server/messages_fixed_defaults.xml <Cellapp::queryWatcher><id>41002' },
  { componentType: 6, componentName: 'baseapp', requestMsgId: 41001, requestSource: 'kbe/res/server/messages_fixed_defaults.xml <Baseapp::queryWatcher><id>41001' },
  { componentType: 10, componentName: 'logger', requestMsgId: 41008, requestSource: 'kbe/res/server/messages_fixed_defaults.xml <Logger::queryWatcher><id>41008' },
  { componentType: 13, componentName: 'interfaces', requestMsgId: 41007, requestSource: 'kbe/res/server/messages_fixed_defaults.xml <Interfaces::queryWatcher><id>41007' }
];

/** 回包号引据:watcher 数据回包走 console 通道 */
export const WATCHER_CB_PROTOCOL_AUDIT = {
  msgId: 65502,
  source: 'kbe/src/lib/helper/console_helper.h:11 CONSOLE_WATCHERCB_MSGID = 65502'
};

export interface WatcherProtocolVerifyVerdict {
  ok: boolean;
  mismatches: string[];
}

/** 生产映射 ↔ 审计表逐条咬合:缺键/多键/错号都点名 */
export function verifyWatcherProtocolAgainstAudit(
  actual: Record<number, number>
): WatcherProtocolVerifyVerdict {
  const mismatches: string[] = [];
  for (const entry of WATCHER_MESSAGE_PROTOCOL_AUDIT) {
    const actualId = actual[entry.componentType];
    if (actualId === undefined) {
      mismatches.push(`缺 ${entry.componentName}(${entry.componentType}) 的请求号(审计:${entry.requestMsgId})`);
    } else if (actualId !== entry.requestMsgId) {
      mismatches.push(
        `${entry.componentName}(${entry.componentType}) 请求号不符:生产 ${actualId} vs 审计 ${entry.requestMsgId}(${entry.requestSource})`
      );
    }
  }
  for (const componentType of Object.keys(actual).map(Number)) {
    if (!WATCHER_MESSAGE_PROTOCOL_AUDIT.some(entry => entry.componentType === componentType)) {
      mismatches.push(`多出未审计的组件类型 ${componentType}(${COMPONENT_NAMES[componentType] ?? '?'}) 请求号 ${actual[componentType]}`);
    }
  }
  return { ok: mismatches.length === 0, mismatches };
}

// ---------------------------------------------------------------------------
// guiconsole console 链路(KB-GC-001)审计锁:日志 tail 面的请求/回执号逐条
// 引据,生产常量(src/kbengineProtocol.ts LOGGER_* / CONSOLE_LOG_MSG_ID)与
// 本表逐条咬合,漂移即红(IDE-LIV-002 同一机制)。
export const CONSOLE_PROTOCOL_AUDIT_VERSION = {
  repoUrl: 'https://github.com/kbengine/kbengine',
  commit: '3082ab5',
  xmlSource: 'kbe/res/server/messages_fixed_defaults.xml'
};

export interface ConsoleRequestAuditEntry {
  name: string;
  requestMsgId: number;
  requestSource: string;
}

export const CONSOLE_PROTOCOL_AUDIT: {
  appActiveTick: ConsoleRequestAuditEntry;
  registerLogWatcher: ConsoleRequestAuditEntry;
  deregisterLogWatcher: ConsoleRequestAuditEntry;
  consoleLog: { msgId: number; source: string };
} = {
  appActiveTick: {
    name: 'onAppActiveTick',
    requestMsgId: 701,
    requestSource: 'kbe/res/server/messages_fixed_defaults.xml <Logger::onAppActiveTick><id>701'
  },
  registerLogWatcher: {
    name: 'registerLogWatcher',
    requestMsgId: 702,
    requestSource: 'kbe/res/server/messages_fixed_defaults.xml <Logger::registerLogWatcher><id>702'
  },
  deregisterLogWatcher: {
    name: 'deregisterLogWatcher',
    requestMsgId: 703,
    requestSource: 'kbe/res/server/messages_fixed_defaults.xml <Logger::deregisterLogWatcher><id>703'
  },
  consoleLog: {
    msgId: 65501,
    source: 'kbe/src/lib/helper/console_helper.h:10 CONSOLE_LOG_MSGID = 65501'
  }
};

/** console 链生产常量 ↔ 审计表咬合;actual 缺省=当前生产常量(测试传伪造表测漂移) */
export function verifyConsoleProtocolAgainstAudit(
  actual: {
    appActiveTick: number;
    registerLogWatcher: number;
    deregisterLogWatcher: number;
    consoleLog: number;
  } = {
    appActiveTick: LOGGER_APP_ACTIVE_TICK_MSG_ID,
    registerLogWatcher: LOGGER_REGISTER_LOG_WATCHER_MSG_ID,
    deregisterLogWatcher: LOGGER_DEREGISTER_LOG_WATCHER_MSG_ID,
    consoleLog: CONSOLE_LOG_MSG_ID
  }
): WatcherProtocolVerifyVerdict {
  const mismatches: string[] = [];
  const requestPairs: Array<[ConsoleRequestAuditEntry, number]> = [
    [CONSOLE_PROTOCOL_AUDIT.appActiveTick, actual.appActiveTick],
    [CONSOLE_PROTOCOL_AUDIT.registerLogWatcher, actual.registerLogWatcher],
    [CONSOLE_PROTOCOL_AUDIT.deregisterLogWatcher, actual.deregisterLogWatcher]
  ];
  for (const [entry, actualId] of requestPairs) {
    if (actualId !== entry.requestMsgId) {
      mismatches.push(
        `${entry.name} 请求号不符:生产 ${actualId} vs 审计 ${entry.requestMsgId}(${entry.requestSource})`
      );
    }
  }
  if (actual.consoleLog !== CONSOLE_PROTOCOL_AUDIT.consoleLog.msgId) {
    mismatches.push(
      `consoleLog 回执号不符:生产 ${actual.consoleLog} vs 审计 ${CONSOLE_PROTOCOL_AUDIT.consoleLog.msgId}(${CONSOLE_PROTOCOL_AUDIT.consoleLog.source})`
    );
  }
  return { ok: mismatches.length === 0, mismatches };
}
